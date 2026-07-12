/**
 * Pure deterministic onboarding definitions and graph builder.
 * Browser/Node-compatible ES module with no DOM dependency.
 */

import { clone, node, stableEdge, principal, policyObject, route } from "./templates.js";

export const ONBOARDING_STEP_COUNT = 6;

export const APP_TYPE_OPTIONS = [
  {
    id: "customer_app",
    label: "Customer app",
    description: "A web or mobile product for customers."
  },
  {
    id: "internal_tool",
    label: "Internal tool",
    description: "Software for you and your team."
  },
  {
    id: "ai_app",
    label: "AI application",
    description: "An app where agents work with controlled access."
  },
  {
    id: "data_pipeline",
    label: "Data pipeline",
    description: "Devices, events, measurements, or imports."
  }
];

export const DATA_DOMAIN_OPTIONS = [
  {
    id: "accounts",
    label: "Accounts",
    description: "People, profiles, and sign-in."
  },
  {
    id: "records",
    label: "Business records",
    description: "The core information your app manages."
  },
  {
    id: "files",
    label: "Files",
    description: "Uploads, documents, and media."
  },
  {
    id: "events",
    label: "Events",
    description: "Activity, measurements, or time-series information."
  },
  {
    id: "payments",
    label: "Payments",
    description: "Plans, purchases, and billing records."
  }
];

export const AUDIENCE_OPTIONS = [
  { id: "only_me", label: "Only me", description: "Just you for now." },
  { id: "team", label: "My team", description: "People on your team." },
  { id: "customers", label: "Customers", description: "People who use your product." },
  { id: "public", label: "Public users", description: "Anyone on the open internet." }
];

export const AI_ACCESS_OPTIONS = [
  {
    id: "none",
    label: "No AI access",
    description: "No agents in this backend graph."
  },
  {
    id: "structure",
    label: "Structure only",
    description: "Agents can understand the shape, never rows."
  },
  {
    id: "approved",
    label: "Approved information",
    description: "Agents receive only fields you allow."
  },
  {
    id: "broad",
    label: "Everything except secrets",
    description: "Broad access with secrets always denied."
  }
];

export const RUNTIME_OPTIONS = [
  {
    id: "managed",
    label: "Atoll managed",
    description: "Atoll prepares and operates the runtime."
  },
  {
    id: "customer_cloud",
    label: "My cloud",
    description: "Deploy into infrastructure you control."
  },
  {
    id: "private",
    label: "Private environment",
    description: "Keep the runtime inside private infrastructure."
  }
];

export const ONBOARDING_STEPS = [
  {
    id: "appType",
    title: "What are you building?",
    mode: "single",
    field: "appType",
    options: APP_TYPE_OPTIONS
  },
  {
    id: "dataDomains",
    title: "What should it remember?",
    mode: "multi",
    field: "dataDomains",
    options: DATA_DOMAIN_OPTIONS,
    minSelections: 1
  },
  {
    id: "audience",
    title: "Who uses it?",
    mode: "single",
    field: "audience",
    options: AUDIENCE_OPTIONS
  },
  {
    id: "aiAccess",
    title: "What can AI access?",
    mode: "single",
    field: "aiAccess",
    options: AI_ACCESS_OPTIONS,
    defaultValue: "structure"
  },
  {
    id: "runtime",
    title: "Where should it run?",
    mode: "single",
    field: "runtime",
    options: RUNTIME_OPTIONS
  },
  {
    id: "review",
    title: "Name and review",
    mode: "review",
    field: "name"
  }
];

/** Human-facing labels for data domain resource nodes. */
export const DOMAIN_RESOURCE_LABELS = {
  accounts: "Accounts",
  records: "App Data",
  files: "Files",
  events: "Events",
  payments: "Payments"
};

export const RUNTIME_LABELS = {
  managed: {
    name: "Atoll Runtime",
    description: "Atoll prepares and operates the runtime.",
    target: "atoll-managed"
  },
  customer_cloud: {
    name: "Your Cloud Runtime",
    description: "Deploy into infrastructure you control.",
    target: "customer-cloud"
  },
  private: {
    name: "Private Runtime",
    description: "Keep the runtime inside private infrastructure.",
    target: "private-environment"
  }
};

export const FORBIDDEN_VISIBLE_TERMS = [
  "postgres",
  "sql",
  "rls",
  "schema migration",
  "connection pool"
];

