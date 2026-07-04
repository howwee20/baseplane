import fs from "node:fs";
import path from "node:path";

export const NODE_TYPES = new Set([
  "table",
  "auth",
  "function",
  "device",
  "secret",
  "website",
  "agent",
  "deployment"
]);

export const POLICY_EFFECTS = new Set(["allow", "deny"]);
export const PRINCIPAL_TYPES = new Set(["human", "organization", "device", "service", "agent"]);
export const RESOURCE_TYPES = new Set(["table", "field", "function", "secret", "graph", "deployment", "website"]);

export function readGraphFile(filePath) {
  const absolute = path.resolve(filePath);
  return JSON.parse(fs.readFileSync(absolute, "utf8"));
}

export function validateGraph(graph) {
  const errors = [];
  const warnings = [];

  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return { valid: false, errors: ["graph must be an object"], warnings };
  }

  if (!stringValue(graph.version)) errors.push("version is required");
  if (!stringValue(graph.appName)) errors.push("appName is required");
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) errors.push("nodes must be a non-empty array");
  if (!Array.isArray(graph.edges)) errors.push("edges must be an array");
  if (!Array.isArray(graph.policies)) errors.push("policies must be an array");

  const nodeIds = new Set();
  for (const [index, node] of (graph.nodes || []).entries()) {
    const label = `nodes[${index}]`;
    if (!stringValue(node?.id)) errors.push(`${label}.id is required`);
    if (!stringValue(node?.name)) errors.push(`${label}.name is required`);
    if (!NODE_TYPES.has(node?.type)) errors.push(`${label}.type must be one of ${Array.from(NODE_TYPES).join(", ")}`);
    if (stringValue(node?.id) && nodeIds.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    if (stringValue(node?.id)) nodeIds.add(node.id);
    if (node?.x !== undefined && typeof node.x !== "number") errors.push(`${label}.x must be a number`);
    if (node?.y !== undefined && typeof node.y !== "number") errors.push(`${label}.y must be a number`);
    if (node?.fields !== undefined && !Array.isArray(node.fields)) errors.push(`${label}.fields must be an array`);
    for (const [fieldIndex, field] of (node?.fields || []).entries()) {
      if (!stringValue(field?.name)) errors.push(`${label}.fields[${fieldIndex}].name is required`);
      if (!stringValue(field?.type)) errors.push(`${label}.fields[${fieldIndex}].type is required`);
    }
  }

  const edgeIds = new Set();
  for (const [index, edge] of (graph.edges || []).entries()) {
    const label = `edges[${index}]`;
    if (!stringValue(edge?.id)) errors.push(`${label}.id is required`);
    if (stringValue(edge?.id) && edgeIds.has(edge.id)) errors.push(`duplicate edge id: ${edge.id}`);
    if (stringValue(edge?.id)) edgeIds.add(edge.id);
    if (!nodeIds.has(edge?.from)) errors.push(`${label}.from does not match a node: ${edge?.from}`);
    if (!nodeIds.has(edge?.to)) errors.push(`${label}.to does not match a node: ${edge?.to}`);
    if (!stringValue(edge?.type)) errors.push(`${label}.type is required`);
  }

  const policyIds = new Set();
  for (const [index, policy] of (graph.policies || []).entries()) {
    const label = `policies[${index}]`;
    if (!stringValue(policy?.id)) errors.push(`${label}.id is required`);
    if (stringValue(policy?.id) && policyIds.has(policy.id)) errors.push(`duplicate policy id: ${policy.id}`);
    if (stringValue(policy?.id)) policyIds.add(policy.id);
    if (!PRINCIPAL_TYPES.has(policy?.principal_type)) errors.push(`${label}.principal_type is invalid`);
    if (!stringValue(policy?.principal_id)) errors.push(`${label}.principal_id is required`);
    if (!RESOURCE_TYPES.has(policy?.resource_type)) errors.push(`${label}.resource_type is invalid`);
    if (!stringValue(policy?.resource_id)) errors.push(`${label}.resource_id is required`);
    if (!stringValue(policy?.action)) errors.push(`${label}.action is required`);
    if (!POLICY_EFFECTS.has(policy?.effect)) errors.push(`${label}.effect must be allow or deny`);
    if (
      policy?.resource_type !== "graph" &&
      policy?.resource_id !== "*" &&
      !nodeIds.has(policy?.resource_id) &&
      !nodeIds.has(String(policy?.resource_id || "").split(".")[0])
    ) {
      warnings.push(`${label}.resource_id does not directly match a node: ${policy?.resource_id}`);
    }
  }

  for (const [index, agent] of (graph.agents || []).entries()) {
    const label = `agents[${index}]`;
    if (!stringValue(agent?.id)) errors.push(`${label}.id is required`);
    if (!stringValue(agent?.name)) errors.push(`${label}.name is required`);
    if (!Array.isArray(agent?.can)) errors.push(`${label}.can must be an array`);
    if (stringValue(agent?.id) && !nodeIds.has(agent.id)) warnings.push(`${label}.id has no matching agent node: ${agent.id}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

export function compileGraph(graph) {
  const validation = validateGraph(graph);
  if (!validation.valid) {
    const error = new Error(`Invalid Baseplane graph:\n${validation.errors.join("\n")}`);
    error.validation = validation;
    throw error;
  }

  return {
    "baseplane.json": `${JSON.stringify({ ...graph, compiledAt: new Date().toISOString() }, null, 2)}\n`,
    "schema.sql": generateSchemaSql(graph),
    "rls_policies.sql": generateRlsSql(graph),
    "agent_policies.json": `${JSON.stringify(generateAgentPolicies(graph), null, 2)}\n`,
    "policy_tests.json": `${JSON.stringify(generatePolicyTests(graph), null, 2)}\n`,
    "README.md": generateReadme(graph)
  };
}

export function writeArtifacts(graph, outDir) {
  const artifacts = compileGraph(graph);
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, content] of Object.entries(artifacts)) {
    fs.writeFileSync(path.join(outDir, name), content);
  }
  return artifacts;
}

export function generateSchemaSql(graph) {
  return `${graph.nodes
    .filter((item) => item.type === "table")
    .map((item) => sqlForNode(item))
    .join("\n\n")}\n`;
}

export function sqlForNode(item) {
  if (item.type !== "table") {
    return `-- ${item.type} node: ${item.name}\n-- Represented in baseplane.json.\n`;
  }

  const table = sqlIdentifier(item.name);
  const fields = item.fields?.length ? item.fields : [{ name: "id", type: "uuid primary key" }];
  const fieldSql = fields.map((field) => `  ${sqlIdentifier(field.name)} ${field.type || "text"}`).join(",\n");

  return [
    `create table if not exists public.${table} (`,
    fieldSql,
    ");",
    "",
    `alter table public.${table} enable row level security;`
  ].join("\n");
}

export function generateRlsSql(graph) {
  const lines = [
    "-- Baseplane generated policy sketch.",
    "-- Review before applying to production.",
    ""
  ];

  for (const item of graph.policies || []) {
    lines.push(`-- ${item.effect.toUpperCase()} ${item.principal_type}:${item.principal_id} ${item.action} ${item.resource_type}:${item.resource_id}`);
    lines.push(`-- condition: ${item.conditions || "none"}`);

    if (item.resource_type === "table" && item.effect === "allow") {
      const table = sqlIdentifier(item.resource_id);
      lines.push(`create policy "${policyName(item)}"`);
      lines.push(`on public.${table}`);
      lines.push(policyActionSql(item.action));
      lines.push("to authenticated");
      lines.push("using (true);");
    } else {
      lines.push("-- Enforce this in the service layer or Baseplane Agent Gateway.");
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

export function generateAgentPolicies(graph) {
  const agentNodes = (graph.nodes || []).filter((item) => item.type === "agent");
  return {
    agents: agentNodes.map((item) => agentPolicyFor(graph, item.id))
  };
}

export function agentPolicyFor(graph, agentId) {
  const existing = (graph.agents || []).find((item) => item.id === agentId);
  if (existing) return existing;
  const node = (graph.nodes || []).find((item) => item.id === agentId);
  return {
    id: agentId,
    name: node?.name || agentId,
    can: (graph.policies || [])
      .filter((item) => item.principal_id === agentId)
      .map((item) => ({
        action: item.action,
        resource: item.resource_id,
        effect: item.effect,
        conditions: item.conditions || ""
      }))
  };
}

export function generatePolicyTests(graph) {
  const tests = [];
  for (const item of graph.policies || []) {
    if (item.effect === "allow") {
      tests.push({
        name: `${item.principal_id} can ${item.action} ${item.resource_id}`,
        principal_id: item.principal_id,
        action: item.action,
        resource_id: item.resource_id,
        field: firstAllowedField(item.conditions),
        expect: "allow"
      });
    }
    if (item.effect === "deny") {
      tests.push({
        name: `${item.principal_id} cannot ${item.action} ${item.resource_id}`,
        principal_id: item.principal_id,
        action: item.action,
        resource_id: item.resource_id,
        expect: "deny"
      });
    }
  }
  return tests;
}

export function runPolicyTests(graph, tests = generatePolicyTests(graph)) {
  return tests.map((test) => {
    const result = simulatePolicy(graph, test);
    return {
      ...test,
      actual: result.effect,
      pass: result.effect === test.expect,
      reason: result.reason
    };
  });
}

export function simulatePolicy(graph, request) {
  const action = normalizeAction(request.action);
  const resourceId = request.resource_id || request.resource || "";
  const principalId = request.principal_id || request.principal || "";
  const field = request.field || "";

  const matching = (graph.policies || []).filter((item) => {
    return principalMatches(item, principalId) &&
      resourceMatches(item, resourceId) &&
      actionMatches(item.action, action);
  });

  const fieldDeny = matching.find((item) => item.effect === "allow" && field && !fieldAllowed(item.conditions, field));
  if (fieldDeny) {
    return {
      effect: "deny",
      policy: fieldDeny.id,
      reason: `${field} is outside the allowed field set`
    };
  }

  const explicitDeny = matching.find((item) => item.effect === "deny");
  if (explicitDeny) {
    return {
      effect: "deny",
      policy: explicitDeny.id,
      reason: explicitDeny.conditions || "explicit deny"
    };
  }

  const explicitAllow = matching.find((item) => item.effect === "allow");
  if (explicitAllow) {
    return {
      effect: "allow",
      policy: explicitAllow.id,
      reason: explicitAllow.conditions || "explicit allow"
    };
  }

  return {
    effect: "deny",
    policy: null,
    reason: "no matching allow policy"
  };
}

export function generateReadme(graph) {
  return `# ${graph.appName}

Generated by Baseplane.

${graph.description || ""}

## Files

- baseplane.json: graph source of truth
- schema.sql: Postgres table sketch
- rls_policies.sql: policy sketch
- agent_policies.json: AI-agent permission model
- policy_tests.json: policy simulator cases

## Important

This package does not contain production credentials or customer data.
Review generated SQL and policies before applying to production.
`;
}

export function sqlIdentifier(value) {
  return String(value || "unnamed")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1")
    .toLowerCase();
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function policyName(item) {
  return `baseplane_${sqlIdentifier(item.principal_id)}_${sqlIdentifier(item.action)}_${sqlIdentifier(item.resource_id)}`;
}

function policyActionSql(action) {
  if (["write", "insert", "create"].includes(action)) return "for insert";
  if (["update", "edit"].includes(action)) return "for update";
  if (["delete", "remove"].includes(action)) return "for delete";
  return "for select";
}

function normalizeAction(action) {
  if (action === "read_rows") return "read";
  if (action === "inspect_schema") return "inspect";
  return action || "";
}

function actionMatches(policyAction, requestAction) {
  return normalizeAction(policyAction) === normalizeAction(requestAction);
}

function principalMatches(policy, principalId) {
  return policy.principal_id === principalId || policy.principal_id === "*";
}

function resourceMatches(policy, resourceId) {
  return policy.resource_id === resourceId ||
    policy.resource_id === "*" ||
    resourceId.startsWith(`${policy.resource_id}.`);
}

function firstAllowedField(conditions = "") {
  const fields = parseAllowedFields(conditions);
  return fields[0] || undefined;
}

function fieldAllowed(conditions = "", field = "") {
  const fields = parseAllowedFields(conditions);
  if (!fields.length) return true;
  return fields.includes(field);
}

function parseAllowedFields(conditions = "") {
  const match = String(conditions).match(/fields:\s*([^.;]+?)(?:\s+only|$)/i);
  if (!match) return [];
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
