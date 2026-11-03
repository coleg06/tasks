-- Neutral replacement for the private seed of the same name.
PRAGMA foreign_keys = ON;

-- Non-secret deployment identity. Downstream forks replace only this seed before
-- their first database migration.
CREATE TABLE tenant_configuration (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tenant_key TEXT NOT NULL,
  organization_name TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  default_project_key TEXT NOT NULL,
  default_project_name TEXT NOT NULL,
  default_project_description TEXT NOT NULL,
  initial_admin_email TEXT NOT NULL COLLATE NOCASE,
  agent_name TEXT NOT NULL,
  agent_email TEXT NOT NULL COLLATE NOCASE
);

INSERT INTO tenant_configuration (
  id, tenant_key, organization_name, workspace_key,
  default_project_key, default_project_name, default_project_description,
  initial_admin_email, agent_name, agent_email
) VALUES (
  1, 'default', 'Team', 'default',
  'TASKS', 'Tasks', 'Default project',
  '', 'Agent', 'agent@tasks.invalid'
);

-- Normalize an earlier bootstrap through stable numeric IDs only when the configured tenant
-- differs from the seeded one. Defaults, roles, permissions, and Agent state are not replayed
-- over mutable data.
UPDATE workspaces
SET workspace_key = (SELECT workspace_key FROM tenant_configuration WHERE id = 1),
    name = (SELECT organization_name FROM tenant_configuration WHERE id = 1)
WHERE workspace_key = 'default'
  AND EXISTS (
    SELECT 1 FROM tenant_configuration WHERE id = 1 AND tenant_key <> 'default'
  )
  AND (
    workspace_key <> (SELECT workspace_key FROM tenant_configuration WHERE id = 1)
    OR name <> (SELECT organization_name FROM tenant_configuration WHERE id = 1)
  );

UPDATE projects
SET project_key = (SELECT default_project_key FROM tenant_configuration WHERE id = 1),
    name = (SELECT default_project_name FROM tenant_configuration WHERE id = 1),
    description = (SELECT default_project_description FROM tenant_configuration WHERE id = 1)
WHERE project_key = 'TASKS'
  AND project_type = 'shared'
  AND EXISTS (
    SELECT 1 FROM tenant_configuration WHERE id = 1 AND tenant_key <> 'default'
  )
  AND workspace_id = (
    SELECT w.id
    FROM workspaces w
    JOIN tenant_configuration c ON c.workspace_key = w.workspace_key
    WHERE c.id = 1
  )
  AND (
    project_key <> (SELECT default_project_key FROM tenant_configuration WHERE id = 1)
    OR name <> (SELECT default_project_name FROM tenant_configuration WHERE id = 1)
    OR description <> (SELECT default_project_description FROM tenant_configuration WHERE id = 1)
  );

UPDATE users
SET email = (SELECT agent_email FROM tenant_configuration WHERE id = 1),
    first_name = (SELECT agent_name FROM tenant_configuration WHERE id = 1),
    last_name = '',
    status = 'active',
    principal_type = 'agent',
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE email = 'agent@tasks.invalid' COLLATE NOCASE
  AND EXISTS (
    SELECT 1 FROM tenant_configuration WHERE id = 1 AND tenant_key <> 'default'
  )
  AND (
    email <> (SELECT agent_email FROM tenant_configuration WHERE id = 1) COLLATE NOCASE
    OR first_name <> (SELECT agent_name FROM tenant_configuration WHERE id = 1)
    OR last_name <> ''
    OR status <> 'active'
    OR principal_type <> 'agent'
  );

DROP TRIGGER users_create_personal_project;

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
  WHERE w.workspace_key = (
    SELECT workspace_key FROM tenant_configuration WHERE id = 1
  );

  INSERT OR IGNORE INTO project_members (project_id, user_id, role)
  SELECT p.id, NEW.id, 'owner'
  FROM projects p
  WHERE p.project_type = 'personal' AND p.personal_owner_user_id = NEW.id;
END;
