export function introspectSql(sql, options = {}) {
  const nodes = [];
  const edges = [];
  const policies = [];
  const principals = [
    { id: "app_user", type: "human", name: "App user" },
    { id: "service_role", type: "service", name: "Service role" },
    { id: "analysis_agent", type: "agent", name: "analysis_agent" },
    { id: "anonymous", type: "anonymous", name: "Anonymous" }
  ];

  for (const table of parseCreateTables(sql)) {
    const nodeType = table.name.includes("secret") || table.name.includes("token") || table.name.includes("key") ? "secret" : "table";
    nodes.push({
      id: table.name,
      name: table.name,
      type: nodeType,
      description: `Introspected ${nodeType}.`,
      x: 320 + (nodes.length % 3) * 240,
      y: 220 + Math.floor(nodes.length / 3) * 170,
      fields: table.fields
    });

    policies.push({
      id: `p_app_user_read_${table.name}`,
      principal_type: "human",
      principal_id: "app_user",
      action: "read",
      resource_type: nodeType,
      resource_id: table.name,
      effect: nodeType === "secret" ? "deny" : "allow",
      condition: nodeType === "secret" ? "" : "project membership required",
      reason: nodeType === "secret" ? "secret tables deny user reads by default" : "initial introspected user read policy"
    });

    policies.push({
      id: `p_agent_no_rows_${table.name}`,
      principal_type: "agent",
      principal_id: "analysis_agent",
      action: "read",
      resource_type: nodeType,
      resource_id: table.name,
      effect: "deny",
      condition: "",
      reason: "agent row access must be explicitly granted after review"
    });
  }

  for (const table of nodes) {
    for (const field of table.fields || []) {
      const reference = foreignReference(field.type);
      if (!reference) continue;
      const target = nodes.find((node) => node.name === reference);
      if (!target) continue;
      edges.push({
        id: `edge_${table.id}_${target.id}_owns`,
        from: target.id,
        to: table.id,
        type: "owns",
        description: `${target.name} scopes ${table.name} through ${field.name}`
      });
    }
  }

  return {
    version: "0.1.0",
    app: {
      name: options.appName || "Introspected Backend",
      description: "Generated from SQL schema introspection. Review policies before production use."
    },
    nodes,
    edges,
    principals,
    policies,
    routes: [],
    deployments: [
      { id: "postgres", name: "Postgres", target: "existing postgres", environment: "unknown" }
    ]
  };
}

function parseCreateTables(sql) {
  const tables = [];
  const tablePattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-zA-Z_][\w]*)"?\s*\(([\s\S]*?)\)\s*;/gi;
  let match;
  while ((match = tablePattern.exec(sql))) {
    tables.push({
      name: match[1],
      fields: parseFields(match[2])
    });
  }
  return tables;
}

function parseFields(body) {
  return body
    .split(/\n|,(?![^()]*\))/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^(constraint|primary\s+key|foreign\s+key|unique|check)\b/i.test(line))
    .map((line) => {
      const match = line.match(/^"?([a-zA-Z_][\w]*)"?\s+(.+)$/);
      if (!match) return null;
      const name = match[1];
      const type = match[2].replace(/,$/, "").trim();
      return {
        name,
        type,
        private: /password|token|secret|hash|key|payload/i.test(name)
      };
    })
    .filter(Boolean);
}

function foreignReference(type) {
  const match = String(type).match(/references\s+(?:public\.)?("?)([a-zA-Z_][\w]*)\1/i);
  return match?.[2] || "";
}
