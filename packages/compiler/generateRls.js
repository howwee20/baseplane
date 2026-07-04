import { policyActionSql, sqlIdentifier } from "./helpers.js";

export function generateRlsPolicies(graph) {
  const lines = [
    "-- Baseplane generated RLS policy sketch.",
    "-- Review before applying to production.",
    "-- Deny rules, field-scoped agent rules, and secret access must be enforced by the service layer or Agent Gateway.",
    ""
  ];

  for (const policy of graph.policies || []) {
    lines.push(`-- ${policy.effect.toUpperCase()} ${policy.principal_type}:${policy.principal_id} ${policy.action} ${policy.resource_type}:${policy.resource_id}${policy.field ? `.${policy.field}` : ""}`);
    lines.push(`-- reason: ${policy.reason || policy.condition || "not specified"}`);

    if (policy.effect === "allow" && policy.resource_type === "table") {
      const table = sqlIdentifier(policy.resource_id);
      lines.push(`create policy "${sqlIdentifier(policy.id)}"`);
      lines.push(`on public.${table}`);
      lines.push(policyActionSql(policy.action));
      lines.push("to authenticated");
      lines.push("using (true);");
    } else {
      lines.push("-- not compiled to native Postgres RLS in this alpha");
    }

    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
