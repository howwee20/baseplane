# Atoll Managed Alpha Plan

Atoll Studio is the graph interface. The Atoll Control API is the hosted control plane that turns the graph into real customer backends.

The public GitHub Pages app is not enough for real customer sign-in or database provisioning. It can safely run the graph UI, policy simulator, compiler, and export flow. It cannot safely own customer sessions, secrets, deploy credentials, billing, or database creation by itself.

## Product Boundary

Current public product:

- graph-first Studio
- `baseplane.json` source of truth
- SQL, RLS, route, function, agent-gateway, test, README, and deploy-plan export
- policy simulator for allow/deny decisions
- local runtime skeleton

Managed alpha must add:

- customer accounts
- projects and project membership
- graph version history
- hosted backend requests
- deploy previews
- provisioning worker
- isolated backend instances
- secrets management
- audit logs
- backups and restore metadata

## Required Control Plane

Atoll needs its own control-plane database. This stores product metadata, not customer production rows.

Core tables:

```txt
accounts
users
sessions
projects
project_members
graph_versions
deploy_requests
backend_instances
secrets_references
audit_events
billing_customers
```

The control plane answers:

```txt
Who is signed in?
Which projects can they access?
Which graph version is current?
What deploy request was approved?
Which backend instance belongs to the project?
What did the system do and when?
```

## Required Data Plane

Each customer project needs an isolated data plane. The data plane is where the customer app data lives.

Minimum target:

```txt
Postgres database
Auth/session tables or external auth integration
RLS policies generated from baseplane.json
API/function runner
Object storage later
Backups
Logs
Agent gateway policy
```

Atoll should not mix customer production rows into the control-plane database unless the customer explicitly chooses a shared managed mode.

## Customer Flow

1. Customer signs in.
2. Customer creates a project.
3. Customer clicks `New Backend`.
4. Customer chooses:
   - start from template
   - connect existing backend
   - request hosted backend
5. Studio generates the graph and deploy preview.
6. Customer runs policy simulation.
7. Customer exports package or requests hosted setup.
8. Provisioner creates an isolated backend instance.
9. Atoll stores deployment metadata and audit events.
10. Customer sees database, auth, routes, policies, and agent access as one graph.

## Sign-In Implementation

Do not build fake auth into the static site.

Real sign-in needs:

- server-side session validation
- email/password or OAuth provider
- project membership checks
- invite flow
- audit event on login/logout
- API authorization middleware

Fastest credible V0:

```txt
Atoll frontend on GitHub Pages or Vercel
Atoll Control API on Fly.io, Railway, Render, or Supabase Edge Functions
Control-plane Postgres
Auth provider: Auth.js, Clerk, Supabase Auth, or self-hosted GoTrue
Provision worker: queue-backed Node service
```

Most ownership-heavy V1:

```txt
Atoll frontend
Atoll API
self-hosted Postgres control plane
self-hosted auth
Docker-based provisioner
customer-isolated Postgres instances
S3-compatible object storage
OpenTelemetry logs
scheduled backups
```

## Provisioning Worker

The provisioner is the service that makes `Request hosted backend` real.

It should:

- read an approved deploy request
- create database and role credentials
- apply generated SQL
- apply generated RLS policies
- create route/function skeletons
- register secrets in a secrets manager
- store instance metadata in `backend_instances`
- write audit events for every action
- never expose service credentials to the browser

## Security Rules

- Browser receives only public project metadata and signed session tokens.
- Service-role credentials never enter frontend code.
- Customer data plane is isolated per project.
- Secrets are reference-only in the graph.
- Default access is deny.
- Agent access is field-scoped and logged.
- Every deploy request gets a preview before apply.
- Every apply operation writes an audit event.
- Destructive changes require explicit approval.

## Next Build Order

1. Add a real Control API.
2. Add auth and sessions.
3. Add project creation and membership.
4. Save graph versions to the control-plane database.
5. Turn hosted backend requests into database records.
6. Add a deploy worker that can run in dry-run mode first.
7. Provision isolated Postgres instances.
8. Add audit event UI to the graph.
9. Add backup metadata and restore checks.
10. Add billing only after the provisioner and audit path are reliable.

## Machine Read

```txt
Studio = graph UI
baseplane.json = source of truth
Compiler = graph to backend artifacts
Control plane = users, projects, graph versions, deploy requests, audit
Data plane = customer database, auth, functions, storage, logs
Provisioner = creates and updates data planes
Agent gate = enforces scoped AI access
```
