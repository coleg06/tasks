PRAGMA foreign_keys = ON;

CREATE TABLE notification_deliveries_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  email_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (kind IN ('assignment','comment','mention','deadline')),
  CHECK (entity_type IN ('task','event','event_work_item','deadline_digest')),
  CHECK (status IN ('pending','accepted','failed','skipped'))
);

INSERT INTO notification_deliveries_v2 (
  id, dedupe_key, user_id, kind, entity_type, entity_key, email_request_id,
  status, error_code, created_at, updated_at
)
SELECT
  id, dedupe_key, user_id, kind, entity_type, entity_key, email_request_id,
  status, error_code, created_at, updated_at
FROM notification_deliveries;

DROP TABLE notification_deliveries;
ALTER TABLE notification_deliveries_v2 RENAME TO notification_deliveries;

CREATE INDEX idx_notification_deliveries_user
  ON notification_deliveries(user_id, created_at DESC);
