-- Roles are named sets of the existing permission keys. A user's effective permissions are the
-- union of their direct grants in user_permissions and the permissions of their roles.
-- Nobody is assigned a role by this migration and no existing row is rewritten, so every existing
-- user keeps exactly the access they already have. Every ordinary user holds the baseline
-- permissions (tasks.view, tasks.comment, tasks.personal, events.view, events.create) as direct
-- grants; assigning a role through the API removes that user's direct baseline grants in the same
-- batch, so from then on the roles alone decide them (a Viewer is read-only, removing Member
-- revokes access). Users with no roles are unaffected.
PRAGMA foreign_keys = ON;

CREATE TABLE roles (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (length(key) BETWEEN 2 AND 64),
  CHECK (key NOT GLOB '*[^a-z0-9_-]*')
);

CREATE TABLE role_permissions (
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  permission_key TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL REFERENCES roles(key) ON DELETE RESTRICT,
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  granted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (user_id, role_key)
);

-- Role filters in the user directory and "who holds this role" counts.
CREATE INDEX idx_user_roles_role ON user_roles(role_key, user_id);
-- Audit-log filters by action and by date; the id index already serves plain pagination.
CREATE INDEX idx_audit_events_action ON audit_events(action, id DESC);
CREATE INDEX idx_audit_events_created_at ON audit_events(created_at, id);
-- Directory sort and keyset pagination by name are served by the unique email index.

-- Built-in roles. `admin` is the platform administrator; it behaves exactly like the direct
-- platform.admin grant (see effective_user_permissions below, which expands it on every read).
INSERT INTO roles (key, label, description, builtin) VALUES
  ('admin', 'Administrator', 'Full access to every workspace, project, event and administrative action.', 1),
  ('manager', 'Manager', 'Everything a member can do, plus managing tasks, projects and people.', 1),
  ('member', 'Member', 'Work on shared tasks and comment, plus personal tasks.', 1),
  ('viewer', 'Viewer', 'Read-only access to shared tasks.', 1);

INSERT INTO role_permissions (role_key, permission_key)
SELECT 'admin', key FROM permissions;

INSERT INTO role_permissions (role_key, permission_key)
SELECT 'manager', key FROM permissions
WHERE key IN ('tasks.view', 'tasks.comment', 'tasks.personal', 'tasks.manage');

INSERT INTO role_permissions (role_key, permission_key)
SELECT 'member', key FROM permissions
WHERE key IN ('tasks.view', 'tasks.comment', 'tasks.personal');

INSERT INTO role_permissions (role_key, permission_key)
SELECT 'viewer', key FROM permissions WHERE key = 'tasks.view';

-- Every permission check that reads user_permissions directly reads this view instead, so a
-- role grants exactly what an equivalent direct grant would, including the platform.admin
-- expansion to every permission (present and future).
CREATE VIEW effective_user_permissions AS
  SELECT user_id, permission_key FROM user_permissions
  UNION
  SELECT ur.user_id, rp.permission_key
  FROM user_roles ur JOIN role_permissions rp ON rp.role_key = ur.role_key
  UNION
  SELECT ur.user_id, p.key
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_key = ur.role_key AND rp.permission_key = 'platform.admin'
  CROSS JOIN permissions p
  UNION
  SELECT up.user_id, p.key
  FROM user_permissions up
  CROSS JOIN permissions p
  WHERE up.permission_key = 'platform.admin';

-- A role that contains platform.admin always confers every permission, present and future,
-- because the view above expands it on each read. Storing platform.admin in a role also stores
-- the current catalogue, mirroring the direct grant (user_permissions_expand_platform_admin).
CREATE TRIGGER role_permissions_expand_platform_admin
AFTER INSERT ON role_permissions
WHEN NEW.permission_key = 'platform.admin'
BEGIN
  INSERT OR IGNORE INTO role_permissions (role_key, permission_key)
  SELECT NEW.role_key, key FROM permissions;
END;

-- Atomic backstop for "the last active platform administrator cannot be disabled, demoted or
-- removed". The API checks first and returns a friendly error, then ends every batch that can
-- reduce the administrator set with a guard insert. If the batch left no active platform
-- administrator although one existed before it, the CHECK fails and the whole batch (a single
-- transaction) rolls back. The row is removed again at once, so the table stays empty. A
-- deployment with no administrator at all is never blocked.
CREATE TABLE platform_admin_guard (
  expected INTEGER NOT NULL CONSTRAINT last_platform_admin CHECK (expected = 1)
);

CREATE TRIGGER platform_admin_guard_clear
AFTER INSERT ON platform_admin_guard
BEGIN
  DELETE FROM platform_admin_guard WHERE rowid = NEW.rowid;
END;

-- Atomic backstop for "a role that is still assigned cannot be deleted without a replacement".
-- The API checks first, then starts the delete batch with a guard insert. If assignments exist
-- when the batch runs (someone assigned the role after the check) and no replacement was named,
-- the CHECK fails and the whole batch rolls back. The row is removed again at once.
CREATE TABLE role_delete_guard (
  ok INTEGER NOT NULL CONSTRAINT role_in_use CHECK (ok = 1)
);

CREATE TRIGGER role_delete_guard_clear
AFTER INSERT ON role_delete_guard
BEGIN
  DELETE FROM role_delete_guard WHERE rowid = NEW.rowid;
END;

-- Built-in roles are fixed: they cannot be renamed, deleted or have permissions removed. Custom
-- roles are managed through the API (platform administrators only).
CREATE TRIGGER roles_builtin_no_update
BEFORE UPDATE ON roles
WHEN OLD.builtin = 1
BEGIN
  SELECT RAISE(ABORT, 'builtin_role_locked');
END;

CREATE TRIGGER roles_builtin_no_delete
BEFORE DELETE ON roles
WHEN OLD.builtin = 1
BEGIN
  SELECT RAISE(ABORT, 'builtin_role_locked');
END;

CREATE TRIGGER role_permissions_builtin_no_delete
BEFORE DELETE ON role_permissions
WHEN (SELECT builtin FROM roles WHERE key = OLD.role_key) = 1
BEGIN
  SELECT RAISE(ABORT, 'builtin_role_locked');
END;
