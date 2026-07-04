# Baseplane

Baseplane is a full-stack permission graph.

It models domains, routes, pages, APIs, tables, functions, secrets, devices, deployments, humans, and AI agents as one machine-readable graph.

The graph compiles into backend infrastructure artifacts: SQL, RLS policies, route contracts, agent gateway policies, function contracts, policy tests, and deploy plans.

Baseplane owns the blueprint. The customer owns the data plane.

## Current Boundary

The current app and CLI are intentionally local-first:

- no customer credentials
- no hosted-backend API calls
- no customer data collection
- no destructive apply command
- no managed infrastructure claim

The product promise right now is: design and export a permissioned backend.

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
node cli/baseplane.js introspect --help
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
