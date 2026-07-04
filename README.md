# Baseplane

Baseplane is a one-page backend workbench where the graph is the source of truth.

The current app is intentionally client-side:

- no database credentials
- no service-role keys
- no hosted-backend API calls
- no customer data collection

It models backend systems as:

- nodes: tables, auth, functions, devices, secrets, websites, agents, deployments
- edges: reads, writes, owns, validates, executes, inserts, publishes, exports
- policies: human, organization, agent, device, and service permissions

## Run Locally

```bash
cd work/baseplane
python3 -m http.server 8130
```

Open:

```txt
http://127.0.0.1:8130/
```

## Alpha Flow

1. Open `/app`.
2. Choose the research telemetry, SaaS, or device telemetry template.
3. Drag nodes around.
4. Select nodes to edit fields and policies.
5. Test an actor/resource request in the policy simulator.
6. Export the backend package.

Exported files:

- `baseplane.json`
- `schema.sql`
- `rls_policies.sql`
- `agent_policies.json`
- `README.md`

## Product Boundary

Baseplane owns the blueprint and permission graph. The customer owns the data plane.

Deployment targets later:

- Supabase
- self-hosted Postgres
- local Docker
- private server
- Baseplane managed

## CLI

```bash
npm test
node cli/baseplane.js validate --file examples/research/baseplane.json
node cli/baseplane.js generate --file examples/research/baseplane.json --out generated
node cli/baseplane.js test-policies --file examples/research/baseplane.json
```
