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

Run it:

```bash
npm run control-api
```

Default API:

```txt
http://127.0.0.1:8790
```

What it supports now:

- alpha sign-in sessions
- projects
- graph versions
- deploy requests
- backend instances
- table rows
- field access levels
- server-side redaction
- audit events

The Studio can still run without this API. When the API is available, Deploy creates a real local backend instance and Rows switch from browser preview rows to API rows.

## Alpha Status

This runtime is an alpha control-plane implementation, not production hosting.

No production credentials belong in this repo.
