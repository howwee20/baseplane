import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createControlApiServer } from "../runtime/control-api/server.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atoll-control-api-"));
const dataFile = path.join(tmpDir, "data.json");
const graph = JSON.parse(fs.readFileSync(path.resolve("examples/generic-telemetry/baseplane.json"), "utf8"));
const schemaSql = fs.readFileSync(path.resolve("runtime/control-api/schema.sql"), "utf8");

assert.throws(
  () => createControlApiServer({ nodeEnv: "production" }),
  /CONTROL_DATABASE_URL is required in production/
);

const server = createControlApiServer({
  dataFile,
  nodeEnv: "production",
  corsOrigin: "https://atolldb.com,https://www.atolldb.com,https://howwee20.github.io",
  version: "test-version"
});

for (const tableName of [
  "accounts",
  "users",
  "sessions",
  "projects",
  "project_members",
  "graph_versions",
  "deploy_requests",
  "backend_instances",
  "field_access_levels",
  "rows",
  "audit_events"
]) {
  assert.match(schemaSql, new RegExp(`create table if not exists ${tableName}`));
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const health = await api("GET", "/health");
  assert.equal(health.ok, true);
  assert.equal(health.status, "ok");
  assert.equal(health.service, "atoll-control-api");
  assert.equal(health.version, "test-version");
  assert.equal(health.storage, "local-file");

  const version = await api("GET", "/version");
  assert.equal(version.service, "atoll-control-api");
  assert.equal(version.version, "test-version");

  const allowedCors = await fetch(`${baseUrl}/health`, { headers: { origin: "https://atolldb.com" } });
  assert.equal(allowedCors.headers.get("access-control-allow-origin"), "https://atolldb.com");

  const deniedCors = await fetch(`${baseUrl}/health`, { headers: { origin: "https://evil.example" } });
  assert.equal(deniedCors.status, 403);
  assert.equal((await deniedCors.json()).error, "cors_origin_denied");

  const signIn = await api("POST", "/api/auth/sign-in", { email: "owner@atoll.local" });
  assert.ok(signIn.session.token);
  const token = signIn.session.token;

  const created = await api("POST", "/api/projects", { name: "Control API Test" }, token);
  const projectId = created.project.id;

  const saved = await api("POST", `/api/projects/${projectId}/graph_versions`, { graph }, token);
  assert.equal(saved.graph_version.project_id, projectId);

  const deployed = await api("POST", `/api/projects/${projectId}/deploy`, {}, token);
  assert.equal(deployed.deploy_request.status, "live");
  assert.deepEqual(deployed.deploy_request.logs.map((log) => log.status), [
    "validating",
    "saving_graph",
    "creating_backend",
    "applying_tables",
    "live"
  ]);
  assert.equal(deployed.backend_instance.status, "live");

  const ownerRow = {
    id: "reading-001",
    event_id: "evt-001",
    project_id: projectId,
    device_id: "device-alpha",
    timestamp: "2026-07-04T18:00:00.000Z",
    measurement_value: 22.7,
    raw_payload: { adc: 411, private_note: "owner only" }
  };

  await api("POST", `/api/projects/${projectId}/tables/telemetry_readings/rows?actor=owner`, { row: ownerRow }, token);

  const ownerRows = await api("GET", `/api/projects/${projectId}/tables/telemetry_readings/rows?actor=owner`, null, token);
  assert.equal(ownerRows.mode, "live");
  assert.equal(ownerRows.rows.length, 1);
  assert.deepEqual(ownerRows.rows[0].raw_payload, ownerRow.raw_payload);

  const analysisRows = await api("GET", `/api/projects/${projectId}/tables/telemetry_readings/rows?actor=analysis_agent`, null, token);
  assert.equal(analysisRows.rows[0].timestamp, ownerRow.timestamp);
  assert.equal(analysisRows.rows[0].measurement_value, ownerRow.measurement_value);
  assert.equal(analysisRows.rows[0].project_id, "[private]");
  assert.equal(analysisRows.rows[0].raw_payload, "[protected]");

  const codingRows = await api("GET", `/api/projects/${projectId}/tables/telemetry_readings/rows?actor=coding_agent`, null, token);
  assert.notEqual(codingRows.rows[0].measurement_value, ownerRow.measurement_value);
  assert.equal(typeof codingRows.rows[0].measurement_value, "number");
  assert.deepEqual(codingRows.rows[0].raw_payload, { synthetic: true, sample_id: codingRows.rows[0].raw_payload.sample_id });

  const filtered = await api("GET", `/api/projects/${projectId}/tables/telemetry_readings/rows?actor=analysis_agent&filter=measurement_value:eq:22.7`, null, token);
  assert.equal(filtered.rows.length, 1);

  await apiError("GET", `/api/projects/${projectId}/tables/telemetry_readings/rows?actor=analysis_agent&filter=raw_payload:contains:owner`, null, token, 403, "query_field_denied");
  await apiError("GET", `/api/projects/${projectId}/tables/telemetry_readings/rows?actor=coding_agent&sort=measurement_value`, null, token, 403, "query_field_denied");

  const updated = await api("PATCH", `/api/projects/${projectId}/tables/telemetry_readings/rows/reading-001?actor=owner`, {
    patch: { measurement_value: 23.1 }
  }, token);
  assert.equal(updated.row.measurement_value, 23.1);

  const audit = await api("GET", `/api/projects/${projectId}/audit_events`, null, token);
  assert.equal(audit.audit_events.some((event) => event.decision === "DENY" && event.field === "raw_payload"), true);
  assert.equal(audit.audit_events.some((event) => event.action === "query" && event.decision === "DENY" && event.field === "measurement_value"), true);
  assert.equal(audit.audit_events.some((event) => event.action === "deploy" && event.decision === "ALLOW"), true);

  const exported = await api("GET", `/api/projects/${projectId}/export`, null, token);
  assert.equal(exported.rows.telemetry_readings.length, 1);
  assert.deepEqual(exported.rows.telemetry_readings[0].raw_payload, ownerRow.raw_payload);

  const stored = JSON.parse(fs.readFileSync(dataFile, "utf8"));
  assert.equal(stored.sessions.some((item) => item.token === token), false, "raw session token should not be stored");
  assert.equal(stored.sessions.every((item) => item.token_hash), true, "session token hash should be stored");

  console.log("Atoll Control API tests passed.");
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function api(method, route, body, token) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = response.status === 204 ? {} : await response.json();
  assert.equal(response.ok, true, `${method} ${route} failed: ${JSON.stringify(json)}`);
  return json;
}

async function apiError(method, route, body, token, status, code) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = response.status === 204 ? {} : await response.json();
  assert.equal(response.status, status, `${method} ${route} expected ${status}: ${JSON.stringify(json)}`);
  assert.equal(json.error, code);
  return json;
}
