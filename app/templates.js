/** Shared Studio graph templates. Browser/Node-compatible, no DOM. */

export function createFullStackTemplates() {
  const telemetry = {
    version: "0.1.0",
    app: {
      name: "Generic Telemetry App",
      description: "A private telemetry backend with scoped human, device, route, and AI-agent access."
    },
    nodes: [
      node("app_domain", "app.example.com", "domain", "Primary production domain.", 56, 96, []),
      { ...node("dashboard_page", "/dashboard", "page", "Authenticated telemetry dashboard.", 260, 92, []), path: "/dashboard" },
      { ...node("api_device_ingest", "/api/device-ingest", "api", "Device-token telemetry ingest endpoint.", 260, 300, [["device_token", "secret_input"], ["payload", "jsonb"]]), path: "/api/device-ingest" },
      { ...node("api_agent_query", "/api/agent-query", "api", "Scoped AI-agent query endpoint.", 260, 510, [["agent_identity", "token"], ["query", "jsonb"]]), path: "/api/agent-query" },
      node("users", "users", "table", "Human account records.", 560, 36, [["id", "uuid primary key"], ["email", "text not null"]]),
      node("organizations", "organizations", "table", "Tenant boundary.", 560, 210, [["id", "uuid primary key"], ["name", "text not null"], ["plan", "text"]]),
      node("projects", "projects", "table", "Project and data boundary.", 560, 384, [["id", "uuid primary key"], ["organization_id", "uuid not null"], ["name", "text not null"]]),
      node("devices", "devices", "table", "Registered hardware publishers.", 850, 168, [["id", "text primary key"], ["project_id", "uuid not null"], ["last_seen_at", "timestamptz"]]),
      node("device_tokens", "device_tokens", "secret", "Device token hashes. Secret by default.", 850, 350, [["device_id", "text primary key"], ["token_hash", "text not null"], ["revoked_at", "timestamptz"]]),
      node("telemetry_readings", "telemetry_readings", "table", "Append-only telemetry measurements.", 1120, 175, [["id", "bigint generated always as identity primary key"], ["event_id", "text not null unique"], ["project_id", "uuid not null"], ["timestamp", "timestamptz not null"], ["measurement_value", "double precision not null"], ["raw_payload", "jsonb"]]),
      node("latest_device_state", "latest_device_state", "table", "Current device health snapshot.", 1120, 420, [["device_id", "text primary key"], ["project_id", "uuid not null"], ["status", "text not null"], ["updated_at", "timestamptz not null"]]),
      node("get_project_readings", "get_project_readings", "function", "Returns scoped project readings.", 1410, 150, [["project_id", "uuid"], ["range", "tstzrange"]]),
      node("get_device_health", "get_device_health", "function", "Returns visible device health rows.", 1410, 350, [["project_id", "uuid"]]),
      node("analysis_agent", "analysis_agent", "agent", "Agent with field-scoped telemetry reads.", 560, 650, []),
      node("coding_agent", "coding_agent", "agent", "Agent that can inspect schema but not production rows.", 820, 650, []),
      node("support_agent", "support_agent", "agent", "Agent with operational status access only.", 1080, 650, []),
      node("device_publisher", "device_publisher", "device", "Non-human device principal that publishes telemetry.", 56, 300, []),
      node("postgres", "postgres", "deployment", "Customer-owned Postgres target.", 1410, 560, [["target", "customer-owned postgres"]])
    ],
    edges: [
      stableEdge("app_domain", "dashboard_page", "serves"),
      stableEdge("app_domain", "api_device_ingest", "serves"),
      stableEdge("app_domain", "api_agent_query", "serves"),
      stableEdge("dashboard_page", "telemetry_readings", "reads"),
      stableEdge("dashboard_page", "latest_device_state", "reads"),
      stableEdge("dashboard_page", "projects", "reads"),
      stableEdge("dashboard_page", "get_project_readings", "calls"),
      stableEdge("dashboard_page", "get_device_health", "calls"),
      stableEdge("device_publisher", "api_device_ingest", "publishes_to"),
      stableEdge("api_device_ingest", "devices", "reads"),
      stableEdge("api_device_ingest", "device_tokens", "reads"),
      stableEdge("api_device_ingest", "telemetry_readings", "writes"),
      stableEdge("api_device_ingest", "latest_device_state", "writes"),
      stableEdge("analysis_agent", "telemetry_readings", "reads"),
      stableEdge("coding_agent", "telemetry_readings", "reads"),
      stableEdge("postgres", "telemetry_readings", "deploys_to")
    ],
    principals: [
      principal("researcher", "human", "Researcher"),
      principal("admin", "human", "Admin"),
      principal("anonymous", "anonymous", "Anonymous"),
      principal("analysis_agent", "agent", "analysis_agent"),
      principal("coding_agent", "agent", "coding_agent"),
      principal("support_agent", "agent", "support_agent"),
      principal("device_publisher", "device", "device_publisher"),
      principal("dashboard_page", "service", "/dashboard"),
      principal("api_device_ingest", "service", "/api/device-ingest"),
      principal("api_agent_query", "service", "/api/agent-query")
    ],
    policies: [
      policyObject("researcher", "human", "read", "table", "telemetry_readings", "", "allow", "project membership required", "researcher can read telemetry for their project"),
      policyObject("device_publisher", "device", "write", "table", "telemetry_readings", "", "allow", "valid device token", "device can insert telemetry"),
      policyObject("device_publisher", "device", "read", "table", "telemetry_readings", "", "deny", "", "device write access does not imply read access"),
      policyObject("coding_agent", "agent", "inspect", "schema", "public", "", "allow", "", "schema inspection is separate from row access"),
      policyObject("coding_agent", "agent", "read", "table", "telemetry_readings", "", "deny", "", "coding agent cannot read production rows"),
      policyObject("analysis_agent", "agent", "read", "field", "telemetry_readings", "timestamp", "allow", "project-scoped agent session", "analysis agent can read timestamp only"),
      policyObject("analysis_agent", "agent", "read", "field", "telemetry_readings", "measurement_value", "allow", "project-scoped agent session", "analysis agent can read measurement value only"),
      policyObject("support_agent", "agent", "read", "table", "latest_device_state", "", "allow", "", "support agent can read operational device status"),
      policyObject("support_agent", "agent", "read", "secret", "device_tokens", "", "deny", "", "support agent cannot read device secrets"),
      policyObject("dashboard_page", "service", "read", "table", "telemetry_readings", "", "allow", "authenticated researcher session", "dashboard reads chart data"),
      policyObject("dashboard_page", "service", "read", "table", "latest_device_state", "", "allow", "authenticated researcher session", "dashboard reads device state"),
      policyObject("dashboard_page", "service", "read", "table", "projects", "", "allow", "authenticated researcher session", "dashboard reads project metadata"),
      policyObject("dashboard_page", "service", "read", "secret", "device_tokens", "", "deny", "", "dashboard cannot read secrets"),
      policyObject("api_device_ingest", "service", "write", "table", "telemetry_readings", "", "allow", "valid device token", "ingest writes telemetry rows"),
      policyObject("api_device_ingest", "service", "write", "table", "latest_device_state", "", "allow", "valid device token", "ingest updates latest state"),
      policyObject("api_device_ingest", "service", "read", "table", "devices", "", "allow", "lookup device by token", "ingest validates device identity"),
      policyObject("api_device_ingest", "service", "read", "field", "device_tokens", "token_hash", "allow", "hash compare only", "ingest can compare token hash but not expose it"),
      policyObject("api_agent_query", "service", "read", "field", "telemetry_readings", "timestamp", "allow", "agent identity checked", "agent query API can return timestamp only"),
      policyObject("api_agent_query", "service", "read", "field", "telemetry_readings", "measurement_value", "allow", "agent identity checked", "agent query API can return measurement value only"),
      policyObject("anonymous", "anonymous", "read", "page", "dashboard_page", "", "deny", "", "dashboard requires authentication")
    ],
    routes: [
      route("dashboard_page", "/dashboard", "page", "researcher session", ["telemetry_readings", "latest_device_state", "projects"], [], ["get_project_readings", "get_device_health"], ["researcher", "admin", "analysis_agent scoped fields only"], ["anonymous", "device_publisher", "coding_agent row access"], [], ["log dashboard export requests"]),
      route("api_device_ingest", "/api/device-ingest", "api", "device token", ["devices", "device_tokens.token_hash"], ["telemetry_readings", "latest_device_state"], [], ["device_publisher"], ["anonymous", "browser users", "coding_agent"], ["device_tokens.token_hash"], ["log every insert", "log token failures"]),
      route("api_agent_query", "/api/agent-query", "api", "agent identity", ["telemetry_readings.timestamp", "telemetry_readings.measurement_value"], [], [], ["analysis_agent"], ["coding_agent row access", "anonymous"], [], ["log every agent query", "log denied field requests"])
    ],
    deployments: [{ id: "postgres", name: "Postgres", target: "customer-owned postgres", environment: "production" }]
  };
  applyNodePositions(telemetry, {
    app_domain: [545, 92],
    dashboard_page: [180, 242],
    api_device_ingest: [545, 242],
    api_agent_query: [910, 242],
    users: [60, 412],
    organizations: [300, 412],
    projects: [540, 412],
    device_publisher: [780, 412],
    devices: [1020, 412],
    device_tokens: [1020, 560],
    telemetry_readings: [300, 652],
    latest_device_state: [540, 652],
    get_project_readings: [780, 652],
    get_device_health: [1020, 652],
    analysis_agent: [300, 842],
    coding_agent: [540, 842],
    support_agent: [780, 842],
    postgres: [545, 1032]
  });

  const saas = clone(telemetry);
  saas.app = { name: "Generic SaaS App", description: "A team SaaS backend with organization membership, project data, routes, and support-agent boundaries." };
  saas.nodes = saas.nodes.filter((item) => !["device_publisher", "api_device_ingest", "device_tokens", "telemetry_readings", "latest_device_state"].includes(item.id));
  saas.nodes.push(node("projects_data", "projects_data", "table", "Customer-owned project rows.", 1120, 175, [["id", "uuid primary key"], ["organization_id", "uuid not null"], ["name", "text not null"], ["private_notes", "text"]]));
  saas.edges = [stableEdge("app_domain", "dashboard_page", "serves"), stableEdge("dashboard_page", "projects_data", "reads"), stableEdge("support_agent", "projects_data", "reads"), stableEdge("postgres", "projects_data", "deploys_to")];
  saas.policies = [
    policyObject("researcher", "human", "read", "table", "projects_data", "", "allow", "organization membership required", "member can read organization projects"),
    policyObject("support_agent", "agent", "read", "field", "projects_data", "name", "allow", "", "support can read project names"),
    policyObject("support_agent", "agent", "read", "field", "projects_data", "private_notes", "deny", "", "support cannot read private notes"),
    policyObject("dashboard_page", "service", "read", "table", "projects_data", "", "allow", "signed-in member", "dashboard reads project rows")
  ];
  saas.routes = [route("dashboard_page", "/dashboard", "page", "member session", ["projects_data"], [], [], ["researcher", "admin"], ["anonymous"], [], ["log exports"])];
  applyNodePositions(saas, {
    app_domain: [545, 92],
    dashboard_page: [365, 242],
    api_agent_query: [725, 242],
    users: [180, 412],
    organizations: [420, 412],
    projects: [660, 412],
    devices: [900, 412],
    projects_data: [545, 652],
    analysis_agent: [300, 842],
    coding_agent: [540, 842],
    support_agent: [780, 842],
    postgres: [545, 1032]
  });

  const privateAgent = clone(telemetry);
  privateAgent.app = { name: "Private Agent App", description: "An app where agents can inspect schema and selected fields without inheriting production row or secret access." };
  privateAgent.nodes = privateAgent.nodes.filter((item) => ["app_domain", "api_agent_query", "analysis_agent", "coding_agent", "postgres"].includes(item.id));
  privateAgent.nodes.push(node("customer_records", "customer_records", "table", "Private customer records.", 620, 120, [["id", "uuid primary key"], ["account_name", "text"], ["private_notes", "text"]]));
  privateAgent.nodes.push(node("api_keys", "api_keys", "secret", "Private API key hashes.", 620, 360, [["id", "uuid primary key"], ["token_hash", "text not null"]]));
  privateAgent.edges = [stableEdge("app_domain", "api_agent_query", "serves"), stableEdge("api_agent_query", "customer_records", "reads"), stableEdge("analysis_agent", "customer_records", "reads"), stableEdge("coding_agent", "customer_records", "reads")];
  privateAgent.policies = [
    policyObject("analysis_agent", "agent", "read", "field", "customer_records", "account_name", "allow", "", "analysis agent can read account names"),
    policyObject("analysis_agent", "agent", "read", "field", "customer_records", "private_notes", "deny", "", "private notes remain private"),
    policyObject("coding_agent", "agent", "inspect", "schema", "public", "", "allow", "", "coding agent can inspect schema"),
    policyObject("coding_agent", "agent", "read", "table", "customer_records", "", "deny", "", "coding agent cannot read rows"),
    policyObject("analysis_agent", "agent", "read", "secret", "api_keys", "", "deny", "", "secrets are denied by default"),
    policyObject("api_agent_query", "service", "read", "field", "customer_records", "account_name", "allow", "agent identity checked", "API returns scoped fields")
  ];
  privateAgent.routes = [route("api_agent_query", "/api/agent-query", "api", "agent identity", ["customer_records.account_name"], [], [], ["analysis_agent"], ["coding_agent row access", "anonymous"], [], ["log every query"])];
  applyNodePositions(privateAgent, {
    app_domain: [545, 92],
    api_agent_query: [545, 242],
    customer_records: [420, 512],
    api_keys: [660, 512],
    analysis_agent: [300, 782],
    coding_agent: [540, 782],
    postgres: [545, 1032]
  });

  return { research: telemetry, saas, telemetry, privateAgent };
}