/**
 * Normalized default onboarding draft.
 * Valid only after required user choices and name are populated.
 */
export function createDefaultOnboardingState() {
  return {
    appType: "",
    dataDomains: [],
    audience: "",
    aiAccess: "structure",
    runtime: "",
    name: ""
  };
}

export function validateOnboardingState(state) {
  const errors = [];
  if (!state || typeof state !== "object") {
    return { valid: false, errors: ["onboarding state must be an object"] };
  }

  if (!optionIds(APP_TYPE_OPTIONS).includes(state.appType)) {
    errors.push("appType is required");
  }

  if (!Array.isArray(state.dataDomains) || state.dataDomains.length < 1) {
    errors.push("at least one data domain is required");
  } else {
    const known = optionIds(DATA_DOMAIN_OPTIONS);
    for (const domain of state.dataDomains) {
      if (!known.includes(domain)) errors.push(`unknown data domain: ${domain}`);
    }
    if (new Set(state.dataDomains).size !== state.dataDomains.length) {
      errors.push("data domains must be unique");
    }
  }

  if (!optionIds(AUDIENCE_OPTIONS).includes(state.audience)) {
    errors.push("audience is required");
  }

  if (!optionIds(AI_ACCESS_OPTIONS).includes(state.aiAccess)) {
    errors.push("aiAccess is required");
  }

  if (!optionIds(RUNTIME_OPTIONS).includes(state.runtime)) {
    errors.push("runtime is required");
  }

  if (typeof state.name !== "string" || !state.name.trim()) {
    errors.push("name is required");
  } else if (state.name.trim().length > 80) {
    errors.push("name must be 80 characters or fewer");
  }

  return { valid: errors.length === 0, errors };
}

export function isOnboardingStateValid(state) {
  return validateOnboardingState(state).valid;
}

/**
 * Deterministically compile onboarding answers into a Studio graph.
 * Clones and adapts template material; never mutates `templates`.
 */
