-- Neutral replacement: no administrator is seeded; see TASKS_INITIAL_ADMIN_EMAIL.
INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('platform.admin', 'Platform administrator', 'Full access to every workspace, project, event, administrative action, and future platform capability.');

CREATE TRIGGER IF NOT EXISTS permissions_grant_platform_admin
AFTER INSERT ON permissions
BEGIN
  INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
  SELECT user_id, NEW.key
  FROM user_permissions
  WHERE permission_key = 'platform.admin';
END;

CREATE TRIGGER IF NOT EXISTS user_permissions_expand_platform_admin
AFTER INSERT ON user_permissions
WHEN NEW.permission_key = 'platform.admin'
BEGIN
  INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
  SELECT NEW.user_id, key FROM permissions;
END;
