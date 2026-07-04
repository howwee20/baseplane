import { evaluateAccess } from "./evaluateAccess.js";
import { firstField, nodeById, tableNodes } from "./helpers.js";

export function generatePolicyTests(graph) {
  const tests = [];

  for (const policy of graph.policies || []) {
    tests.push({
      name: `${policy.principal_id} ${policy.effect === "allow" ? "can" : "cannot"} ${policy.action} ${policy.resource_id}${policy.field ? `.${policy.field}` : ""}`,
      principal_id: policy.principal_id,
      action: policy.action,
      resource_id: policy.resource_id,
      field: policy.field || "",
      expect: policy.effect.toUpperCase()
    });
  }

  for (const node of tableNodes(graph).filter((item) => item.type === "secret")) {
    tests.push({
      name: `secret ${node.id} denies anonymous read by default`,
      principal_id: "anonymous",
      action: "read",
      resource_id: node.id,
      field: firstField(node),
      expect: "DENY"
    });
  }

  for (const route of graph.routes || []) {
    for (const read of route.reads || []) {
      tests.push({
        name: `${route.path} can read ${read}`,
        principal_id: route.id,
        action: "read",
        resource_id: read.split(".")[0],
        field: read.includes(".") ? read.split(".").slice(1).join(".") : "",
        expect: "ALLOW"
      });
    }
    for (const write of route.writes || []) {
      tests.push({
        name: `${route.path} can write ${write}`,
        principal_id: route.id,
        action: "write",
        resource_id: write.split(".")[0],
        field: write.includes(".") ? write.split(".").slice(1).join(".") : "",
        expect: "ALLOW"
      });
    }
    for (const secret of route.secrets || []) {
      const [resource, field] = secret.split(".");
      const node = nodeById(graph, resource);
      tests.push({
        name: `${route.path} secret check ${secret}`,
        principal_id: route.id,
        action: "read",
        resource_id: resource,
        field: field || firstField(node),
        expect: route.id === "api_device_ingest" ? "ALLOW" : "DENY"
      });
    }
  }

  return tests;
}

export function runPolicyTests(graph, tests = generatePolicyTests(graph)) {
  return tests.map((test) => {
    const result = evaluateAccess(graph, test);
    return {
      ...test,
      actual: result.decision,
      pass: result.decision === test.expect,
      reason: result.reason
    };
  });
}
