import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createControlApiServer } from "../runtime/control-api/server.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "baseplane-control-api-"));
const dataFile = path.join(tmpDir, "data.json");
const graph = JSON.parse(fs.readFileSync(path.resolve("examples/generic-telemetry/baseplane.json"), "utf8"));
const server = createControlApiServer({ dataFile });

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const baseUrl = `http://127.0.0.1:${server.address().port}`;

try {
  const health = await api("GET", "/health");
  assert.equal(health.ok, true);

  const signIn = await api("POST", "/api/auth/sign-in", { email: "owner@baseplane.local" });
  assert.ok(signIn.session.token);
  const token = signIn.session.token;

  const created = await api("POST", "/api/projects", { name: "Control API Test" }, token);
  const projectId = created.project.id;

  const saved = await api("POST", `/api/projects/${projectId}/graph_versions`, { graph }, token);
  assert.equal(saved.graph_version.project_id, projectId);

  const deployed = await api("POST", `/api/projects/${projectId}/deploy`, {}, token);
  assert.equal(deployed.deploy_request.status, "live");
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
  assert.equal(codingRows.rows[0].measurement_value, "[public]");
  assert.equal(codingRows.rows[0].raw_payload, "[protected]");

  const updated = await api("PATCH", `/api/projects/${projectId}/tables/telemetry_readings/rows/reading-001?actor=owner`, {
    patch: { measurement_value: 23.1 }
  }, token);
  assert.equal(updated.row.measurement_value, 23.1);

  const audit = await api("GET", `/api/projects/${projectId}/audit_events`, null, token);
  assert.equal(audit.audit_events.some((event) => event.decision === "DENY" && event.field === "raw_payload"), true);
  assert.equal(audit.audit_events.some((event) => event.action === "deploy" && event.decision === "ALLOW"), true);

  console.log("Baseplane Control API tests passed.");
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
