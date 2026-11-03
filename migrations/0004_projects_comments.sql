-- Neutral replacement for the private seed of the same name (default workspace and project).
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('tasks.comment', 'Comment on tasks', 'Read and add comments on accessible tasks.');

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT user_id, 'tasks.comment'
FROM user_permissions
WHERE permission_key = 'tasks.view';

CREATE TABLE workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE workspace_members (
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (workspace_id, user_id),
  CHECK (role IN ('owner','admin','member'))
);

CREATE INDEX idx_workspace_members_user ON workspace_members(user_id, workspace_id);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'workspace',
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (visibility IN ('workspace','private'))
);

CREATE INDEX idx_projects_workspace ON projects(workspace_id, archived_at, name);

CREATE TABLE project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (project_id, user_id),
  CHECK (role IN ('owner','editor','viewer'))
);

CREATE INDEX idx_project_members_user ON project_members(user_id, project_id);

INSERT INTO workspaces (workspace_key, name, created_by_user_id)
SELECT 'default', 'Team', id
FROM users
ORDER BY id
LIMIT 1;

INSERT OR IGNORE INTO workspaces (workspace_key, name)
VALUES ('default', 'Team');

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id,
  'member'
FROM workspaces w
JOIN users u
JOIN user_permissions up ON up.user_id = u.id AND up.permission_key = 'tasks.view'
WHERE w.workspace_key = 'default'
ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role;

INSERT INTO projects (
  workspace_id, project_key, name, description, visibility, created_by_user_id
)
SELECT w.id, 'TASKS', 'Tasks', 'Default project', 'workspace', w.created_by_user_id
FROM workspaces w
WHERE w.workspace_key = 'default';

INSERT INTO project_members (project_id, user_id, role)
SELECT p.id, wm.user_id,
  CASE WHEN wm.role = 'owner' THEN 'owner' ELSE 'viewer' END
FROM projects p
JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
WHERE p.project_key = 'TASKS';

ALTER TABLE tasks ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE RESTRICT;
ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT;

UPDATE tasks
SET workspace_id = (SELECT id FROM workspaces WHERE workspace_key = 'default'),
    project_id = (SELECT id FROM projects WHERE project_key = 'TASKS')
WHERE workspace_id IS NULL OR project_id IS NULL;

CREATE INDEX idx_tasks_project ON tasks(project_id, archived_at, status, sort_key);
CREATE INDEX idx_tasks_workspace ON tasks(workspace_id, archived_at, updated_at DESC);

CREATE TABLE task_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  body TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (length(trim(body)) BETWEEN 1 AND 5000)
);

CREATE INDEX idx_task_comments_task ON task_comments(task_id, id);
CREATE INDEX idx_task_comments_author ON task_comments(author_user_id, created_at DESC);
