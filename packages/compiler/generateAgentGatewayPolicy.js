export function generateAgentGatewayPolicy(graph) {
  const agents = (graph.principals || []).filter((principal) => principal.type === "agent");
  return {
    generated_by: "Baseplane",
    deny_by_default: true,
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      allow: policiesFor(graph, agent.id, "allow"),
      deny: policiesFor(graph, agent.id, "deny")
    }))
  };
}

function policiesFor(graph, principalId, effect) {
  return (graph.policies || [])
    .filter((policy) => policy.principal_id === principalId && policy.effect === effect)
    .map((policy) => ({
      action: policy.action,
      resource_type: policy.resource_type,
      resource_id: policy.resource_id,
      field: policy.field || null,
      condition: policy.condition || null,
      reason: policy.reason || null
    }));
}