export function buildOnboardingGraph(state, templates) {
  const validation = validateOnboardingState(state);
  if (!validation.valid) {
    const error = new Error(`Invalid onboarding state:\n${validation.errors.join("\n")}`);
    error.validation = validation;
    throw error;
  }
  if (!templates || typeof templates !== "object") {
    throw new Error("templates are required");
  }

  const templateKey = baseTemplateKey(state.appType);
  const source = templates[templateKey] || templates.saas || templates.research || templates.telemetry;
  if (!source) {
    throw new Error(`missing template for ${templateKey}`);
  }

  // Clone only the selected template; leave the templates object untouched.
  const base = clone(source);
  const domains = unique(state.dataDomains);
  const domainNodes = domains.map((domainId, index) => createDomainNode(domainId, index, base));
  const primaryDomain = domainNodes[0];
  const runtimeMeta = RUNTIME_LABELS[state.runtime];
  const humanPrincipals = audiencePrincipals(state.audience);
  const primaryHuman = humanPrincipals.find((item) => item.type === "human") || humanPrincipals[0];

  const applicationNode = {
    ...node("app_domain", "Application", "domain", applicationDescription(state.appType), 545, 92, [["host", "text"]]),
    path: undefined
  };
  const audienceNode = node(
    "audience_access",
    audienceNodeName(state.audience),
    "page",
    audienceNodeDescription(state.audience),
    545,
    412,
    []
  );

  const surfaceNodes = [];
  const surfacePrincipals = [];
  const surfaceRoutes = [];
  const edges = [];
  const policies = [];

  if (state.appType === "ai_app") {
    const agentApi = {
      ...node(
        "api_agent_query",
        "AI Connection",
      "api",
        "Scoped agent query endpoint.",
        545,
        242,
        fieldPairsFrom(base, "api_agent_query") || [["agent_identity", "token"], ["query", "jsonb"]]
      ),
      path: "/api/agent-query"
    };
    surfaceNodes.push(agentApi);
    surfacePrincipals.push(principal("api_agent_query", "service", "AI Connection"));
    edges.push(stableEdge("app_domain", "api_agent_query", "serves"));
    for (const domainNode of domainNodes) {
      edges.push(stableEdge("api_agent_query", domainNode.id, "reads"));
      policies.push(
        policyObject(
          "api_agent_query",
          "service",
          "read",
          "table",
          domainNode.id,
          "",
          "allow",
          "agent identity checked",
          "agent query API may read approved resources"
        )
      );
    }
    surfaceRoutes.push(
      route(
        "api_agent_query",
        "/api/agent-query",
        "api",
        "agent identity",
        domainNodes.map((item) => item.id),
        [],
        [],
        state.aiAccess === "none" ? [] : ["ai_access"],
        ["anonymous"],
        [],
        ["log every agent query"]
      )
    );
  } else {
    const dashboard = {
      ...node(
        "dashboard_page",
        applicationSurfaceName(state.appType),
        "page",
        "Primary application surface.",
        365,
        242,
        []
      ),
      path: "/dashboard"
    };
    surfaceNodes.push(dashboard);
    surfacePrincipals.push(principal("dashboard_page", "service", applicationSurfaceName(state.appType)));
    edges.push(stableEdge("app_domain", "dashboard_page", "serves"));

    for (const domainNode of domainNodes) {
      edges.push(stableEdge("dashboard_page", domainNode.id, "reads"));
      policies.push(
        policyObject(
          "dashboard_page",
          "service",
          "read",
          "table",
          domainNode.id,
          "",
          "allow",
          "signed-in session",
          "application surface reads remembered data"
        )
      );
    }

    if (state.appType === "data_pipeline") {
      const ingest = {
        ...node(
          "api_device_ingest",
          "Data Intake",
          "api",
          "Ingest endpoint for devices, events, and imports.",
          725,
          242,
          fieldPairsFrom(base, "api_device_ingest") || [["device_token", "secret_input"], ["payload", "jsonb"]]
        ),
        path: "/api/device-ingest"
      };
      surfaceNodes.push(ingest);
      surfacePrincipals.push(principal("api_device_ingest", "service", "Data Intake"));
      edges.push(stableEdge("app_domain", "api_device_ingest", "serves"));
      const writeTarget = domainNodes.find((item) => item.id === "events") || primaryDomain;
      edges.push(stableEdge("api_device_ingest", writeTarget.id, "writes"));
      policies.push(
        policyObject(
          "api_device_ingest",
          "service",
          "write",
          "table",
          writeTarget.id,
          "",
          "allow",
          "valid device or import credential",
          "ingest writes event and measurement rows"
        )
      );
      surfaceRoutes.push(
        route(
          "api_device_ingest",
          "/api/device-ingest",
          "api",
          "device token",
          [],
          [writeTarget.id],
          [],
          ["device_publisher"],
          ["anonymous"],
          [],
          ["log every insert"]
        )
      );
      // Optional device principal from telemetry template shape.
      surfacePrincipals.push(principal("device_publisher", "device", "Device publisher"));
    }

    const allowedHumans = humanPrincipals.filter((item) => item.type === "human").map((item) => item.id);
    const allowedAudience = state.audience === "public"
      ? [...allowedHumans, "anonymous"]
      : allowedHumans;
    surfaceRoutes.push(
      route(
        "dashboard_page",
        "/dashboard",
        "page",
        audienceAuthLabel(state.audience),
        domainNodes.map((item) => item.id),
        [],
        [],
        allowedAudience.length ? allowedAudience : [primaryHuman.id],
        state.audience === "public" ? [] : ["anonymous"],
        [],
        ["log exports"]
      )
    );
  }

  const primarySurface = surfaceNodes.find((item) => item.id === "dashboard_page")
    || surfaceNodes.find((item) => item.id === "api_agent_query")
    || surfaceNodes[0];
  if (primarySurface) {
    edges.push(stableEdge(primarySurface.id, audienceNode.id, "authenticates"));
  }
  for (const domainNode of domainNodes) {
    edges.push(stableEdge(audienceNode.id, domainNode.id, "authorizes"));
  }

  // Human principals and access policies
  for (const human of humanPrincipals) {
    if (human.type === "anonymous") continue;
    for (const domainNode of domainNodes) {
      policies.push(
        policyObject(
          human.id,
          "human",
          "read",
          "table",
          domainNode.id,
          "",
          "allow",
          audienceCondition(state.audience),
          `${human.name} can read ${domainNode.name}`
        )
      );
    }
  }

  if (state.audience !== "public") {
    if (!humanPrincipals.some((item) => item.id === "anonymous")) {
      humanPrincipals.push(principal("anonymous", "anonymous", "Anonymous"));
    }
    if (surfaceNodes.some((item) => item.id === "dashboard_page")) {
      policies.push(
        policyObject(
          "anonymous",
          "anonymous",
          "read",
          "page",
          "dashboard_page",
          "",
          "deny",
          "",
          "application surface requires sign-in"
        )
      );
    }
  } else {
    if (!humanPrincipals.some((item) => item.id === "anonymous")) {
      humanPrincipals.push(principal("anonymous", "anonymous", "Anonymous"));
    }
    if (surfaceNodes.some((item) => item.id === "dashboard_page")) {
      policies.push(
        policyObject(
          "anonymous",
          "anonymous",
          "read",
          "page",
          "dashboard_page",
          "",
          "allow",
          "public access boundary",
          "public users can open the application experience"
        )
      );
    }
  }

  // AI layer
  const agentNodes = [];
  const agentPrincipals = [];
  if (state.aiAccess !== "none") {
    const aiNode = node(
      "ai_access",
      "AI Access",
      "agent",
      aiNodeDescription(state.aiAccess),
      545,
      842,
      [["identity", "agent"], ["scope", state.aiAccess]]
    );
    agentNodes.push(aiNode);
    agentPrincipals.push(principal("ai_access", "agent", "AI Access"));

    if (state.aiAccess === "structure") {
      policies.push(
        policyObject(
          "ai_access",
          "agent",
          "inspect",
          "schema",
          "public",
          "",
          "allow",
          "",
          "agents can understand structure only"
        )
      );
      for (const domainNode of domainNodes) {
        policies.push(
          policyObject(
            "ai_access",
            "agent",
            "read",
            "table",
            domainNode.id,
            "",
            "deny",
            "",
            "structure access does not grant row reads"
          )
        );
        edges.push(stableEdge("ai_access", domainNode.id, "reads"));
      }
    } else if (state.aiAccess === "approved") {
      for (const domainNode of domainNodes) {
        const approvedField = (domainNode.fields || []).find((field) => !/secret|hash|private|token/i.test(field.name))
          || domainNode.fields?.[0];
        if (approvedField) {
          policies.push(
            policyObject(
              "ai_access",
              "agent",
              "read",
              "field",
              domainNode.id,
              approvedField.name,
              "allow",
              "approved field only",
              "agents receive only fields you allow"
            )
          );
        }
        const deniedField = (domainNode.fields || []).find((field) => /private|secret|hash|token|notes/i.test(field.name));
        if (deniedField) {
          policies.push(
            policyObject(
              "ai_access",
              "agent",
              "read",
              "field",
              domainNode.id,
              deniedField.name,
              "deny",
              "",
              "unapproved fields remain denied"
            )
          );
        }
        // No table-level allow is emitted. Deny-by-default blocks full rows and
        // every field that lacks an exact approved-field allow.
        edges.push(stableEdge("ai_access", domainNode.id, "reads"));
      }
    } else if (state.aiAccess === "broad") {
      for (const domainNode of domainNodes) {
        policies.push(
          policyObject(
            "ai_access",
            "agent",
            "read",
            "table",
            domainNode.id,
            "",
            "allow",
            "secrets always denied",
            "broad access excluding secrets"
          )
        );
        edges.push(stableEdge("ai_access", domainNode.id, "reads"));
      }
      // Always deny secret resources if any secret nodes exist later.
      policies.push(
        policyObject(
          "ai_access",
          "agent",
          "read",
          "secret",
          "*",
          "",
          "deny",
          "",
          "secrets are always denied"
        )
      );
    }
  }

  // Runtime deployment node (internal id may remain technical; visible name is human-facing)
  const runtimeNode = node(
    "runtime",
    runtimeMeta.name,
    "deployment",
    runtimeMeta.description,
    545,
    1032,
    [["target", runtimeMeta.target], ["status", "planned"]]
  );
  edges.push(stableEdge("runtime", primaryDomain.id, "deploys_to"));

  const graph = {
    version: "0.1.0",
    app: {
      name: state.name.trim(),
      description: buildAppDescription(state)
    },
    nodes: [applicationNode, ...surfaceNodes, audienceNode, ...domainNodes, ...agentNodes, runtimeNode],
    edges,
    principals: [...humanPrincipals, ...surfacePrincipals, ...agentPrincipals],
    policies,
    routes: surfaceRoutes,
    deployments: [
      {
        id: "runtime",
        name: runtimeMeta.name,
        target: runtimeMeta.target,
        environment: "production"
      }
    ]
  };

  layoutOnboardingGraph(graph, state);
  applyOnboardingPresentation(graph);
  assertNoForbiddenVisibleTerms(graph);
  return graph;
}

