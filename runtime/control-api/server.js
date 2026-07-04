import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraph, evaluateAccess, validateGraph } from "../../packages/compiler/index.js";
import { createFileControlStore } from "./stores/file-store.js";
import { createPostgresControlStore } from "./stores/postgres-store.js";

const DEFAULT_PORT = 8790;
const ACCESS_LEVELS = ["public", "private", "protected", "secret"];
const DEFAULT_SESSION_SECRET = "baseplane-local-session-secret";

export function createControlApiServer(options = {}) {
  const config = controlConfig(options);
  const store = options.store || createControlStore(config);

  return http.createServer(async (request, response) => {
    setCors(response, config);
    if (request.method === "OPTIONS") return sendJson(response, 204, {});

    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (request.method === "GET" && url.pathname === "/health") {
        const health = await store.health();
        return sendJson(response, 200, { ok: true, service: "baseplane-control-api", ...health });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/sign-in") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email || "owner@baseplane.local");
        const user = await store.upsertUser(email);
        const token = crypto.randomBytes(24).toString("hex");
        const session = await store.createSession(user.id, sessionHash(token, config.sessionSecret));
        return sendJson(response, 200, {
          user,
          account: await store.account(),
          session: publicSession(session, token)
        });
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const session = await requireSession(store, request, config);
        const body = await readJson(request);
        const project = await store.createProject({
          id: id("project"),
          account_id: (await store.account()).id,
          name: stringOr(body.name, "Untitled Backend"),
          created_by: session.user.id,
          created_at: now()
        });
        await store.addProjectMember({
          id: id("member"),
          project_id: project.id,
          user_id: session.user.id,
          role: "owner",
          created_at: now()
        });
        return sendJson(response, 201, { project });
      }

      if (segments[0] === "api" && segments[1] === "projects" && segments[2]) {
        const projectId = segments[2];
        const project = await store.findProject(projectId);
        if (!project) return sendJson(response, 404, { error: "project_not_found" });

        if (request.method === "GET" && segments.length === 3) {
          await requireSession(store, request, config);
          return sendJson(response, 200, {
            project,
            latest_graph_version: await store.latestGraphVersion(projectId),
            backend_instance: await store.latestBackendInstance(projectId),
            deploy_request: await store.latestDeployRequest(projectId)
          });
        }

        if (request.method === "POST" && segments[3] === "graph_versions") {
          const session = await requireSession(store, request, config);
          const body = await readJson(request);
          const validation = validateGraph(body.graph);
          if (!validation.valid) return sendJson(response, 400, { error: "invalid_graph", validation });
          const version = await store.createGraphVersion({
            id: id("graph"),
            project_id: projectId,
            baseplane_json: body.graph,
            created_by: session.user.id,
            created_at: now()
          });
          return sendJson(response, 201, { graph_version: version });
        }

        if (request.method === "POST" && segments[3] === "deploy") {
          const session = await requireSession(store, request, config);
          const body = await readJson(request);
          const graphVersion = body.graph_version_id
            ? await store.getGraphVersion(projectId, body.graph_version_id)
            : await store.latestGraphVersion(projectId);
          if (!graphVersion) return sendJson(response, 400, { error: "graph_version_required" });

          let requestRecord = await store.createDeployRequest({
            id: id("deploy"),
            project_id: projectId,
            graph_version_id: graphVersion.id,
            status: "validating",
            logs: [{ at: now(), message: "validating graph" }],
            created_by: session.user.id,
            created_at: now(),
            updated_at: now()
          });

          try {
            compileGraph(graphVersion.baseplane_json);
            requestRecord.status = "creating_database";
            requestRecord.logs.push({ at: now(), message: "creating isolated project schema" });
            requestRecord.updated_at = now();
            requestRecord = await store.updateDeployRequest(requestRecord);

            const backend = await materializeBackend(store, projectId, graphVersion, config);
            requestRecord.status = "live";
            requestRecord.backend_instance_id = backend.id;
            requestRecord.logs.push({ at: now(), message: "applying graph tables" });
            requestRecord.logs.push({ at: now(), message: "running access checks" });
            requestRecord.logs.push({ at: now(), message: "backend live" });
            requestRecord.updated_at = now();
            requestRecord = await store.updateDeployRequest(requestRecord);
            await audit(store, {
              project_id: projectId,
              actor_type: "human",
              actor_id: session.user.id,
              action: "deploy",
              resource: `project:${projectId}`,
              field: "",
              decision: "ALLOW",
              reason: "owner deployed graph"
            });
            return sendJson(response, 201, { deploy_request: requestRecord, backend_instance: backend });
          } catch (error) {
            requestRecord.status = "failed";
            requestRecord.logs.push({ at: now(), message: error.message });
            requestRecord.updated_at = now();
            requestRecord = await store.updateDeployRequest(requestRecord);
            return sendJson(response, 400, { error: "deploy_failed", deploy_request: requestRecord });
          }
        }

        if (request.method === "GET" && segments[3] === "deploy_status") {
          await requireSession(store, request, config);
          return sendJson(response, 200, {
            deploy_request: await store.latestDeployRequest(projectId),
            backend_instance: await store.latestBackendInstance(projectId)
          });
        }

        if (request.method === "GET" && segments[3] === "audit_events") {
          await requireSession(store, request, config);
          return sendJson(response, 200, { audit_events: await store.listAuditEvents(projectId, 200) });
        }

        if (request.method === "POST" && segments[3] === "evaluate_access") {
          await requireSession(store, request, config);
          const body = await readJson(request);
          const graph = await graphForProject(store, projectId);
          const table = tableByIdOrName(graph, body.resource_id);
          const field = table?.fields?.find((item) => item.name === body.field);
          const actor = body.actor || body.principal_id || "owner";
          const decision = decideFieldAccess(graph, actor, table, field, body.action || "read");
          await audit(store, {
            project_id: projectId,
            actor_type: actorType(actor),
            actor_id: actor,
            action: body.action || "read",
            resource: body.resource_id || "",
            field: body.field || "",
            decision: decision.allowed ? "ALLOW" : "DENY",
            reason: decision.reason
          });
          return sendJson(response, 200, { decision });
        }

        if (segments[3] === "tables" && segments[4] && segments[5] === "rows") {
          const tableName = segments[4];
          const actor = url.searchParams.get("actor") || "owner";
          const graph = await graphForProject(store, projectId);
          const table = tableByIdOrName(graph, tableName);
          if (!table) return sendJson(response, 404, { error: "table_not_found" });
          await ensureBackendLive(store, projectId);

          if (request.method === "GET" && segments.length === 6) {
            const rows = await store.getRows(projectId, table.id);
            const redacted = [];
            for (const row of rows) {
              redacted.push(await redactRowForActor(store, projectId, graph, table, row, actor));
            }
            return sendJson(response, 200, { mode: "live", actor, table: table.id, rows: redacted });
          }

          if (request.method === "POST" && segments.length === 6) {
            await requireSession(store, request, config);
            const body = await readJson(request);
            const writeActor = body.actor || actor;
            const write = decideTableWrite(graph, writeActor, table);
            await audit(store, {
              project_id: projectId,
              actor_type: actorType(writeActor),
              actor_id: writeActor,
              action: "write",
              resource: table.id,
              field: "",
              decision: write.allowed ? "ALLOW" : "DENY",
              reason: write.reason
            });
            if (!write.allowed) return sendJson(response, 403, { error: "write_denied", reason: write.reason });
            const row = { ...(body.row || {}) };
            if (!row.id) row.id = id("row");
            row.__id = row.__id || String(row.id);
            await store.insertRow(projectId, table.id, row);
            return sendJson(response, 201, { row: await redactRowForActor(store, projectId, graph, table, row, writeActor) });
          }

          if (request.method === "PATCH" && segments[6]) {
            await requireSession(store, request, config);
            const body = await readJson(request);
            const writeActor = body.actor || actor;
            const write = decideTableWrite(graph, writeActor, table);
            await audit(store, {
              project_id: projectId,
              actor_type: actorType(writeActor),
              actor_id: writeActor,
              action: "update",
              resource: table.id,
              field: "",
              decision: write.allowed ? "ALLOW" : "DENY",
              reason: write.reason
            });
            if (!write.allowed) return sendJson(response, 403, { error: "update_denied", reason: write.reason });
            const row = await store.updateRow(projectId, table.id, segments[6], body.patch || {});
            if (!row) return sendJson(response, 404, { error: "row_not_found" });
            return sendJson(response, 200, { row: await redactRowForActor(store, projectId, graph, table, row, writeActor) });
          }
        }
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      const status = error.status || 500;
      return sendJson(response, status, { error: error.code || "server_error", message: error.message });
    }
  });
}

