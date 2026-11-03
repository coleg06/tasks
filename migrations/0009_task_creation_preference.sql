CREATE TABLE user_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  task_creation_mode TEXT NOT NULL DEFAULT 'guided',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (task_creation_mode IN ('guided', 'quick'))
);