export function summarizeOnboardingState(state) {
  const appType = APP_TYPE_OPTIONS.find((item) => item.id === state.appType);
  const audience = AUDIENCE_OPTIONS.find((item) => item.id === state.audience);
  const ai = AI_ACCESS_OPTIONS.find((item) => item.id === state.aiAccess);
  const runtime = RUNTIME_OPTIONS.find((item) => item.id === state.runtime);
  const domains = (state.dataDomains || [])
    .map((id) => DATA_DOMAIN_OPTIONS.find((item) => item.id === id)?.label || id)
    .filter(Boolean);

  return {
    appType: appType?.label || "",
    dataDomains: domains,
    audience: audience?.label || "",
    aiAccess: ai?.label || "",
    runtime: runtime?.label || "",
    name: typeof state.name === "string" ? state.name.trim() : ""
  };
}

export function optionIds(options) {
  return options.map((item) => item.id);
}

function baseTemplateKey(appType) {
  if (appType === "customer_app" || appType === "internal_tool") return "saas";
  if (appType === "ai_app") return "privateAgent";
  if (appType === "data_pipeline") return "telemetry";
  return "saas";
}

function createDomainNode(domainId, index, baseTemplate) {
  const x = 120 + (index % 3) * 240;
  const y = 652;
  switch (domainId) {
    case "accounts": {
      const fields = fieldPairsFrom(baseTemplate, "users") || [["id", "uuid primary key"], ["email", "text not null"], ["display_name", "text"]];
      return node("accounts", DOMAIN_RESOURCE_LABELS.accounts, "table", "People, profiles, and sign-in.", x, y, fields);
    }
    case "records": {
      const fromSaas = fieldPairsFrom(baseTemplate, "projects_data");
      const fromPrivate = fieldPairsFrom(baseTemplate, "customer_records");
      const fields = fromSaas || fromPrivate || [
        ["id", "uuid primary key"],
        ["name", "text not null"],
        ["details", "text"],
        ["private_notes", "text"]
      ];
      return node("app_data", DOMAIN_RESOURCE_LABELS.records, "table", "The core information your app manages.", x, y, fields);
    }
    case "files":
      return node("files", DOMAIN_RESOURCE_LABELS.files, "table", "Uploads, documents, and media.", x, y, [
        ["id", "uuid primary key"],
        ["name", "text not null"],
        ["content_type", "text"],
        ["size_bytes", "bigint"]
      ]);
    case "events": {
      const fields = fieldPairsFrom(baseTemplate, "telemetry_readings") || [
        ["id", "bigint generated always as identity primary key"],
        ["event_id", "text not null unique"],
        ["occurred_at", "timestamptz not null"],
        ["measurement_value", "double precision"],
        ["payload", "jsonb"]
      ];
      return node("events", DOMAIN_RESOURCE_LABELS.events, "table", "Activity, measurements, or time-series information.", x, y, fields);
    }
    case "payments":
      return node("payments", DOMAIN_RESOURCE_LABELS.payments, "table", "Plans, purchases, and billing records.", x, y, [
        ["id", "uuid primary key"],
        ["plan", "text"],
        ["amount_cents", "integer"],
        ["status", "text not null"]
      ]);
    default:
      throw new Error(`unknown data domain: ${domainId}`);
  }
}

