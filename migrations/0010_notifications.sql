PRAGMA foreign_keys = ON;

CREATE TABLE user_notification_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assignment_email INTEGER NOT NULL DEFAULT 1,
  comment_email INTEGER NOT NULL DEFAULT 1,
  mention_email INTEGER NOT NULL DEFAULT 1,
  deadline_email INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (assignment_email IN (0,1)),
  CHECK (comment_email IN (0,1)),
  CHECK (mention_email IN (0,1)),
  CHECK (deadline_email IN (0,1))
);

CREATE TABLE notification_deliveries (
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
  CHECK (entity_type IN ('task','event','event_work_item')),
  CHECK (status IN ('pending','accepted','failed','skipped'))
);

CREATE INDEX idx_notification_deliveries_user
  ON notification_deliveries(user_id, created_at DESC);

CREATE TABLE comment_mentions (
  subject_type TEXT NOT NULL,
  comment_id INTEGER NOT NULL,
  mentioned_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (subject_type, comment_id, mentioned_user_id),
  CHECK (subject_type IN ('task','event'))
);

CREATE INDEX idx_comment_mentions_user
  ON comment_mentions(mentioned_user_id, created_at DESC);
