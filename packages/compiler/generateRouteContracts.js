import { humanList } from "./helpers.js";

export function generateRouteContracts(graph) {
  const routes = graph.routes || [];
  if (!routes.length) return "# Route Contracts\n\nNo routes defined.\n";

  const sections = routes.map((route) => [
    `# ${route.path}`,
    "",
    `Type: ${route.type}`,
    `Auth: ${route.auth}`,
    "",
    "Reads:",
    bullet(route.reads),
    "",
    "Writes:",
    bullet(route.writes),
    "",
    "Calls:",
    bullet(route.calls),
    "",
    `Allowed principals: ${humanList(route.allowed_principals)}`,
    `Denied principals: ${humanList(route.denied_principals)}`,
    `Secrets: ${humanList(route.secrets)}`,
    "",
    "Audit:",
    bullet(route.audit)
  ].join("\n"));

  return `${sections.join("\n\n---\n\n")}\n`;
}

function bullet(items = []) {
  return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none";
}