function fieldPairsFrom(graph, nodeId) {
  const found = (graph?.nodes || []).find((item) => item.id === nodeId);
  if (!found?.fields?.length) return null;
  return found.fields.map((field) => [field.name, field.type]);
}

function audiencePrincipals(audience) {
  switch (audience) {
    case "only_me":
      return [principal("owner", "human", "Only me")];
    case "team":
      return [
        principal("member", "human", "Team Access"),
        principal("admin", "human", "Admin")
      ];
    case "customers":
      return [
        principal("customer", "human", "Customer Access"),
        principal("admin", "human", "Admin")
      ];
    case "public":
      return [
        principal("public_user", "human", "Public users"),
        principal("anonymous", "anonymous", "Anonymous")
      ];
    default:
      return [principal("owner", "human", "Only me")];
  }
}

function audienceAuthLabel(audience) {
  switch (audience) {
    case "only_me":
      return "owner session";
    case "team":
      return "team session";
    case "customers":
      return "customer session";
    case "public":
      return "public or signed-in session";
    default:
      return "signed-in session";
  }
}

function audienceCondition(audience) {
  switch (audience) {
    case "only_me":
      return "owner session";
    case "team":
      return "team membership required";
    case "customers":
      return "customer account required";
    case "public":
      return "public access boundary";
    default:
      return "signed-in session";
  }
}

