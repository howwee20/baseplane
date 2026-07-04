export const NODE_TYPES = [
  "domain",
  "route",
  "page",
  "api",
  "webhook",
  "table",
  "function",
  "secret",
  "agent",
  "device",
  "deployment"
];

export const EDGE_TYPES = [
  "reads",
  "writes",
  "owns",
  "calls",
  "serves",
  "deploys_to",
  "authenticates",
  "authorizes",
  "stores_secret",
  "publishes_to",
  "denies",
  "allows"
];

export const PRINCIPAL_TYPES = ["human", "org", "agent", "device", "service", "anonymous"];
export const POLICY_EFFECTS = ["allow", "deny"];
export const REQUIRED_ARTIFACTS = [
  "baseplane.json",
  "schema.sql",
  "rls_policies.sql",
  "route_contracts.md",
  "function_stubs.md",
  "agent_gateway_policy.json",
  "policy_tests.json",
  "deploy_plan.md",
  "README.md"
];

export function nodeById(graph, id) {
  return (graph.nodes || []).find((item) => item.id === id);
}

export function principalById(graph, id) {
  return (graph.principals || []).find((item) => item.id === id);
}

export function routeForNode(graph, nodeId) {
  return (graph.routes || []).find((item) => item.node_id === nodeId || item.id === nodeId);
}

export function tableNodes(graph) {
  return (graph.nodes || []).filter((item) => item.type === "table" || item.type === "secret");
}

export function sqlIdentifier(value) {
  return String(value || "unnamed")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^([0-9])/, "_$1")
    .toLowerCase();
}

export function normalizeAction(action) {
  if (action === "read_rows") return "read";
  if (action === "insert") return "write";
  if (action === "update") return "write";
  if (action === "inspect_schema") return "inspect";
  return action || "";
}

export function splitResource(resourceId = "") {
  const [resource, ...fieldParts] = String(resourceId).split(".");
  return {
    resource,
    field: fieldParts.join(".") || ""
  };
}

export function fieldByName(node, fieldName) {
  return (node?.fields || []).find((item) => item.name === fieldName);
}

export function isSecretOrPrivate(graph, resourceId, fieldName = "") {
  const { resource, field } = splitResource(resourceId);
  const node = nodeById(graph, resource) || nodeById(graph, resourceId);
  const effectiveField = fieldName || field;
  if (node?.type === "secret") return true;
  const meta = effectiveField ? fieldByName(node, effectiveField) : null;
  return Boolean(meta?.secret || meta?.private);
}

export function resourceLabel(resourceId, fieldName = "") {
  return fieldName ? `${resourceId}.${fieldName}` : resourceId;
}

export function humanList(items = []) {
  return items.length ? items.join(", ") : "none";
}

export function policyActionSql(action) {
  const normalized = normalizeAction(action);
  if (normalized === "write") return "for insert";
  if (normalized === "delete") return "for delete";
  return "for select";
}

export function policyMatches(policy, query) {
  const principalId = query.principal_id || query.principal || "";
  const action = normalizeAction(query.action);
  const resourceId = query.resource_id || query.resource || "";
  const field = query.field || splitResource(resourceId).field;
  const resource = splitResource(resourceId).resource;

  if (policy.principal_id !== principalId && policy.principal_id !== "*") return false;
  if (normalizeAction(policy.action) !== action) return false;

  if (policy.resource_type === "field") {
    return policy.resource_id === resource && (!policy.field || policy.field === field);
  }

  return policy.resource_id === resourceId || policy.resource_id === resource || policy.resource_id === "*";
}

export function exactAllowMatches(policy, query) {
  if (policy.effect !== "allow" || !policyMatches(policy, query)) return false;
  if (policy.resource_type === "field") {
    const field = query.field || splitResource(query.resource_id || query.resource || "").field;
    return Boolean(field) && policy.field === field;
  }
  return true;
}

export function firstField(node) {
  return node?.fields?.[0]?.name || "";
}
