import {
  exactAllowMatches,
  isSecretOrPrivate,
  nodeById,
  policyMatches,
  principalById,
  resourceLabel,
  splitResource
} from "./helpers.js";

export function evaluateAccess(graph, query) {
  const principalId = query.principal_id || query.principal || "";
  const action = query.action || "";
  const resourceInput = query.resource_id || query.resource || "";
  const split = splitResource(resourceInput);
  const resourceId = split.resource;
  const field = query.field || split.field || "";
  const principal = principalById(graph, principalId);
  const resource = nodeById(graph, resourceId);
  const reasons = [];

  if (!principal) reasons.push(`principal ${principalId} is not declared`);
  if (!resource && resourceInput !== "public") reasons.push(`resource ${resourceInput} is not declared`);

  const request = { ...query, principal_id: principalId, action, resource_id: resourceId, field };
  const matching = (graph.policies || []).filter((policy) => policyMatches(policy, request));
  const denies = matching.filter((policy) => policy.effect === "deny");
  const allows = matching.filter((policy) => exactAllowMatches(policy, request));

  if (denies.length) {
    return deny([denies[0].reason || denies[0].condition || `explicit deny policy ${denies[0].id}`]);
  }

  if (isSecretOrPrivate(graph, resourceId, field) && !allows.length) {
    const label = resourceLabel(resourceId, field);
    return deny([
      `${label} is secret or private`,
      `no explicit allow policy matched ${principalId}`,
      "deny by default"
    ]);
  }

  if (principal?.type === "agent" && action === "read" && !field) {
    const tableAllow = matching.find((policy) => policy.effect === "allow" && policy.resource_type === "table");
    if (!tableAllow) {
      return deny([
        "agent row access requires an explicit table-level allow",
        "field-scoped policies do not grant full row access",
        "deny by default"
      ]);
    }
  }

  if (allows.length) {
    const policy = allows[0];
    return {
      decision: "ALLOW",
      policy: policy.id,
      reason: [
        policy.reason || policy.condition || `${principalId} has ${action} access to ${resourceLabel(resourceId, field)}`,
        "no deny policy matched"
      ]
    };
  }

  return deny([...reasons, "no matching allow policy", "deny by default"]);
}

function deny(reason) {
  return {
    decision: "DENY",
    policy: null,
    reason: reason.filter(Boolean)
  };
}
