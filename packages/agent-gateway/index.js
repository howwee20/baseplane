import { evaluateAccess } from "../compiler/index.js";
import { nodeById, splitResource } from "../compiler/helpers.js";

export function authorizeAgentRequest(graph, request) {
  const principalId = request.agent_id || request.principal_id || request.principal || "";
  const action = request.action || "read";
  const resourceInput = request.resource_id || request.resource || "";
  const { resource, field } = splitResource(resourceInput);
  const resourceNode = nodeById(graph, resource);
  const requestedFields = normalizeRequestedFields(resourceNode, field, request.fields);

  if (!principalId) return deny("missing agent_id or principal_id");
  if (!resource) return deny("missing resource_id or resource");

  if (!requestedFields.length) {
    const result = evaluateAccess(graph, {
      principal_id: principalId,
      action,
      resource_id: resource
    });
    return summarize(principalId, action, resource, [], [result]);
  }

  const checks = requestedFields.map((fieldName) => evaluateAccess(graph, {
    principal_id: principalId,
    action,
    resource_id: resource,
    field: fieldName
  }));

  return summarize(principalId, action, resource, requestedFields, checks);
}

export function redactRecord(record, authorization) {
  if (authorization.decision !== "ALLOW") return {};
  if (!authorization.fields?.length) return { ...record };
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => authorization.fields.includes(key))
  );
}

function normalizeRequestedFields(resourceNode, field, fields) {
  if (Array.isArray(fields) && fields.length) return fields.filter(Boolean);
  if (field) return [field];
  if (!resourceNode?.fields?.length) return [];
  return resourceNode.fields.map((item) => item.name).filter(Boolean);
}

function summarize(principalId, action, resource, fields, checks) {
  const denied = checks
    .map((check, index) => ({ check, field: fields[index] || "" }))
    .filter((item) => item.check.decision !== "ALLOW");
  const allowedFields = fields.filter((_, index) => checks[index]?.decision === "ALLOW");
  const decision = denied.length ? "DENY" : "ALLOW";

  return {
    decision,
    principal_id: principalId,
    action,
    resource_id: resource,
    fields: decision === "ALLOW" ? allowedFields : [],
    allowed_fields: allowedFields,
    denied_fields: denied.map((item) => item.field).filter(Boolean),
    reason: denied.length
      ? denied.flatMap((item) => item.check.reason)
      : checks.flatMap((item) => item.reason),
    checks: checks.map((check, index) => ({
      field: fields[index] || null,
      decision: check.decision,
      policy: check.policy,
      reason: check.reason
    }))
  };
}

function deny(reason) {
  return {
    decision: "DENY",
    fields: [],
    allowed_fields: [],
    denied_fields: [],
    reason: [reason],
    checks: []
  };
}
