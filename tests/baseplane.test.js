import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  compileGraph,
  readGraphFile,
  runPolicyTests,
  simulatePolicy,
  validateGraph
} from "../src/baseplane.js";

const graphPath = path.resolve("examples/research/baseplane.json");
const graph = readGraphFile(graphPath);

const validation = validateGraph(graph);
assert.equal(validation.valid, true, validation.errors.join("\n"));

const artifacts = compileGraph(graph);
assert.ok(artifacts["schema.sql"].includes("create table if not exists public.telemetry_readings"));
assert.ok(artifacts["rls_policies.sql"].includes("baseplane_project_member_read_telemetry_readings"));
assert.ok(artifacts["rls_policies.sql"].includes("Baseplane Agent Gateway"));
assert.ok(artifacts["agent_policies.json"].includes("Analysis Agent"));

const allowed = simulatePolicy(graph, {
  principal_id: "analysis_agent",
  action: "read",
  resource_id: "telemetry_readings",
  field: "measurement_value"
});
assert.equal(allowed.effect, "allow");

const deniedField = simulatePolicy(graph, {
  principal_id: "analysis_agent",
  action: "read",
  resource_id: "telemetry_readings",
  field: "device_id"
});
assert.equal(deniedField.effect, "deny");

const deniedRows = simulatePolicy(graph, {
  principal_id: "coding_agent",
  action: "read",
  resource_id: "telemetry_readings"
});
assert.equal(deniedRows.effect, "deny");

const testResults = runPolicyTests(graph);
assert.equal(testResults.every((item) => item.pass), true, JSON.stringify(testResults, null, 2));

assert.equal(fs.existsSync(graphPath), true);
console.log("Baseplane tests passed.");
