import { EDGE_TYPES, NODE_TYPES, POLICY_EFFECTS, PRINCIPAL_TYPES, nodeById, principalById } from "./helpers.js";

export function validateGraph(graph) {
  const errors = [];
  const warnings = [];

  if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
    return { valid: false, errors: ["graph must be an object"], warnings };
  }

  if (!stringValue(graph.version)) errors.push("version is required");
  if (!graph.app || typeof graph.app !== "object") errors.push("app object is required");
  if (!stringValue(graph.app?.name)) errors.push("app.name is required");
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) errors.push("nodes must be a non-empty array");
  if (!Array.isArray(graph.edges)) errors.push("edges must be an array");
  if (!Array.isArray(graph.principals)) errors.push("principals must be an array");
  if (!Array.isArray(graph.policies)) errors.push("policies must be an array");
  if (!Array.isArray(graph.routes)) errors.push("routes must be an array");
  if (!Array.isArray(graph.deployments)) errors.push("deployments must be an array");

  const nodeIds = new Set();
  for (const [index, node] of (graph.nodes || []).entries()) {
    const label = `nodes[${index}]`;
    if (!stringValue(node?.id)) errors.push(`${label}.id is required`);
    if (!stringValue(node?.name)) errors.push(`${label}.name is required`);
    if (!NODE_TYPES.includes(node?.type)) errors.push(`${label}.type is invalid: ${node?.type}`);
    if (stringValue(node?.id) && nodeIds.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    if (stringValue(node?.id)) nodeIds.add(node.id);
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
    if (!EDGE_TYPES.includes(edge?.type)) errors.push(`${label}.type is invalid: ${edge?.type}`);
  }

  const principalIds = new Set();
  for (const [index, principal] of (graph.principals || []).entries()) {
    const label = `principals[${index}]`;
    if (!stringValue(principal?.id)) errors.push(`${label}.id is required`);
    if (!PRINCIPAL_TYPES.includes(principal?.type)) errors.push(`${label}.type is invalid: ${principal?.type}`);
    if (!stringValue(principal?.name)) errors.push(`${label}.name is required`);
    if (stringValue(principal?.id) && principalIds.has(principal.id)) errors.push(`duplicate principal id: ${principal.id}`);
    if (stringValue(principal?.id)) principalIds.add(principal.id);
  }

  const policyIds = new Set();
  for (const [index, policy] of (graph.policies || []).entries()) {
    const label = `policies[${index}]`;
    if (!stringValue(policy?.id)) errors.push(`${label}.id is required`);
    if (stringValue(policy?.id) && policyIds.has(policy.id)) errors.push(`duplicate policy id: ${policy.id}`);
    if (stringValue(policy?.id)) policyIds.add(policy.id);
    if (!PRINCIPAL_TYPES.includes(policy?.principal_type)) errors.push(`${label}.principal_type is invalid: ${policy?.principal_type}`);
    if (!stringValue(policy?.principal_id)) errors.push(`${label}.principal_id is required`);
    if (!stringValue(policy?.action)) errors.push(`${label}.action is required`);
    if (!stringValue(policy?.resource_type)) errors.push(`${label}.resource_type is required`);
    if (!stringValue(policy?.resource_id)) errors.push(`${label}.resource_id is required`);
    if (!POLICY_EFFECTS.includes(policy?.effect)) errors.push(`${label}.effect must be allow or deny`);
    if (stringValue(policy?.principal_id) && policy.principal_id !== "*" && !principalById(graph, policy.principal_id)) {
      warnings.push(`${label}.principal_id has no matching principal: ${policy.principal_id}`);
    }
    if (stringValue(policy?.resource_id) && policy.resource_type !== "schema" && policy.resource_type !== "graph" && policy.resource_id !== "*") {
      const resource = String(policy.resource_id).split(".")[0];
      if (!nodeById(graph, resource)) warnings.push(`${label}.resource_id has no matching node: ${policy.resource_id}`);
    }
  }

  for (const [index, route] of (graph.routes || []).entries()) {
    const label = `routes[${index}]`;
    if (!stringValue(route?.id)) errors.push(`${label}.id is required`);
    if (!stringValue(route?.path)) errors.push(`${label}.path is required`);
    if (!["page", "api", "webhook"].includes(route?.type)) errors.push(`${label}.type must be page, api, or webhook`);
    if (!stringValue(route?.auth)) errors.push(`${label}.auth is required`);
    if (route?.node_id && !nodeById(graph, route.node_id)) warnings.push(`${label}.node_id has no matching node: ${route.node_id}`);
  }

  for (const [index, deployment] of (graph.deployments || []).entries()) {
    const label = `deployments[${index}]`;
    if (!stringValue(deployment?.id)) errors.push(`${label}.id is required`);
    if (!stringValue(deployment?.name)) errors.push(`${label}.name is required`);
    if (!stringValue(deployment?.target)) errors.push(`${label}.target is required`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0;
}
