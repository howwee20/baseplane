# Baseplane

Baseplane is a full-stack permission graph.

It models domains, routes, pages, APIs, tables, functions, secrets, devices, deployments, humans, and AI agents as one machine-readable graph.

The graph compiles into backend infrastructure artifacts: SQL, RLS policies, route contracts, agent gateway policies, function contracts, policy tests, and deploy plans.

Baseplane owns the blueprint. The customer owns the data plane.

## Alpha Surface

- Studio: graph-first browser UI in `/app`.
- Compiler: turns `baseplane.json` into backend artifacts.
- Policy simulator: explains allow/deny decisions.
- Agent Gateway V0: checks agent requests against the graph before data access.
- Runtime skeleton: documents the self-hosted target shape.
- Introspection starter: converts local SQL schema files into a starting graph.
- Cloud Preview plan: documents the hosted sign-in, project, deploy request, and provisioner path.

## Current Boundary

The current app and CLI are intentionally local-first:

- no customer credentials
- no hosted-backend API calls
- no customer data collection
- no destructive apply command
- no managed infrastructure claim

The product promise right now is: design and export a permissioned backend.

Real customer sign-in and database spin-up require Baseplane Cloud: a hosted control API, control-plane database, auth/session service, deploy worker, isolated customer data planes, secrets boundary, and audit logs. See `docs/cloud-preview-plan.md`.

## Run Locally

```bash
npm test
npm run serve
```

Open:

```txt
http://127.0.0.1:8130/
http://127.0.0.1:8130/app/
```

## CLI

```bash
node cli/baseplane.js validate examples/generic-telemetry/baseplane.json
node cli/baseplane.js generate examples/generic-telemetry/baseplane.json --out generated
node cli/baseplane.js test-policies examples/generic-telemetry/baseplane.json
node cli/baseplane.js diff examples/generic-telemetry/baseplane.json
node cli/baseplane.js apply --dry-run examples/generic-telemetry/baseplane.json
node cli/baseplane.js introspect --schema ./schema.sql --out ./baseplane.json
```

Generated package:

- `baseplane.json`
- `schema.sql`
- `rls_policies.sql`
- `route_contracts.md`
- `function_stubs.md`
- `agent_gateway_policy.json`
- `policy_tests.json`
- `deploy_plan.md`
- `README.md`

## Agent Gateway V0

Agent Gateway V0 is a local authorization primitive. It does not query production data.

It answers:

```txt
Can this agent/service/human perform this action on this table or field?
```

Example:

```js
import { authorizeAgentRequest, redactRecord } from "./packages/agent-gateway/index.js";

const authorization = authorizeAgentRequest(graph, {
  agent_id: "analysis_agent",
  action: "read",
  resource: "telemetry_readings",
  fields: ["timestamp", "measurement_value"]
});

const safeRecord = redactRecord(row, authorization);
```

Runtime skeleton:

```bash
docker compose -f runtime/docker-compose.yml up
curl http://127.0.0.1:8787/health
```

## Introspection

The public alpha introspects local SQL files, not live databases:

```bash
node cli/baseplane.js introspect --schema ./schema.sql --out ./baseplane.json
```

Direct `--database-url` introspection is intentionally disabled until the credential boundary is hardened.

## Graph Model

`baseplane.json` is the source of truth.

```json
{
  "version": "0.1.0",
  "app": {
    "name": "Generic Telemetry App",
    "description": "A private telemetry backend with scoped human and agent access."
  },
  "nodes": [],
  "edges": [],
  "principals": [],
  "policies": [],
  "routes": [],
  "deployments": []
}
```

The anti-slop rule:

```txt
If it is on the graph, it must become code, policy, or documentation.
```

## Trust Rules

- no policy means deny
- secret nodes are denied unless explicitly allowed
- private fields are denied unless explicitly allowed
- agent row access is denied unless explicitly allowed
- schema inspection is separate from row reading
- route access is separate from database access
- write access is separate from read access

## Examples

- `examples/generic-telemetry/baseplane.json`
- `examples/generic-saas/baseplane.json`
- `examples/private-agent/baseplane.json`

These are generic examples only. Baseplane is a separate product and does not contain customer-specific schemas, credentials, or production data.
