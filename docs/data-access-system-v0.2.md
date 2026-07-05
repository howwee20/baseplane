# Atoll Data Access System v0.2

Atoll is a managed backend system for untrusted actors.

The core claim is narrow: agents should be able to build against backend structure without receiving protected production values.

## Product Primitive

An exposure is a plaintext value returned to an actor.

Atoll controls exposure by separating:

- structure: tables, fields, types, relationships, routes
- values: row contents
- authority: rights to read, write, filter, export, or administer

The central question is:

```txt
What did this actor receive?
```

## Actors

An actor is anything that requests access:

- owner
- end user
- administrator
- support agent
- service key
- device
- webhook
- coding agent
- analysis agent
- deployment process

Atoll does not grant access because an actor is human or deny access because an actor is machine. The server evaluates the actor, route, requested operation, requested fields, and project policy.

## Objects

- project: a backend
- table: stores rows
- field: belongs to a table and has a visibility level
- row: contains values
- route: controlled opening to state
- actor: requester
- rule: allowed operation binding
- audit event: recorded access decision
- deploy: makes the graph real

These objects form one graph. The graph is the control surface, not decoration.

## Visibility Levels

- public: may be returned to any actor with route access
- private: may be returned only inside defined scope
- protected: withheld from untrusted or limited actors
- secret: not returned through ordinary reads
- blind: ciphertext Atoll cannot read, filter, sort, or recover

Protected and secret values are withheld before transmission. They are not hidden by the client after receipt.

Example projection:

```json
{
  "portfolio_value": 482901114,
  "alpha_signal": "[protected]",
  "private_notes": "[protected]",
  "api_token": "[secret]"
}
```

## Complete Mediation

Every read and write passes through the Atoll API.

For each request, the server evaluates:

- actor
- route
- table
- fields
- operation
- rules
- visibility levels
- project policy

The result is allowed, partially allowed, or denied. Every result creates an audit event.

If the actor must not know a value, the value must not cross the wire.

## Query Surface

Hidden fields must also be removed from filtering, sorting, grouping, matching, and error behavior.

If an actor cannot read a field, the actor cannot use that field to infer.

## Agent Lockout

A coding agent can receive:

- table names
- field names
- field types
- relationships
- route shapes
- access levels
- allowed operations
- synthetic fixtures
- migration history

The same actor cannot receive:

- protected production values
- secret fields
- credentials
- private notes
- blocked rows
- exports outside scope
- query results shaped by unreadable fields

## Audit Receipts

The graph is the interface.
The database is the substrate.
The receipt is the proof.

An Agent Session Receipt records:

- project
- actor
- route
- operation
- table
- fields requested
- fields returned
- fields blocked
- decision
- reason
- time

Example:

```txt
Actor: coding_agent
Project: enterprise_portfolio_backend
Session: x8k2

Schema inspected:
  accounts, orgs, users, portfolios, positions, orders

Values returned:
  portfolio_value

Values blocked:
  alpha_signal
  private_notes
  pii_fields
  api_keys

Denied queries:
  filter positions by alpha_signal
  export private_notes
  read api_keys

Result:
  3 protected fields blocked
  1 secret field blocked
  0 secret values returned
```

The public product moment is:

```txt
coding_agent asks -> protected values do not cross the wire -> audit receipt proves it
```

## Non-Goals

Atoll is not:

- an analytics platform
- a model host
- an inference engine
- a data warehouse
- a recommendation system
- a business intelligence suite

Atoll holds state, enforces access, exposes structure, blocks values, records decisions, and permits exit.

## Honest Limit

Atoll can prove what Atoll exposed.

It cannot prove that data was not exposed through another credential, screenshot, repository, user action, or system outside Atoll.
