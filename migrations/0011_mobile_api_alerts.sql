PRAGMA foreign_keys = ON;

ALTER TABLE user_notification_preferences ADD COLUMN assignment_in_app INTEGER NOT NULL DEFAULT 0 CHECK (assignment_in_app IN (0,1));
ALTER TABLE user_notification_preferences ADD COLUMN assignment_push INTEGER NOT NULL DEFAULT 0 CHECK (assignment_push IN (0,1));
ALTER TABLE user_notification_preferences ADD COLUMN comment_in_app INTEGER NOT NULL DEFAULT 0 CHECK (comment_in_app IN (0,1));
ALTER TABLE user_notification_preferences ADD COLUMN comment_push INTEGER NOT NULL DEFAULT 0 CHECK (comment_push IN (0,1));
ALTER TABLE user_notification_preferences ADD COLUMN mention_in_app INTEGER NOT NULL DEFAULT 0 CHECK (mention_in_app IN (0,1));
ALTER TABLE user_notification_preferences ADD COLUMN mention_push INTEGER NOT NULL DEFAULT 0 CHECK (mention_push IN (0,1));
ALTER TABLE user_notification_preferences ADD COLUMN deadline_in_app INTEGER NOT NULL DEFAULT 0 CHECK (deadline_in_app IN (0,1));
ALTER TABLE user_notification_preferences ADD COLUMN deadline_push INTEGER NOT NULL DEFAULT 0 CHECK (deadline_push IN (0,1));

ALTER TABLE task_comments ADD COLUMN mutation_key TEXT;
CREATE UNIQUE INDEX uq_task_comments_mutation_key
  ON task_comments(mutation_key) WHERE mutation_key IS NOT NULL;

CREATE TABLE mobile_gateway_requests (
  request_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  portal_user_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_mobile_gateway_requests_expiry ON mobile_gateway_requests(expires_at);

CREATE TABLE mobile_idempotency_keys (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  response_status INTEGER,
  response_body TEXT,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (user_id, scope, idempotency_key),
  CHECK (status IN ('processing','completed')),
  CHECK (response_status IS NULL OR response_status BETWEEN 200 AND 499)
);

CREATE INDEX idx_mobile_idempotency_expiry ON mobile_idempotency_keys(expires_at);

CREATE TABLE notification_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  task_version INTEGER NOT NULL,
  in_app_requested INTEGER NOT NULL DEFAULT 0,
  push_requested INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (dedupe_key, user_id),
  CHECK (kind IN ('assignment','comment','mention','deadline')),
  CHECK (entity_type IN ('task','event','event_work_item')),
  CHECK (in_app_requested IN (0,1)),
  CHECK (push_requested IN (0,1)),
  CHECK (task_version > 0),
  CHECK (status IN ('pending','processing','delivered','failed','dead_letter')),
  CHECK (in_app_requested = 1 OR push_requested = 1)
);

CREATE INDEX idx_notification_outbox_pending
  ON notification_outbox(status, available_at, id);
CREATE INDEX idx_notification_outbox_user
  ON notification_outbox(user_id, created_at DESC);
