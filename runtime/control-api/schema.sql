create table if not exists accounts (
  id text primary key,
  name text not null,
  created_at timestamptz not null
);

create table if not exists users (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  email text not null unique,
  created_at timestamptz not null
);

create table if not exists sessions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null
);

create table if not exists projects (
  id text primary key,
  account_id text not null references accounts(id) on delete cascade,
  name text not null,
  created_by text not null references users(id),
  created_at timestamptz not null
);

create table if not exists project_members (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null,
  created_at timestamptz not null,
  unique(project_id, user_id)
);

create table if not exists graph_versions (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  baseplane_json jsonb not null,
  created_by text not null references users(id),
  created_at timestamptz not null
);

create table if not exists backend_instances (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  graph_version_id text not null references graph_versions(id) on delete cascade,
  provider text not null,
  schema_name text not null,
  status text not null,
  api_url text not null,
  created_at timestamptz not null
);

create table if not exists deploy_requests (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  graph_version_id text not null references graph_versions(id) on delete cascade,
  status text not null,
  logs jsonb not null default '[]'::jsonb,
  backend_instance_id text references backend_instances(id),
  created_by text not null references users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table if not exists field_access_levels (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  table_id text not null,
  field text not null,
  access text not null,
  graph_version_id text not null references graph_versions(id) on delete cascade,
  created_at timestamptz not null,
  unique(project_id, graph_version_id, table_id, field)
);

create table if not exists rows (
  project_id text not null references projects(id) on delete cascade,
  table_id text not null,
  row_id text not null,
  data jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key(project_id, table_id, row_id)
);

create table if not exists audit_events (
  id text primary key,
  project_id text not null references projects(id) on delete cascade,
  timestamp timestamptz not null,
  actor_type text not null,
  actor_id text not null,
  action text not null,
  resource text not null,
  field text not null default '',
  decision text not null,
  reason text not null
);

create index if not exists idx_graph_versions_project_created on graph_versions(project_id, created_at);
create index if not exists idx_deploy_requests_project_created on deploy_requests(project_id, created_at);
create index if not exists idx_backend_instances_project_created on backend_instances(project_id, created_at);
create index if not exists idx_audit_events_project_timestamp on audit_events(project_id, timestamp);
