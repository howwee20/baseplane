import assert from "node:assert/strict";
import {
  APP_TYPE_OPTIONS,
  AI_ACCESS_OPTIONS,
  DATA_DOMAIN_OPTIONS,
  DOMAIN_RESOURCE_LABELS,
  FORBIDDEN_VISIBLE_TERMS,
  RUNTIME_LABELS,
  buildOnboardingGraph,
  createDefaultOnboardingState,
  isOnboardingStateValid,
  validateOnboardingState
} from "../app/onboarding.js";
import { createFullStackTemplates } from "../app/templates.js";
import { compileGraph, evaluateAccess } from "../packages/compiler/index.js";

const templates = createFullStackTemplates();
const templateSnapshot = JSON.stringify(templates);

function filledState(overrides = {}) {
  return {
    appType: "customer_app",
    dataDomains: ["accounts", "records"],
    audience: "team",
    aiAccess: "structure",
    runtime: "managed",
    name: "Northwind Portal",
    ...overrides
  };
}

// Default state is not valid until required choices and name are populated.
const defaultState = createDefaultOnboardingState();
assert.equal(isOnboardingStateValid(defaultState), false);
assert.equal(validateOnboardingState(defaultState).valid, false);
assert.ok(validateOnboardingState(defaultState).errors.length >= 4);

// Default AI choice is the conservative structure option.
assert.equal(defaultState.aiAccess, "structure");
assert.ok(AI_ACCESS_OPTIONS.some((item) => item.id === "structure"));

// Invalid / missing required choices fail closed.
assert.throws(() => buildOnboardingGraph(defaultState, templates), /Invalid onboarding state/);
assert.throws(
  () => buildOnboardingGraph(filledState({ appType: "unknown" }), templates),
  /Invalid onboarding state/
);
assert.throws(
  () => buildOnboardingGraph(filledState({ dataDomains: [] }), templates),
  /Invalid onboarding state/
);
assert.throws(
  () => buildOnboardingGraph(filledState({ name: "   " }), templates),
  /Invalid onboarding state/
);
assert.throws(
  () => buildOnboardingGraph(filledState({ runtime: "" }), templates),
  /Invalid onboarding state/
);

// Every app-type path produces a graph accepted by compileGraph.
for (const appType of APP_TYPE_OPTIONS.map((item) => item.id)) {
  const graph = buildOnboardingGraph(
    filledState({
      appType,
      dataDomains: appType === "data_pipeline" ? ["events", "accounts"] : ["records", "accounts"],
      name: `${appType} backend`
    }),
    templates
  );
  const artifacts = compileGraph(graph);
  assert.ok(artifacts["baseplane.json"]);
  assert.ok(artifacts["schema.sql"]);
  assert.ok(artifacts["deploy_plan.md"]);
}

// Same state produces byte-equivalent graph JSON on repeated calls.
const stateA = filledState({
  appType: "ai_app",
  dataDomains: ["records", "files"],
  audience: "customers",
  aiAccess: "approved",
  runtime: "private",
  name: "Agent Desk"
});
const first = buildOnboardingGraph(stateA, templates);
const second = buildOnboardingGraph(stateA, templates);
assert.equal(JSON.stringify(first), JSON.stringify(second));

// Every data-domain selection produces the expected human-facing resource.
for (const domain of DATA_DOMAIN_OPTIONS.map((item) => item.id)) {
  const graph = buildOnboardingGraph(
    filledState({
      dataDomains: [domain],
      name: `${domain} only`
    }),
    templates
  );
  const expectedName = DOMAIN_RESOURCE_LABELS[domain];
  assert.ok(
    graph.nodes.some((item) => item.name === expectedName),
    `expected human-facing resource ${expectedName} for domain ${domain}`
  );
  compileGraph(graph);
}

// structure: agent schema/inspect access but no row-read grant.
{
  const graph = buildOnboardingGraph(
    filledState({
      aiAccess: "structure",
      dataDomains: ["records"],
      name: "Structure Backend"
    }),
    templates
  );
  compileGraph(graph);
  assert.ok(graph.nodes.some((item) => item.type === "agent" && item.name === "AI Access"));
  assert.ok(graph.principals.some((item) => item.type === "agent" && item.id === "ai_access"));

  const inspect = evaluateAccess(graph, {
    principal_id: "ai_access",
    action: "inspect",
    resource_id: "public",
    resource_type: "schema"
  });
  assert.equal(inspect.decision, "ALLOW");

  const rowRead = evaluateAccess(graph, {
    principal_id: "ai_access",
    action: "read",
    resource_id: "app_data",
    resource_type: "table"
  });
  assert.equal(rowRead.decision, "DENY");
}

// none: removes agent principals/nodes/policies.
{
  const graph = buildOnboardingGraph(
    filledState({
      aiAccess: "none",
      dataDomains: ["accounts"],
      name: "No AI Backend"
    }),
    templates
  );
  compileGraph(graph);
  assert.equal(graph.nodes.filter((item) => item.type === "agent").length, 0);
  assert.equal(graph.principals.filter((item) => item.type === "agent").length, 0);
  assert.equal(graph.policies.filter((item) => item.principal_type === "agent").length, 0);
}