export function node(id, name, type, description, x, y, fields) {
  return {
    id,
    name,
    type,
    description,
    x,
    y,
    fields: (fields || []).map(([fieldName, fieldType]) => ({ name: fieldName, type: fieldType, description: "" })),
    policies: []
  };
}

export function stableEdge(from, to, type) {
  return { id: `edge_${from}_${to}_${type}`, from, to, type, description: "" };
}

export function principal(id, type, name) {
  return { id, type, name };
}

export function policyObject(principal_id, principal_type, action, resource_type, resource_id, field, effect, condition, reason) {
  return {
    id: `policy_${principal_id}_${action}_${resource_id}${field ? `_${field}` : ""}`.replace(/[^a-zA-Z0-9_]/g, "_"),
    principal_type,
    principal_id,
    action,
    resource_type,
    resource_id,
    field,
    effect,
    condition,
    reason
  };
}

export function route(id, path, type, auth, reads, writes, calls, allowed_principals, denied_principals, secrets, audit) {
  return { id, node_id: id, path, type, auth, reads, writes, calls, allowed_principals, denied_principals, secrets, audit };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function applyNodePositions(target, positions) {
  for (const item of target.nodes || []) {
    const position = positions[item.id];
    if (!position) continue;
    item.x = position[0];
    item.y = position[1];
  }
}
