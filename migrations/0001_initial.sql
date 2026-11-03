PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_db_id INTEGER UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  photo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  google_subject TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen_at TEXT,
  CHECK (status IN ('active','disabled'))
);

CREATE INDEX idx_users_status ON users(status, email);

CREATE TABLE permissions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_key TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_started',
  priority TEXT,
  effort TEXT,
  assignee_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id),
  due_date TEXT,
  sort_key TEXT NOT NULL,
  completed_at TEXT,
  archived_at TEXT,
  source_system TEXT,
  source_id TEXT,
  source_url TEXT,
  source_created_at TEXT,
  source_updated_at TEXT,
  source_metadata_json TEXT,
  source_content_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (status IN ('backlog','not_started','in_progress','blocked','done')),
  CHECK (priority IS NULL OR priority IN ('high','medium','low')),
  CHECK (effort IS NULL OR effort IN ('small','medium','large')),
  CHECK (source_metadata_json IS NULL OR json_valid(source_metadata_json)),
  CHECK (source_content_json IS NULL OR json_valid(source_content_json))
);

CREATE UNIQUE INDEX uq_tasks_source ON tasks(source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX idx_tasks_open ON tasks(archived_at, status, sort_key);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_user_id, status, due_date);
CREATE INDEX idx_tasks_due ON tasks(due_date, status) WHERE archived_at IS NULL;
CREATE INDEX idx_tasks_updated ON tasks(updated_at DESC);

CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  actor_user_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (json_valid(changes_json))
);

CREATE INDEX idx_task_events_task ON task_events(task_id, id DESC);
CREATE INDEX idx_task_events_actor ON task_events(actor_user_id, created_at DESC);

CREATE VIRTUAL TABLE tasks_fts USING fts5(
  title,
  description,
  content='tasks',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER tasks_fts_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER tasks_fts_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER tasks_fts_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
  INSERT INTO tasks_fts(rowid, title, description) VALUES (new.id, new.title, new.description);
END;