// approved: exactly approved fields are readable; full rows and other fields deny.
{
  const graph = buildOnboardingGraph(
    filledState({
      aiAccess: "approved",
      dataDomains: ["records"],
      name: "Approved Fields Backend"
    }),
    templates
  );
  const approvedField = graph.nodes.find((item) => item.id === "app_data").fields[0].name;
  assert.equal(evaluateAccess(graph, {
    principal_id: "ai_access",
    action: "read",
    resource_id: "app_data",
    resource_type: "table",
    field: approvedField
  }).decision, "ALLOW");
  assert.equal(evaluateAccess(graph, {
    principal_id: "ai_access",
    action: "read",
    resource_id: "app_data",
    resource_type: "table"
  }).decision, "DENY");
  assert.equal(evaluateAccess(graph, {
    principal_id: "ai_access",
    action: "read",
    resource_id: "app_data",
    resource_type: "table",
    field: "private_notes"
  }).decision, "DENY");
}

// Selected runtime produces the correct human-facing runtime label.
for (const [runtimeId, meta] of Object.entries(RUNTIME_LABELS)) {
  const graph = buildOnboardingGraph(
    filledState({
      runtime: runtimeId,
      name: `${runtimeId} runtime backend`
    }),
    templates
  );
  compileGraph(graph);
  const deployNode = graph.nodes.find((item) => item.type === "deployment");
  assert.ok(deployNode, "deployment node required");
  assert.equal(deployNode.name, meta.name);
  assert.equal(graph.deployments[0].name, meta.name);
}

// Onboarding graphs keep technical types internal and expose plain-language labels.
{
  const graph = buildOnboardingGraph(filledState({
    appType: "data_pipeline",
    dataDomains: ["events"],
    name: "Plain Language Graph"
  }), templates);
  assert.ok(graph.nodes.every((item) => item.display_type));
  assert.ok(graph.nodes.every((item) => item.hide_fields === true));
  assert.ok(graph.nodes.some((item) => item.name === "Data Intake" && item.display_type === "connection"));
  assert.ok(graph.nodes.some((item) => item.name === "Monitoring View" && item.display_type === "experience"));
}

// Generated visible names/descriptions do not contain Postgres/SQL/RLS jargon.
{
  const graph = buildOnboardingGraph(
    filledState({
      appType: "data_pipeline",
      dataDomains: ["events", "files", "payments"],
      audience: "public",
      aiAccess: "broad",
      runtime: "customer_cloud",
      name: "Pipeline Cloud"
    }),
    templates
  );
  compileGraph(graph);
  const visible = [
    graph.app.name,
    graph.app.description,
    ...graph.nodes.flatMap((item) => [item.name, item.description]),
    ...graph.deployments.flatMap((item) => [item.name, item.target])
  ]
    .join("\n")
    .toLowerCase();
  for (const term of FORBIDDEN_VISIBLE_TERMS) {
    assert.equal(visible.includes(term), false, `forbidden term leaked: ${term}`);
  }
}

// Source templates are not mutated by graph generation.
buildOnboardingGraph(filledState({ name: "Mutation Check" }), templates);
assert.equal(JSON.stringify(templates), templateSnapshot);

// Five selected resources occupy one non-overlapping data band.
{
  const graph = buildOnboardingGraph(
    filledState({
      dataDomains: DATA_DOMAIN_OPTIONS.map((item) => item.id),
      name: "Five Resource Graph"
    }),
    templates
  );
  const resources = graph.nodes
    .filter((item) => item.type === "table")
    .sort((left, right) => left.x - right.x);
  assert.equal(resources.length, 5);
  assert.ok(resources.every((item) => item.y === 652));
  for (let index = 1; index < resources.length; index += 1) {
    assert.ok(resources[index].x - resources[index - 1].x >= 220);
  }
}

// Audience changes human principals.
{
  const team = buildOnboardingGraph(filledState({ audience: "team", name: "Team Graph" }), templates);
  assert.ok(team.principals.some((item) => item.name === "Team Access"));
  assert.ok(team.nodes.some((item) => item.name === "Team Access" && item.display_type === "access"));

  const customers = buildOnboardingGraph(filledState({ audience: "customers", name: "Customer Graph" }), templates);
  assert.ok(customers.principals.some((item) => item.name === "Customer Access"));
  assert.ok(customers.nodes.some((item) => item.name === "Customer Access" && item.display_type === "access"));

  const publicGraph = buildOnboardingGraph(filledState({ audience: "public", name: "Public Graph" }), templates);
  assert.equal(evaluateAccess(publicGraph, {
    principal_id: "anonymous",
    action: "read",
    resource_id: "dashboard_page",
    resource_type: "page"
  }).decision, "ALLOW");
  assert.ok(publicGraph.routes[0].allowed_principals.includes("anonymous"));
  assert.ok(publicGraph.nodes.some((item) => item.name === "Public Access" && item.display_type === "access"));
}

console.log("onboarding.test.js: ok");
