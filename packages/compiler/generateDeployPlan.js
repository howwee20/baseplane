import { humanList } from "./helpers.js";

export function generateDeployPlan(graph) {
  const deployments = graph.deployments || [];
  const lines = [
    "# Deploy Plan",
    "",
    "This is a dry-run deployment plan. Baseplane does not apply destructive changes in this alpha.",
    "No credentials are read. No database is touched.",
    "",
    "## Targets",
    ""
  ];

  if (!deployments.length) {
    lines.push("- none");
  } else {
    for (const item of deployments) {
      lines.push(`- ${item.name}: ${item.target}${item.environment ? ` (${item.environment})` : ""}`);
    }
  }

  lines.push(
    "",
    "## Steps",
    "",
    "1. Review `baseplane.json`.",
    "2. Review generated SQL and RLS policy sketches.",
    "3. Run policy tests locally.",
    "4. Apply migrations manually or with a future reviewed `baseplane apply --dry-run` flow.",
    "",
    `Routes covered: ${humanList((graph.routes || []).map((route) => route.path))}`
  );

  return `${lines.join("\n")}\n`;
}