function applicationDescription(appType) {
  switch (appType) {
    case "customer_app":
      return "Customer-facing application entry.";
    case "internal_tool":
      return "Internal team application entry.";
    case "ai_app":
      return "AI application entry.";
    case "data_pipeline":
      return "Data pipeline application entry.";
    default:
      return "Application entry.";
  }
}

function applicationSurfaceName(appType) {
  switch (appType) {
    case "customer_app":
      return "Customer Experience";
    case "internal_tool":
      return "Team Workspace";
    case "data_pipeline":
      return "Monitoring View";
    default:
      return "App Experience";
  }
}

function audienceNodeName(audience) {
  switch (audience) {
    case "only_me":
      return "Private Access";
    case "team":
      return "Team Access";
    case "customers":
      return "Customer Access";
    case "public":
      return "Public Access";
    default:
      return "Access";
  }
}

function audienceNodeDescription(audience) {
  switch (audience) {
    case "only_me":
      return "Only the owner can enter.";
    case "team":
      return "Team membership controls entry.";
    case "customers":
      return "Customer accounts control entry.";
    case "public":
      return "The application can be opened publicly.";
    default:
      return "Controls who can enter.";
  }
}

function aiNodeDescription(aiAccess) {
  switch (aiAccess) {
    case "structure":
      return "Agents can understand the shape, never rows.";
    case "approved":
      return "Agents receive only fields you allow.";
    case "broad":
      return "Broad access with secrets always denied.";
    default:
      return "Controlled agent access.";
  }
}

function buildAppDescription(state) {
  const summary = summarizeOnboardingState(state);
  const domains = summary.dataDomains.join(", ") || "selected data";
  return [
    `${summary.name} backend graph.`,
    `Building: ${summary.appType}.`,
    `Remembers: ${domains}.`,
    `Audience: ${summary.audience}.`,
    `AI access: ${summary.aiAccess}.`,
    `Runtime: ${summary.runtime}.`
  ].join(" ");
}

function layoutOnboardingGraph(graph, state) {
  const positions = {
    app_domain: [545, 92],
    dashboard_page: state.appType === "data_pipeline" ? [180, 242] : [365, 242],
    api_device_ingest: [545, 242],
    api_agent_query: [545, 242],
    audience_access: [545, 412],
    ai_access: [545, 842],
    runtime: [545, 1032]
  };

  const domainIds = (graph.nodes || [])
    .filter((item) => ["table", "secret"].includes(item.type))
    .map((item) => item.id);
  const nodeWidth = 190;
  const gap = 30;
  const totalWidth = domainIds.length * nodeWidth + Math.max(0, domainIds.length - 1) * gap;
  const startX = Math.max(24, (1280 - totalWidth) / 2);
  domainIds.forEach((id, index) => {
    positions[id] = [startX + index * (nodeWidth + gap), 652];
  });

  for (const item of graph.nodes || []) {
    const position = positions[item.id];
    if (!position) continue;
    item.x = position[0];
    item.y = position[1];
  }
}

function applyOnboardingPresentation(graph) {
  const labels = {
    domain: "app",
    page: "experience",
    api: "connection",
    table: "data",
    agent: "AI",
    deployment: "runtime"
  };
  for (const item of graph.nodes || []) {
    item.display_type = labels[item.type] || item.type;
    if (item.id === "audience_access") item.display_type = "access";
    item.hide_fields = true;
  }
}

function assertNoForbiddenVisibleTerms(graph) {
  const haystacks = [];
  haystacks.push(graph.app?.name || "", graph.app?.description || "");
  for (const item of graph.nodes || []) {
    haystacks.push(item.name || "", item.description || "");
  }
  for (const item of graph.deployments || []) {
    haystacks.push(item.name || "", item.target || "");
  }
  const joined = haystacks.join("\n").toLowerCase();
  for (const term of FORBIDDEN_VISIBLE_TERMS) {
    if (joined.includes(term)) {
      throw new Error(`generated graph contains forbidden visible term: ${term}`);
    }
  }
}

function unique(values) {
  return [...new Set(values)];
}
