-- Neutral replacement for the private seed of the same name (default agent identity).
PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN principal_type TEXT NOT NULL DEFAULT 'human'
  CHECK (principal_type IN ('human','agent'));

INSERT INTO users (email, first_name, last_name, status, principal_type)
VALUES ('agent@tasks.invalid', 'Agent', '', 'active', 'agent')
ON CONFLICT(email) DO UPDATE SET
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  status = excluded.status,
  principal_type = excluded.principal_type,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now');

INSERT INTO workspace_members (workspace_id, user_id, role)
SELECT w.id, u.id, 'admin'
FROM workspaces w
JOIN users u ON u.email = 'agent@tasks.invalid' COLLATE NOCASE
WHERE w.workspace_key = 'default'
ON CONFLICT(workspace_id, user_id) DO UPDATE SET role = excluded.role;

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT u.id, p.key
FROM users u
JOIN permissions p ON p.key IN ('tasks.view', 'tasks.manage', 'tasks.comment')
WHERE u.email = 'agent@tasks.invalid' COLLATE NOCASE;

INSERT INTO user_notification_preferences (
  user_id, assignment_email, comment_email, mention_email, deadline_email
)
SELECT id, 0, 0, 0, 0
FROM users
WHERE email = 'agent@tasks.invalid' COLLATE NOCASE
ON CONFLICT(user_id) DO UPDATE SET
  assignment_email = 0,
  comment_email = 0,
  mention_email = 0,
  deadline_email = 0,
  updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now');
