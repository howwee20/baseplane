import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  REQUIRED_ARTIFACTS,
  assertRequiredArtifacts,
  compileGraph,
  evaluateAccess,
  runPolicyTests,
  validateGraph
} from "../packages/compiler/index.js";

const graphPath = path.resolve("examples/generic-telemetry/baseplane.json");
const graph = JSON.parse(fs.readFileSync(graphPath, "utf8"));

const validation = validateGraph(graph);
assert.equal(validation.valid, true, validation.errors.join("\n"));

const invalid = structuredClone(graph);
invalid.nodes[0].type = "canvas-only-widget";
const invalidValidation = validateGraph(invalid);
assert.equal(invalidValidation.valid, false);
assert.ok(invalidValidation.errors.some((error) => error.includes("type is invalid")));

const artifacts = compileGraph(graph);
assert.deepEqual(assertRequiredArtifacts(artifacts), []);
for (const artifact of REQUIRED_ARTIFACTS) {
  assert.ok(Object.hasOwn(artifacts, artifact), `${artifact} is missing`);
}

assert.ok(artifacts["schema.sql"].includes("create table if not exists public.telemetry_readings"));
assert.ok(artifacts["schema.sql"].includes("create table if not exists public.device_tokens"));
assert.ok(artifacts["rls_policies.sql"].includes('create policy "p_researcher_read_readings"'));
assert.ok(artifacts["route_contracts.md"].includes("# /dashboard"));
assert.ok(artifacts["route_contracts.md"].includes("# /api/device-ingest"));
assert.ok(artifacts["function_stubs.md"].includes("/api/device-ingest"));
assert.ok(artifacts["agent_gateway_policy.json"].includes("analysis_agent"));
assert.ok(artifacts["deploy_plan.md"].includes("No credentials are read"));

assertDecision(
  { principal_id: "analysis_agent", action: "read", resource_id: "telemetry_readings", field: "measurement_value" },
  "ALLOW"
);
assertDecision(
  { principal_id: "analysis_agent", action: "read", resource_id: "telemetry_readings", field: "raw_payload" },
  "DENY"
);
assertDecision(
  { principal_id: "analysis_agent", action: "read", resource_id: "telemetry_readings" },
  "DENY"
);
assertDecision(
  { principal_id: "coding_agent", action: "inspect", resource_id: "public" },
  "ALLOW"
);
assertDecision(
  { principal_id: "coding_agent", action: "read", resource_id: "telemetry_readings", field: "measurement_value" },
  "DENY"
);
assertDecision(
  { principal_id: "support_agent", action: "read", resource_id: "device_tokens", field: "token_hash" },
  "DENY"
);
assertDecision(
  { principal_id: "dashboard_page", action: "read", resource_id: "device_tokens", field: "token_hash" },
  "DENY"
);
assertDecision(
  { principal_id: "api_device_ingest", action: "write", resource_id: "telemetry_readings" },
  "ALLOW"
);
assertDecision(
  { principal_id: "api_device_ingest", action: "read", resource_id: "device_tokens", field: "token_hash" },
  "ALLOW"
);
assertDecision(
  { principal_id: "anonymous", action: "read", resource_id: "telemetry_readings" },
  "DENY"
);

const testResults = runPolicyTests(graph);
assert.equal(testResults.every((item) => item.pass), true, JSON.stringify(testResults, null, 2));

for (const example of [
  "examples/generic-telemetry/baseplane.json",
  "examples/generic-saas/baseplane.json",
  "examples/private-agent/baseplane.json"
]) {
  const exampleGraph = JSON.parse(fs.readFileSync(path.resolve(example), "utf8"));
  const exampleValidation = validateGraph(exampleGraph);
  assert.equal(exampleValidation.valid, true, `${example}\n${exampleValidation.errors.join("\n")}`);
  assert.deepEqual(assertRequiredArtifacts(compileGraph(exampleGraph)), []);
}

console.log("Baseplane tests passed.");

function assertDecision(query, expected) {
  const result = evaluateAccess(graph, query);
  assert.equal(result.decision, expected, `${JSON.stringify(query)} -> ${JSON.stringify(result)}`);
  assert.ok(result.reason.length > 0, "decision should explain itself");
}
