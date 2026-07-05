# Atoll Managed v0 Roadmap

Atoll is a managed database where the control plane is visible and the data plane is protected.

The product model:

```txt
Store data.
Hold it safely.
Control access visually.
```

## Two Planes

```txt
Control plane
  graph
  schema
  routes
  policies
  deploy requests
  audit events
  agent permissions

Data plane
  rows
  files
  secrets
  protected fields
  customer-owned values
```

Atoll lets people and agents operate on the control plane. The data plane is locked behind access rules.

## Access Levels

Every field should have one of these levels:

```txt
public
  visible to ordinary allowed readers

private
  visible through project membership or route policy

protected
  visible only to an owner or approved local/private execution path

secret
  never exposed as raw data through Studio or agents
```

Machine rule:

```txt
Agents can inspect structure.
Agents cannot read protected rows or secrets.
```

## Current Alpha Behavior

The public Studio now includes:

- graph source of truth
- level-locked draggable nodes
- deploy preview
- policy simulator
- field access levels
- local rows preview
- actor-based redaction
- browser-local row storage only

The local rows preview is not a hosted database. It is a safe way to prove the access model before the Atoll Control API is hosted.

## Managed v0 Build

The first real hosted version should do only this:

1. User signs in.
2. User creates a project.
3. User selects a template.
4. Atoll creates the graph.
5. User clicks `Deploy`.
6. Provisioner creates an isolated Postgres database.
7. Compiler applies SQL and RLS.
8. User adds rows.
9. User sets field access levels visually.
10. Agent can inspect the graph but protected rows are redacted or blocked.

That is the product proof.

## Required Services

```txt
Atoll Web
  graph UI
  rows UI
  access UI
  deploy UI

Atoll Control API
  sessions
  projects
  graph versions
  deploy requests
  audit events

Provisioner Worker
  create database
  apply SQL
  apply RLS
  register secrets
  record deploy result

Data Plane
  isolated Postgres per project or per tenant
  rows
  policies
  backups
  logs

Agent Gateway
  allow schema inspection
  deny protected rows
  deny secrets
  log every denied request
```

## Non-Negotiable Rule

Every visible thing must compile into a real effect.

```txt
Table box -> storage for rows
Field badge -> access behavior
Route box -> access path
Agent box -> scoped identity
Secret box -> deny by default
Line -> read/write/call permission
Deploy -> provision or dry-run plan
```

No decorative backend graph.

## Next Engineering Step

Build the Control API first.

Minimum database tables:

```txt
accounts
users
sessions
projects
project_members
graph_versions
deploy_requests
backend_instances
field_access_rules
audit_events
```

The public Studio can then replace localStorage rows with authenticated project rows and real deploy requests.
