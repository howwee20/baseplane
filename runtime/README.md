# Baseplane Runtime

Baseplane Runtime is the self-hosted data plane target for the graph.

The current alpha does not run production hosting. This folder defines the shape of the open-source runtime that the graph will compile toward.

## Runtime Components

- Postgres: durable relational data store.
- Policy gateway: checks every agent/service request against `baseplane.json`.
- API gateway: exposes route and function contracts.
- Audit log: records allow/deny decisions.
- Secrets boundary: keeps secrets denied unless explicitly allowed.
- Local model gateway: optional future boundary for local inference.

## Trust Boundary

Agents should not connect directly to the raw database.

The intended flow is:

```txt
agent request
  -> Baseplane Agent Gateway
  -> policy check
  -> allowed fields only
  -> audit log
  -> database/API response
```

## Local Control API

The local Control API is the first managed-backend slice. It uses the compiler and policy engine, stores data in a local JSON file, and exposes the same shape that a hosted Baseplane API will expose later.

Run local file-backed mode:

```bash
npm run control-api
```

Default API:

```txt
http://127.0.0.1:8790
```

Run Postgres-backed mode:

```bash
CONTROL_DATABASE_URL=postgres://baseplane:baseplane_local_only@127.0.0.1:54329/baseplane_app \
CONTROL_DATABASE_SSL=false \
npm run control-api
```

Or with Docker:

```bash
docker compose -f runtime/docker-compose.yml up postgres control-api
```

Hosted environment variables:

```txt
CONTROL_DATABASE_URL
BASEPLANE_PUBLIC_API_URL
SESSION_SECRET
CORS_ORIGIN
CONTROL_DATABASE_SSL
```

What it supports now:

- alpha sign-in sessions
- projects
- graph versions
- deploy requests
- backend instances
- Postgres control database persistence
- table rows
- field access levels
- server-side redaction
- audit events

The Studio can still run without this API. When the API is available, Deploy creates a real local backend instance and Rows switch from browser preview rows to API rows.

## Studio API Target

The Studio defaults to:

```txt
http://127.0.0.1:8790
```

For hosted alpha testing, point the public Studio at a hosted Control API with:

```txt
https://howwee20.github.io/baseplane/app/?api=https://your-control-api.example
```

or provide:

```js
window.BASEPLANE_CONFIG = {
  apiUrl: "https://your-control-api.example"
};
```

## Alpha Status

This runtime is an alpha control-plane implementation, not production hosting.

No production credentials belong in this repo.
