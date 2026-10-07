-- Fleet operations: ingest identity, expected-sensor profiles, hysteresis state, incidents, alerts, work, plans.
-- Forward-only. Existing documents/chunks records are untouched.
CREATE TABLE ingests (id TEXT PRIMARY KEY, retrieved_at TEXT NOT NULL, status TEXT NOT NULL, quality TEXT NOT NULL, station_count INTEGER, active_count INTEGER, response_count INTEGER, fresh_count INTEGER, network_newest TEXT, reasons TEXT NOT NULL DEFAULT '[]', assessed_at TEXT, engine TEXT);
CREATE INDEX ingests_time ON ingests(retrieved_at);
-- Fleet-wide expected-sensor profiles and per-station hysteresis state are each one bounded JSON row, so an
-- assessment stays within D1's per-invocation query limit (every batch statement counts).
CREATE TABLE fleet_blobs (key TEXT PRIMARY KEY, body TEXT NOT NULL, revision TEXT NOT NULL, updated TEXT NOT NULL, updated_by TEXT);
CREATE TABLE incidents (id TEXT PRIMARY KEY, scope TEXT NOT NULL CHECK(scope IN ('station','group','feed')), kind TEXT NOT NULL, station TEXT, group_id TEXT, tier TEXT NOT NULL, tier_override TEXT, state TEXT NOT NULL, confidence TEXT NOT NULL, telemetry TEXT NOT NULL, assignee TEXT, acknowledged_by TEXT, acknowledged_at TEXT, first_suspected TEXT, first_confirmed TEXT, last_good TEXT, last_assessed TEXT, recovered_at TEXT, resolved_at TEXT, resolution TEXT, deferral TEXT, body TEXT NOT NULL, revision TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, algorithm TEXT NOT NULL);
CREATE INDEX incidents_state ON incidents(state, tier);
CREATE INDEX incidents_station ON incidents(station, state);
CREATE INDEX incidents_resolved ON incidents(resolved_at);
CREATE UNIQUE INDEX one_open_station_incident ON incidents(station) WHERE scope='station' AND state NOT IN ('resolved','merged');
CREATE UNIQUE INDEX one_open_feed_incident ON incidents(scope) WHERE scope='feed' AND state NOT IN ('resolved','merged');
CREATE TABLE incident_events (id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL, ingest_id TEXT);
CREATE INDEX incident_events_by_incident ON incident_events(incident_id, at);
CREATE TABLE alerts (id TEXT PRIMARY KEY, dedupe TEXT NOT NULL UNIQUE, incident_id TEXT, kind TEXT NOT NULL, tier TEXT, title TEXT NOT NULL, detail TEXT NOT NULL, created TEXT NOT NULL, suppressed INTEGER NOT NULL DEFAULT 0, acknowledged_by TEXT, acknowledged_at TEXT);
CREATE INDEX alerts_created ON alerts(created);
CREATE INDEX alerts_open ON alerts(acknowledged_at, suppressed, created);
CREATE TABLE work_items (id TEXT PRIMARY KEY, incident_id TEXT, station TEXT NOT NULL, status TEXT NOT NULL, template TEXT, assignee TEXT, body TEXT NOT NULL, revision TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX work_by_station ON work_items(station, status);
CREATE INDEX work_by_incident ON work_items(incident_id);
CREATE INDEX work_by_status ON work_items(status, updated);
CREATE TABLE plans (id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('draft','accepted','completed','cancelled')), plan_date TEXT NOT NULL, crew TEXT, title TEXT NOT NULL, body TEXT NOT NULL, revision TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE INDEX plans_by_date ON plans(plan_date, status);
CREATE TABLE plan_revisions (plan_id TEXT NOT NULL, revision TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, PRIMARY KEY(plan_id, revision));
CREATE INDEX plan_revisions_at ON plan_revisions(plan_id, at);
CREATE TABLE station_notes (station TEXT PRIMARY KEY, body TEXT NOT NULL, revision TEXT NOT NULL, updated TEXT NOT NULL, updated_by TEXT NOT NULL);
CREATE TABLE reference_overrides (id TEXT PRIMARY KEY, station TEXT NOT NULL, variable TEXT NOT NULL, reference TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('pin','exclude')), reason TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL, removed_at TEXT, removed_by TEXT, removed_reason TEXT);
CREATE INDEX reference_overrides_station ON reference_overrides(station, variable);
CREATE TABLE provider_cache (key TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, expires INTEGER NOT NULL, body TEXT NOT NULL);
CREATE INDEX provider_cache_expires ON provider_cache(expires);
-- Never holds rows. Inserting x=1 fails the CHECK and rolls back a batch whose incident revisions changed concurrently.
CREATE TABLE write_guard (x INTEGER NOT NULL CHECK(x=0));
