PRAGMA foreign_keys = ON;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  action TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (entity_type IN ('task','comment','project','membership','user','system')),
  CHECK (json_valid(changes_json))
);

CREATE INDEX idx_audit_events_created ON audit_events(id DESC);
CREATE INDEX idx_audit_events_entity ON audit_events(entity_type, entity_key, id DESC);
CREATE INDEX idx_audit_events_actor ON audit_events(actor_user_id, id DESC);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;
