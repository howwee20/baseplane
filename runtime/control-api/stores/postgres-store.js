import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");

export function createPostgresControlStore(options = {}) {
  if (!options.databaseUrl) throw new Error("databaseUrl is required");

  let poolPromise = null;
  let migrated = false;

  async function pool() {
    if (!poolPromise) {
      poolPromise = import("pg").then(({ Pool }) => new Pool({
        connectionString: options.databaseUrl,
        ssl: options.ssl === false ? false : options.ssl
      }));
    }
    return poolPromise;
  }

  async function query(text, values = []) {
    await migrate();
    const db = await pool();
    return db.query(text, values);
  }

  async function migrate() {
    if (migrated) return;
    const db = await pool();
    await db.query(fs.readFileSync(schemaPath, "utf8"));
    await db.query(
      "insert into accounts (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing",
      ["account_managed_alpha", "Atoll Managed Alpha", now()]
    );
    migrated = true;
  }

  function accountRecord() {
    return { id: "account_managed_alpha", name: "Atoll Managed Alpha", created_at: now() };
  }

  return {
    kind: "postgres",
    async health() {
      const db = await pool();
      await migrate();
      await db.query("select 1");
      return { ok: true, mode: "postgres" };
    },
    async account() {
      await migrate();
      const result = await query("select id, name, created_at from accounts where id = $1", ["account_managed_alpha"]);
      return result.rows[0] || accountRecord();
    },
    async upsertUser(email) {
      const id = options.id("user");
      const result = await query(`
        insert into users (id, account_id, email, created_at)
        values ($1, $2, $3, $4)
        on conflict (email) do update set email = excluded.email
        returning id, account_id, email, created_at
      `, [id, "account_managed_alpha", email, now()]);
      return result.rows[0];
    },
    async createSession(userId, tokenHash) {
      const session = { id: options.id("session"), user_id: userId, token_hash: tokenHash, created_at: now() };
      await query("insert into sessions (id, user_id, token_hash, created_at) values ($1, $2, $3, $4)", [
        session.id,
        session.user_id,
        session.token_hash,
        session.created_at
      ]);
      return session;
    },
    async findSession(tokenHash) {
      const result = await query(`
        select
          s.id as session_id,
          s.user_id as session_user_id,
          s.token_hash,
          s.created_at as session_created_at,
          u.id as user_id,
          u.account_id,
          u.email,
          u.created_at as user_created_at
        from sessions s
        join users u on u.id = s.user_id
        where s.token_hash = $1
      `, [tokenHash]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        session: {
          id: row.session_id,
          user_id: row.session_user_id,
          token_hash: row.token_hash,
          created_at: row.session_created_at
        },
        user: {
          id: row.user_id,
          account_id: row.account_id,
          email: row.email,
          created_at: row.user_created_at
        }
      };
    },
    async createProject(project) {
      const result = await query(`
        insert into projects (id, account_id, name, created_by, created_at)
        values ($1, $2, $3, $4, $5)
        returning id, account_id, name, created_by, created_at
      `, [project.id, project.account_id, project.name, project.created_by, project.created_at]);
      return result.rows[0];
    },
    async addProjectMember(member) {
      const result = await query(`
        insert into project_members (id, project_id, user_id, role, created_at)
        values ($1, $2, $3, $4, $5)
        on conflict (project_id, user_id) do update set role = excluded.role
        returning id, project_id, user_id, role, created_at
      `, [member.id, member.project_id, member.user_id, member.role, member.created_at]);
      return result.rows[0];
    },
    async findProject(projectId) {
      const result = await query("select id, account_id, name, created_by, created_at from projects where id = $1", [projectId]);
      return result.rows[0] || null;
    },
    async createGraphVersion(version) {
      const result = await query(`
        insert into graph_versions (id, project_id, baseplane_json, created_by, created_at)
        values ($1, $2, $3::jsonb, $4, $5)
        returning id, project_id, baseplane_json, created_by, created_at
      `, [version.id, version.project_id, JSON.stringify(version.baseplane_json), version.created_by, version.created_at]);
      return result.rows[0];
    },
    async getGraphVersion(projectId, graphVersionId) {
      const result = await query(`
        select id, project_id, baseplane_json, created_by, created_at
        from graph_versions
        where project_id = $1 and id = $2
      `, [projectId, graphVersionId]);
      return result.rows[0] || null;
    },
    async latestGraphVersion(projectId) {
      const result = await query(`
        select id, project_id, baseplane_json, created_by, created_at
        from graph_versions
        where project_id = $1
        order by created_at desc, id desc
        limit 1
      `, [projectId]);
      return result.rows[0] || null;
    },
    async createDeployRequest(record) {
      const result = await query(`
        insert into deploy_requests (id, project_id, graph_version_id, status, logs, backend_instance_id, created_by, created_at, updated_at)
        values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
        returning id, project_id, graph_version_id, status, logs, backend_instance_id, created_by, created_at, updated_at
      `, [
        record.id,
        record.project_id,
        record.graph_version_id,
        record.status,
        JSON.stringify(record.logs || []),
        record.backend_instance_id || null,
        record.created_by,
        record.created_at,
        record.updated_at
      ]);
      return normalizeDeployRequest(result.rows[0]);
    },
    async updateDeployRequest(record) {
      const result = await query(`
        update deploy_requests
        set status = $2, logs = $3::jsonb, backend_instance_id = $4, updated_at = $5
        where id = $1
        returning id, project_id, graph_version_id, status, logs, backend_instance_id, created_by, created_at, updated_at
      `, [record.id, record.status, JSON.stringify(record.logs || []), record.backend_instance_id || null, record.updated_at]);
      return normalizeDeployRequest(result.rows[0]);
    },
    async latestDeployRequest(projectId) {
      const result = await query(`
        select id, project_id, graph_version_id, status, logs, backend_instance_id, created_by, created_at, updated_at
        from deploy_requests
        where project_id = $1
        order by created_at desc, id desc
        limit 1
      `, [projectId]);
      return result.rows[0] ? normalizeDeployRequest(result.rows[0]) : null;
    },
    async createBackendInstance(backend) {
      const result = await query(`
        insert into backend_instances (id, project_id, graph_version_id, provider, schema_name, status, api_url, created_at)
        values ($1, $2, $3, $4, $5, $6, $7, $8)
        returning id, project_id, graph_version_id, provider, schema_name, status, api_url, created_at
      `, [
        backend.id,
        backend.project_id,
        backend.graph_version_id,
        backend.provider,
        backend.schema,
        backend.status,
        backend.api_url,
        backend.created_at
      ]);
      return normalizeBackend(result.rows[0]);
    },
    async latestBackendInstance(projectId) {
      const result = await query(`
        select id, project_id, graph_version_id, provider, schema_name, status, api_url, created_at
        from backend_instances
        where project_id = $1
        order by created_at desc, id desc
        limit 1
      `, [projectId]);
      return result.rows[0] ? normalizeBackend(result.rows[0]) : null;
    },
    async ensureRowsForTables(_projectId, _tables) {
      await migrate();
    },
    async addFieldAccessLevels(levels) {
      for (const level of levels) {
        await query(`
          insert into field_access_levels (id, project_id, table_id, field, access, graph_version_id, created_at)
          values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (project_id, graph_version_id, table_id, field)
          do update set access = excluded.access
        `, [level.id, level.project_id, level.table_id, level.field, level.access, level.graph_version_id, level.created_at]);
      }
    },
    async listAuditEvents(projectId, limit = 200) {
      const result = await query(`
        select id, project_id, timestamp, actor_type, actor_id, action, resource, field, decision, reason
        from audit_events
        where project_id = $1
        order by timestamp desc, id desc
        limit $2
      `, [projectId, limit]);
      return result.rows;
    },
    async addAuditEvent(event) {
      await query(`
        insert into audit_events (id, project_id, timestamp, actor_type, actor_id, action, resource, field, decision, reason)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [
        event.id,
        event.project_id,
        event.timestamp,
        event.actor_type,
        event.actor_id,
        event.action,
        event.resource,
        event.field || "",
        event.decision,
        event.reason
      ]);
      return event;
    },
    async getRows(projectId, tableId) {
      const result = await query(`
        select data
        from rows
        where project_id = $1 and table_id = $2
        order by created_at asc, row_id asc
      `, [projectId, tableId]);
      return result.rows.map((row) => row.data);
    },
    async insertRow(projectId, tableId, row) {
      const rowId = String(row.__id || row.id);
      const timestamp = now();
      await query(`
        insert into rows (project_id, table_id, row_id, data, created_at, updated_at)
        values ($1, $2, $3, $4::jsonb, $5, $5)
        on conflict (project_id, table_id, row_id)
        do update set data = excluded.data, updated_at = excluded.updated_at
      `, [projectId, tableId, rowId, JSON.stringify(row), timestamp]);
      return row;
    },
    async updateRow(projectId, tableId, rowId, patch) {
      const current = await this.getRows(projectId, tableId);
      const row = current.find((item) => String(item.__id || item.id) === rowId);
      if (!row) return null;
      Object.assign(row, patch);
      await query(`
        update rows
        set data = $4::jsonb, updated_at = $5
        where project_id = $1 and table_id = $2 and row_id = $3
      `, [projectId, tableId, rowId, JSON.stringify(row), now()]);
      return row;
    }
  };
}

function normalizeBackend(row) {
  return {
    id: row.id,
    project_id: row.project_id,
    graph_version_id: row.graph_version_id,
    provider: row.provider,
    schema: row.schema_name,
    status: row.status,
    api_url: row.api_url,
    created_at: row.created_at
  };
}

function normalizeDeployRequest(row) {
  return {
    ...row,
    logs: Array.isArray(row.logs) ? row.logs : []
  };
}

function now() {
  return new Date().toISOString();
}
