import fs from "node:fs";
import path from "node:path";

export function createFileControlStore(options = {}) {
  const dataFile = options.dataFile;
  const empty = {
    accounts: [{ id: "account_local", name: "Local Atoll Alpha", created_at: now() }],
    users: [],
    sessions: [],
    projects: [],
    project_members: [],
    graph_versions: [],
    deploy_requests: [],
    backend_instances: [],
    field_access_levels: [],
    audit_events: [],
    rows: {}
  };
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const data = fs.existsSync(dataFile)
    ? { ...empty, ...JSON.parse(fs.readFileSync(dataFile, "utf8")) }
    : empty;

  function save() {
    fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`);
  }

  function account() {
    return data.accounts[0];
  }

  return {
    kind: "file",
    dataFile,
    async health() {
      return { ok: true, mode: "local-file", data_file: dataFile };
    },
    async account() {
      return account();
    },
    async upsertUser(email) {
      let user = data.users.find((item) => item.email === email);
      if (!user) {
        user = { id: options.id("user"), account_id: account().id, email, created_at: now() };
        data.users.push(user);
        save();
      }
      return user;
    },
    async createSession(userId, tokenHash) {
      const session = { id: options.id("session"), user_id: userId, token_hash: tokenHash, created_at: now() };
      data.sessions.push(session);
      save();
      return session;
    },
    async findSession(tokenHash, legacyToken = "") {
      const session = data.sessions.find((item) => item.token_hash === tokenHash || item.token === legacyToken);
      if (!session) return null;
      const user = data.users.find((item) => item.id === session.user_id);
      if (!user) return null;
      return { session, user };
    },
    async createProject(project) {
      data.projects.push(project);
      save();
      return project;
    },
    async addProjectMember(member) {
      if (!data.project_members.some((item) => item.project_id === member.project_id && item.user_id === member.user_id)) {
        data.project_members.push(member);
        save();
      }
      return member;
    },
    async findProject(projectId) {
      return data.projects.find((item) => item.id === projectId) || null;
    },
    async createGraphVersion(version) {
      data.graph_versions.push(version);
      save();
      return version;
    },
    async getGraphVersion(projectId, graphVersionId) {
      return data.graph_versions.find((item) => item.id === graphVersionId && item.project_id === projectId) || null;
    },
    async latestGraphVersion(projectId) {
      return data.graph_versions.filter((item) => item.project_id === projectId).at(-1) || null;
    },
    async createDeployRequest(record) {
      data.deploy_requests.push(record);
      save();
      return record;
    },
    async updateDeployRequest(record) {
      const index = data.deploy_requests.findIndex((item) => item.id === record.id);
      if (index >= 0) data.deploy_requests[index] = record;
      save();
      return record;
    },
    async latestDeployRequest(projectId) {
      return data.deploy_requests.filter((item) => item.project_id === projectId).at(-1) || null;
    },
    async createBackendInstance(backend) {
      data.backend_instances.push(backend);
      save();
      return backend;
    },
    async latestBackendInstance(projectId) {
      return data.backend_instances.filter((item) => item.project_id === projectId).at(-1) || null;
    },
    async ensureRowsForTables(projectId, tables) {
      data.rows[projectId] = data.rows[projectId] || {};
      for (const table of tables) {
        data.rows[projectId][table.id] = data.rows[projectId][table.id] || [];
      }
      save();
    },
    async addFieldAccessLevels(levels) {
      for (const level of levels) {
        data.field_access_levels = data.field_access_levels.filter((item) => (
          item.project_id !== level.project_id ||
          item.graph_version_id !== level.graph_version_id ||
          item.table_id !== level.table_id ||
          item.field !== level.field
        ));
        data.field_access_levels.push(level);
      }
      save();
    },
    async listAuditEvents(projectId, limit = 200) {
      return data.audit_events.filter((item) => item.project_id === projectId).slice(-limit).reverse();
    },
    async addAuditEvent(event) {
      data.audit_events.push(event);
      save();
      return event;
    },
    async getRows(projectId, tableId) {
      data.rows[projectId] = data.rows[projectId] || {};
      data.rows[projectId][tableId] = data.rows[projectId][tableId] || [];
      return data.rows[projectId][tableId];
    },
    async insertRow(projectId, tableId, row) {
      const rows = await this.getRows(projectId, tableId);
      rows.push(row);
      save();
      return row;
    },
    async updateRow(projectId, tableId, rowId, patch) {
      const rows = await this.getRows(projectId, tableId);
      const row = rows.find((item) => String(item.__id || item.id) === rowId);
      if (!row) return null;
      Object.assign(row, patch);
      save();
      return row;
    }
  };
}

function now() {
  return new Date().toISOString();
}
