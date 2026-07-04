import { sqlIdentifier, tableNodes } from "./helpers.js";

export function generateSql(graph) {
  const blocks = tableNodes(graph).map((node) => tableSql(node));
  return `${blocks.join("\n\n")}\n`;
}

function tableSql(node) {
  const fields = node.fields?.length ? node.fields : [{ name: "id", type: "uuid primary key" }];
  const columns = fields.map((field) => `  ${sqlIdentifier(field.name)} ${field.type || "text"}`).join(",\n");
  const notes = node.type === "secret"
    ? ["", `comment on table public.${sqlIdentifier(node.name)} is 'Baseplane secret node. Deny by default.';`]
    : [];

  return [
    `create table if not exists public.${sqlIdentifier(node.name)} (`,
    columns,
    ");",
    "",
    `alter table public.${sqlIdentifier(node.name)} enable row level security;`,
    ...notes
  ].join("\n");
}
