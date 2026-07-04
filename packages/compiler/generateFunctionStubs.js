export function generateFunctionStubs(graph) {
  const callableNodes = (graph.nodes || []).filter((node) => ["function", "api", "webhook"].includes(node.type));
  if (!callableNodes.length) return "# Function Contracts\n\nNo callable nodes defined.\n";

  return `${callableNodes.map((node) => [
    `# ${node.name}`,
    "",
    `Type: ${node.type}`,
    `Path: ${node.path || "n/a"}`,
    "",
    "Inputs:",
    node.fields?.length ? node.fields.map((field) => `- ${field.name}: ${field.type}`).join("\n") : "- define inputs",
    "",
    "Contract:",
    "- validate caller identity",
    "- enforce Baseplane policies before data access",
    "- audit denied access"
  ].join("\n")).join("\n\n---\n\n")}\n`;
}
