-- Additive, tenant-neutral browser session state. No bearer tokens, email addresses or Google credentials are stored.
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  authenticated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  actor_session_id TEXT REFERENCES browser_sessions(id) ON DELETE CASCADE,
  revoked_at INTEGER,
  CHECK (expires_at <= absolute_expires_at),
  CHECK (authenticated_at < expires_at)
);
CREATE INDEX idx_browser_sessions_user ON browser_sessions(user_id);
CREATE INDEX idx_browser_sessions_actor ON browser_sessions(actor_session_id);
CREATE INDEX idx_browser_sessions_absolute_expiry ON browser_sessions(absolute_expires_at);

-- A disable permanently ends existing sessions, even if the user is later re-enabled.
CREATE TRIGGER revoke_browser_sessions_on_disable
AFTER UPDATE OF status ON users
WHEN NEW.status <> 'active'
BEGIN
  UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, unixepoch())
  WHERE user_id = NEW.id OR actor_session_id IN (
    SELECT id FROM browser_sessions WHERE user_id = NEW.id
  );
END;