function controlConfig(options = {}) {
  const port = Number(options.port || process.env.BASEPLANE_CONTROL_PORT || DEFAULT_PORT);
  const publicApiUrl = options.publicApiUrl || process.env.BASEPLANE_PUBLIC_API_URL || `http://127.0.0.1:${port}`;
  return {
    port,
    publicApiUrl,
    databaseUrl: options.databaseUrl || process.env.CONTROL_DATABASE_URL || "",
    dataFile: options.dataFile || process.env.BASEPLANE_CONTROL_DATA || path.join(os.homedir(), ".baseplane", "control-api.json"),
    sessionSecret: options.sessionSecret || process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET,
    corsOrigin: options.corsOrigin || process.env.CORS_ORIGIN || "*",
    postgresSsl: options.postgresSsl ?? postgresSslFromEnv()
  };
}

function createControlStore(config) {
  if (config.databaseUrl) {
    return createPostgresControlStore({
      databaseUrl: config.databaseUrl,
      ssl: config.postgresSsl,
      id
    });
  }
  return createFileControlStore({
    dataFile: config.dataFile,
    id
  });
}

function postgresSslFromEnv() {
  if (!process.env.CONTROL_DATABASE_SSL) return undefined;
  if (process.env.CONTROL_DATABASE_SSL === "false") return false;
  return { rejectUnauthorized: process.env.CONTROL_DATABASE_SSL !== "allow-unauthorized" };
}

