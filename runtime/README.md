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

## Alpha Status

This runtime is a skeleton. Use it as a deployment target contract, not a production stack.

No production credentials belong in this repo.
