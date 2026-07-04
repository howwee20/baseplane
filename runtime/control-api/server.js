import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraph, evaluateAccess, validateGraph } from "../../packages/compiler/index.js";

const DEFAULT_PORT = 8790;
const ACCESS_LEVELS = ["public", "private", "protected", "secret"];

export function createControlApiServer(options = {}) {
  const store = createStore(options.dataFile || path.join(process.cwd(), ".baseplane-control", "data.json"));

  return http.createServer(async (request, response) => {
    setCors(response);
    if (request.method === "OPTIONS") return sendJson(response, 204, {});

    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
      const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

      if (request.method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: "baseplane-control-api", mode: "local-alpha" });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/sign-in") {
        const body = await readJson(request);
        const email = normalizeEmail(body.email || "owner@baseplane.local");
        const user = upsertUser(store, email);
        const session = {
          id: id("session"),
          user_id: user.id,
          token: crypto.randomBytes(24).toString("hex"),
          created_at: now()
        };
        store.data.sessions.push(session);
        store.save();
        return sendJson(response, 200, { user, account: store.data.accounts[0], session });
      }

      if (request.method === "POST" && url.pathname === "/api/projects") {
        const session = requireSession(store, request);
        const body = await readJson(request);
        const project = {
          id: id("project"),
          account_id: store.data.accounts[0].id,
          name: stringOr(body.name, "Untitled Backend"),
          created_by: session.user.id,
          created_at: now()
        };
        store.data.projects.push(project);
        store.data.project_members.push({
          id: id("member"),
          project_id: project.id,
          user_id: session.user.id,
          role: "owner",
          created_at: now()
        });
        store.save();
        return sendJson(response, 201, { project });
      }

      if (segments[0] === "api" && segments[1] === "projects" && segments[2]) {
        const projectId = segments[2];
        const project = findProject(store, projectId);
        if (!project) return sendJson(response, 404, { error: "project_not_found" });

        if (request.method === "GET" && segments.length === 3) {
          requireSession(store, request);
          return sendJson(response, 200, {
            project,
            latest_graph_version: latestGraphVersion(store, projectId),
            backend_instance: latestBackendInstance(store, projectId),
            deploy_request: latestDeployRequest(store, projectId)
          });
        }

        if (request.method === "POST" && segments[3] === "graph_versions") {
          const session = requireSession(store, request);
          const body = await readJson(request);
          const validation = validateGraph(body.graph);
          if (!validation.valid) return sendJson(response, 400, { error: "invalid_graph", validation });
          const version = {
            id: id("graph"),
            project_id: projectId,
            baseplane_json: body.graph,
            created_by: session.user.id,
            created_at: now()
          };
          store.data.graph_versions.push(version);
          store.save();
          return sendJson(response, 201, { graph_version: version });
        }

        if (request.method === "POST" && segments[3] === "deploy") {
          const session = requireSession(store, request);
          const body = await readJson(request);
          const graphVersion = body.graph_version_id
            ? store.data.graph_versions.find((item) => item.id === body.graph_version_id && item.project_id === projectId)
            : latestGraphVersion(store, projectId);
          if (!graphVersion) return sendJson(response, 400, { error: "graph_version_required" });

          const requestRecord = {
            id: id("deploy"),
            project_id: projectId,
            graph_version_id: graphVersion.id,
            status: "validating",
            logs: [{ at: now(), message: "validating graph" }],
            created_by: session.user.id,
            created_at: now(),
            updated_at: now()
          };
          store.data.deploy_requests.push(requestRecord);

          try {
            compileGraph(graphVersion.baseplane_json);
            requestRecord.status = "creating_database";
            requestRecord.logs.push({ at: now(), message: "creating isolated project schema" });
            const backend = materializeBackend(store, projectId, graphVersion);
            requestRecord.status = "live";
            requestRecord.backend_instance_id = backend.id;
            requestRecord.logs.push({ at: now(), message: "applying graph tables" });
            requestRecord.logs.push({ at: now(), message: "running access checks" });
            requestRecord.logs.push({ at: now(), message: "backend live" });
            requestRecord.updated_at = now();
            audit(store, {
              project_id: projectId,
              actor_type: "human",
              actor_id: session.user.id,
              action: "deploy",
              resource: `project:${projectId}`,
              field: "",
              decision: "ALLOW",
              reason: "owner deployed graph"
            });
            store.save();
            return sendJson(response, 201, { deploy_request: requestRecord, backend_instance: backend });
          } catch (error) {
            requestRecord.status = "failed";
            requestRecord.logs.push({ at: now(), message: error.message });
            requestRecord.updated_at = now();
            store.save();
            return sendJson(response, 400, { error: "deploy_failed", deploy_request: requestRecord });
          }
        }

        if (request.method === "GET" && segments[3] === "deploy_status") {
          requireSession(store, request);
          return sendJson(response, 200, {
            deploy_request: latestDeployRequest(store, projectId),
            backend_instance: latestBackendInstance(store, projectId)
          });
        }

        if (request.method === "GET" && segments[3] === "audit_events") {
          requireSession(store, request);
          const events = store.data.audit_events
            .filter((item) => item.project_id === projectId)
            .slice(-200)
            .reverse();
          return sendJson(response, 200, { audit_events: events });
        }

        if (request.method === "POST" && segments[3] === "evaluate_access") {
          requireSession(store, request);
          const body = await readJson(request);
          const graph = graphForProject(store, projectId);
          const table = tableByIdOrName(graph, body.resource_id);
          const field = table?.fields?.find((item) => item.name === body.field);
          const decision = decideFieldAccess(graph, body.actor || body.principal_id || "owner", table, field, body.action || "read");
          audit(store, {
            project_id: projectId,
            actor_type: actorType(body.actor || body.principal_id || "owner"),
            actor_id: body.actor || body.principal_id || "owner",
            action: body.action || "read",
            resource: body.resource_id || "",
            field: body.field || "",
            decision: decision.allowed ? "ALLOW" : "DENY",
            reason: decision.reason
          });
          store.save();
          return sendJson(response, 200, { decision });
        }

        if (segments[3] === "tables" && segments[4] && segments[5] === "rows") {
          const tableName = segments[4];
          const actor = url.searchParams.get("actor") || "owner";
          const graph = graphForProject(store, projectId);
          const table = tableByIdOrName(graph, tableName);
          if (!table) return sendJson(response, 404, { error: "table_not_found" });
          ensureBackendLive(store, projectId);

          if (request.method === "GET" && segments.length === 6) {
            const rows = rowsForTable(store, projectId, table.id);
            const redacted = rows.map((row) => redactRowForActor(store, projectId, graph, table, row, actor));
            store.save();
            return sendJson(response, 200, { mode: "live", actor, table: table.id, rows: redacted });
          }

          if (request.method === "POST" && segments.length === 6) {
            requireSession(store, request);
            const body = await readJson(request);
            const write = decideTableWrite(graph, body.actor || actor, table);
            audit(store, {
              project_id: projectId,
              actor_type: actorType(body.actor || actor),
              actor_id: body.actor || actor,
              action: "write",
              resource: table.id,
              field: "",
              decision: write.allowed ? "ALLOW" : "DENY",
              reason: write.reason
            });
            if (!write.allowed) {
              store.save();
              return sendJson(response, 403, { error: "write_denied", reason: write.reason });
            }
            const rows = rowsForTable(store, projectId, table.id);
            const row = { ...(body.row || {}) };
            if (!row.id) row.id = id("row");
            row.__id = row.__id || String(row.id);
            rows.push(row);
            store.save();
            return sendJson(response, 201, { row: redactRowForActor(store, projectId, graph, table, row, body.actor || actor) });
          }

          if (request.method === "PATCH" && segments[6]) {
            requireSession(store, request);
            const body = await readJson(request);
            const write = decideTableWrite(graph, body.actor || actor, table);
            audit(store, {
              project_id: projectId,
              actor_type: actorType(body.actor || actor),
              actor_id: body.actor || actor,
              action: "update",
              resource: table.id,
              field: "",
              decision: write.allowed ? "ALLOW" : "DENY",
              reason: write.reason
            });
            if (!write.allowed) {
              store.save();
              return sendJson(response, 403, { error: "update_denied", reason: write.reason });
            }
            const rows = rowsForTable(store, projectId, table.id);
            const row = rows.find((item) => String(item.__id || item.id) === segments[6]);
            if (!row) return sendJson(response, 404, { error: "row_not_found" });
            Object.assign(row, body.patch || {});
            store.save();
            return sendJson(response, 200, { row: redactRowForActor(store, projectId, graph, table, row, body.actor || actor) });
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

function createStore(dataFile) {
  const empty = {
    accounts: [{ id: "account_local", name: "Local Baseplane Alpha", created_at: now() }],
    users: [],
    sessions: [],
    projects: [],
    project_members: [],
    graph_versions: [],
    deploy_requests: [],
    backend_instances: [],
    access_rules: [],
    field_access_levels: [],
    audit_events: [],
    rows: {}
  };
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  let data = empty;
  if (fs.existsSync(dataFile)) {
    data = { ...empty, ...JSON.parse(fs.readFileSync(dataFile, "utf8")) };
  }
  return {
    data,
    dataFile,
    save() {
      fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);
    }
  };
}

function upsertUser(store, email) {
  let user = store.data.users.find((item) => item.email === email);
  if (!user) {
    user = { id: id("user"), account_id: store.data.accounts[0].id, email, created_at: now() };
    store.data.users.push(user);
  }
  return user;
}

function requireSession(store, request) {
  const header = request.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const session = store.data.sessions.find((item) => item.token === token);
  if (!session) {
    const error = new Error("session required");
    error.status = 401;
    error.code = "unauthorized";
    throw error;
  }
  const user = store.data.users.find((item) => item.id === session.user_id);
  return { session, user };
}

function findProject(store, projectId) {
  return store.data.projects.find((item) => item.id === projectId);
}

function latestGraphVersion(store, projectId) {
  return store.data.graph_versions.filter((item) => item.project_id === projectId).at(-1) || null;
}

function latestDeployRequest(store, projectId) {
  return store.data.deploy_requests.filter((item) => item.project_id === projectId).at(-1) || null;
}

function latestBackendInstance(store, projectId) {
  return store.data.backend_instances.filter((item) => item.project_id === projectId).at(-1) || null;
}

function graphForProject(store, projectId) {
  const graphVersion = latestGraphVersion(store, projectId);
  if (!graphVersion) {
    const error = new Error("project has no graph version");
    error.status = 409;
    error.code = "graph_not_deployed";
    throw error;
  }
  return graphVersion.baseplane_json;
}

function materializeBackend(store, projectId, graphVersion) {
  const schema = `project_${projectId.replace(/[^a-zA-Z0-9]/g, "_")}`;
  const backend = {
    id: id("backend"),
    project_id: projectId,
    graph_version_id: graphVersion.id,
    provider: "baseplane-local",
    schema,
    status: "live",
    api_url: `http://127.0.0.1:${process.env.BASEPLANE_CONTROL_PORT || DEFAULT_PORT}/api/projects/${projectId}`,
    created_at: now()
  };
  store.data.backend_instances.push(backend);
  store.data.rows[projectId] = store.data.rows[projectId] || {};
  for (const table of tableNodes(graphVersion.baseplane_json)) {
    store.data.rows[projectId][table.id] = store.data.rows[projectId][table.id] || [];
    for (const field of normalizedFields(table)) {
      store.data.field_access_levels.push({
        id: id("field_access"),
        project_id: projectId,
        table_id: table.id,
        field: field.name,
        access: fieldAccess(field, table),
        graph_version_id: graphVersion.id,
        created_at: now()
      });
    }
  }
  return backend;
}

function ensureBackendLive(store, projectId) {
  const backend = latestBackendInstance(store, projectId);
  if (!backend || backend.status !== "live") {
    const error = new Error("backend is not deployed");
    error.status = 409;
    error.code = "backend_not_live";
    throw error;
  }
}

function rowsForTable(store, projectId, tableId) {
  store.data.rows[projectId] = store.data.rows[projectId] || {};
  store.data.rows[projectId][tableId] = store.data.rows[projectId][tableId] || [];
  return store.data.rows[projectId][tableId];
}

function redactRowForActor(store, projectId, graph, table, row, actor) {
  const out = {};
  for (const field of normalizedFields(table)) {
    const decision = decideFieldAccess(graph, actor, table, field, "read");
    out[field.name] = decision.allowed ? row[field.name] ?? "" : `[${decision.access}]`;
    audit(store, {
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

function audit(store, event) {
  store.data.audit_events.push({
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

function setCors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
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

function id(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function now() {
  return new Date().toISOString();
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  const port = Number(process.env.BASEPLANE_CONTROL_PORT || DEFAULT_PORT);
  const dataFile = process.env.BASEPLANE_CONTROL_DATA || path.join(os.homedir(), ".baseplane", "control-api.json");
  const server = createControlApiServer({ dataFile });
  server.listen(port, () => {
    console.log(`Baseplane Control API listening on http://127.0.0.1:${port}`);
    console.log(`Data file: ${dataFile}`);
  });
}