async function requireSession(store, request, config) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const found = await store.findSession(sessionHash(token, config.sessionSecret), token);
  if (!found) {
    const error = new Error("session required");
    error.status = 401;
    error.code = "unauthorized";
    throw error;
  }
  return found;
}

function publicSession(session, token) {
  return {
    id: session.id,
    user_id: session.user_id,
    token,
    created_at: session.created_at
  };
}

async function graphForProject(store, projectId) {
  const graphVersion = await store.latestGraphVersion(projectId);
  if (!graphVersion) {
    const error = new Error("project has no graph version");
    error.status = 409;
    error.code = "graph_not_deployed";
    throw error;
  }
  return graphVersion.baseplane_json;
}

async function materializeBackend(store, projectId, graphVersion, config) {
  const schema = `project_${projectId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const backend = await store.createBackendInstance({
    id: id("backend"),
    project_id: projectId,
    graph_version_id: graphVersion.id,
    provider: store.kind === "postgres" ? "baseplane-postgres" : "baseplane-local-file",
    schema,
    status: "live",
    api_url: `${config.publicApiUrl}/api/projects/${projectId}`,
    created_at: now()
  });
  const tables = tableNodes(graphVersion.baseplane_json);
  await store.ensureRowsForTables(projectId, tables);
  await store.addFieldAccessLevels(tables.flatMap((table) => normalizedFields(table).map((field) => ({
    id: id("field_access"),
    project_id: projectId,
    table_id: table.id,
    field: field.name,
    access: fieldAccess(field, table),
    graph_version_id: graphVersion.id,
    created_at: now()
  }))));
  return backend;
}

async function ensureBackendLive(store, projectId) {
  const backend = await store.latestBackendInstance(projectId);
  if (!backend || backend.status !== "live") {
    const error = new Error("backend is not deployed");
    error.status = 409;
    error.code = "backend_not_live";
    throw error;
  }
}

async function redactRowForActor(store, projectId, graph, table, row, actor) {
  const out = {};
  for (const field of normalizedFields(table)) {
    const decision = decideFieldAccess(graph, actor, table, field, "read");
    out[field.name] = decision.allowed ? row[field.name] ?? "" : `[${decision.access}]`;
    await audit(store, {
      project_id: projectId,
      actor_type: actorType(actor),
      actor_id: actor,
      action: "read",
      resource: table.id,
      field: field.name,
      decision: decision.allowed ? "ALLOW" : "DENY",
      reason: decision.reason
    });
  }
  out.__id = row.__id || String(row.id || "");
  return out;
}

function decideFieldAccess(graph, actor, table, field, action = "read") {
  if (!table || !field) return { allowed: false, access: "unknown", reason: "missing table or field" };
  const access = fieldAccess(field, table);
  if (actor === "owner") return { allowed: true, access, reason: "owner can read all fields" };
  if (access === "secret") return { allowed: false, access, reason: "secret fields are denied unless owner" };
  if (access === "protected") return { allowed: false, access, reason: "protected fields are denied unless owner" };
  if (actor === "coding_agent") return { allowed: false, access, reason: "coding_agent can inspect schema but cannot read row values" };
  if (actor === "researcher") return { allowed: access === "public" || access === "private", access, reason: "researcher can read public/private project fields" };
  if (actor === "support_agent") {
    const operational = ["status", "updated_at", "last_seen_at", "created_at"].includes(field.name);
    return { allowed: access === "public" || operational, access, reason: operational ? "support can read operational fields" : "support cannot read private row values" };
  }
  if (actor === "analysis_agent") {
    const result = evaluateAccess(graph, { principal_id: actor, action, resource_id: table.id, field: field.name });
    return { allowed: result.decision === "ALLOW" && access === "public", access, reason: result.reason.join(" ") || "analysis_agent requires explicit field allow" };
  }
  const result = evaluateAccess(graph, { principal_id: actor, action, resource_id: table.id, field: field.name });
  return { allowed: result.decision === "ALLOW" && access !== "secret" && access !== "protected", access, reason: result.reason.join(" ") || "graph policy decision" };
}

function decideTableWrite(graph, actor, table) {
  if (actor === "owner") return { allowed: true, reason: "owner can write rows" };
  const result = evaluateAccess(graph, { principal_id: actor, action: "write", resource_id: table.id });
  return { allowed: result.decision === "ALLOW", reason: result.reason.join(" ") || "write requires graph policy" };
}

function tableNodes(graph) {
  return (graph.nodes || []).filter((item) => item.type === "table" || item.type === "secret");
}

function tableByIdOrName(graph, value) {
  return tableNodes(graph).find((item) => item.id === value || item.name === value);
}

function normalizedFields(table) {
  const fields = table?.fields?.length ? table.fields : [{ name: "id", type: "uuid", access: "public" }];
  return fields.map((field) => ({ ...field, access: fieldAccess(field, table) }));
}

function fieldAccess(field, table = null) {
  if (ACCESS_LEVELS.includes(field?.access)) return field.access;
  const name = String(field?.name || "").toLowerCase();
  const type = String(field?.type || "").toLowerCase();
  if (field?.secret) return "secret";
  if (table?.type === "secret" || /secret|token|hash|password|key/.test(name) || /secret|token/.test(type)) return "secret";
  if (/note|raw|payload|billing|private/.test(name)) return "protected";
  if (field?.private) return "private";
  if (/email|project_id|organization_id|account_id|user_id|device_id/.test(name)) return "private";
  return "public";
}

async function audit(store, event) {
  return store.addAuditEvent({
    id: id("audit"),
    timestamp: now(),
    ...event
  });
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function setCors(response, config) {
  response.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
  response.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(status === 204 ? "" : `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function stringOr(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function actorType(actor) {
  if (String(actor).endsWith("_agent")) return "agent";
  if (actor === "device") return "device";
  if (actor === "service") return "service";
  return "human";
}

function sessionHash(token, secret) {
  return crypto.createHash("sha256").update(`${secret}:${token}`).digest("hex");
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function now() {
  return new Date().toISOString();
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  const config = controlConfig();
  const server = createControlApiServer(config);
  server.listen(config.port, () => {
    console.log(`Baseplane Control API listening on http://127.0.0.1:${config.port}`);
    console.log(`Storage: ${config.databaseUrl ? "postgres" : config.dataFile}`);
    console.log(`Public API URL: ${config.publicApiUrl}`);
  });
}
