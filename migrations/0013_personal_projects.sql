-- Neutral replacement for the private seed of the same name (default workspace key).
INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('tasks.personal', 'Personal tasks', 'Create and manage tasks in a private owner-only Personal project.');

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT id, 'tasks.personal' FROM users;

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT id, 'tasks.comment' FROM users;

ALTER TABLE projects ADD COLUMN project_type TEXT NOT NULL DEFAULT 'shared'
  CHECK (project_type IN ('shared', 'personal'));

ALTER TABLE projects ADD COLUMN personal_owner_user_id INTEGER
  REFERENCES users(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX uq_projects_personal_owner
  ON projects(personal_owner_user_id)
  WHERE project_type = 'personal';

INSERT OR IGNORE INTO projects (
  workspace_id, project_key, name, description, visibility, created_by_user_id,
  project_type, personal_owner_user_id
)
SELECT w.id, 'PERSONAL-' || u.id, 'Personal', 'Private tasks visible only to you',
  'private', u.id, 'personal', u.id
FROM users u
JOIN workspaces w ON w.workspace_key = 'default';

INSERT OR IGNORE INTO project_members (project_id, user_id, role)
SELECT p.id, p.personal_owner_user_id, 'owner'
FROM projects p
WHERE p.project_type = 'personal';

CREATE TRIGGER users_create_personal_project
AFTER INSERT ON users
BEGIN
  INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
  VALUES (NEW.id, 'tasks.personal');

  INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
  VALUES (NEW.id, 'tasks.comment');

  INSERT OR IGNORE INTO projects (
    workspace_id, project_key, name, description, visibility, created_by_user_id,
    project_type, personal_owner_user_id
  )
  SELECT w.id, 'PERSONAL-' || NEW.id, 'Personal', 'Private tasks visible only to you',
    'private', NEW.id, 'personal', NEW.id
  FROM workspaces w
  WHERE w.workspace_key = 'default';

  INSERT OR IGNORE INTO project_members (project_id, user_id, role)
  SELECT p.id, NEW.id, 'owner'
  FROM projects p
  WHERE p.project_type = 'personal' AND p.personal_owner_user_id = NEW.id;
END;
