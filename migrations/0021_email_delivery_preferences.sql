-- Deployment-local settings; no tenant identity or seeded users.
CREATE TABLE email_delivery_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  per_minute INTEGER NOT NULL DEFAULT 5 CHECK (per_minute BETWEEN 0 AND 1000),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT INTO email_delivery_settings (id) VALUES (1);

CREATE TABLE email_delivery_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hard_limit INTEGER NOT NULL DEFAULT 5 CHECK (hard_limit BETWEEN 0 AND 1000),
  period_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (period_seconds IN (3600,86400,604800)),
  assignment TEXT NOT NULL DEFAULT 'immediate' CHECK (assignment IN ('immediate','hourly','daily','weekly','off')),
  comment TEXT NOT NULL DEFAULT 'immediate' CHECK (comment IN ('immediate','hourly','daily','weekly','off')),
  mention TEXT NOT NULL DEFAULT 'immediate' CHECK (mention IN ('immediate','hourly','daily','weekly','off')),
  deadline TEXT NOT NULL DEFAULT 'immediate' CHECK (deadline IN ('immediate','hourly','daily','weekly','off'))
);

-- Only granted attempts live here. One atomic INSERT SELECT reserves both rolling quotas.
-- Reservations consume quota even when the gateway fails or the process stops.
CREATE TABLE email_send_attempts (
  dedupe_key TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reserved_at INTEGER NOT NULL DEFAULT (unixepoch()),
  send_claimed INTEGER NOT NULL DEFAULT 0 CHECK (send_claimed IN (0,1))
);
CREATE INDEX idx_email_attempts_time ON email_send_attempts(reserved_at);
CREATE INDEX idx_email_attempts_user_time ON email_send_attempts(user_id, reserved_at);

-- At most 25 references per interval, with current and briefly due buckets per recipient.
-- No message text, addresses, or deferred individual emails are retained.
CREATE TABLE email_digest_buckets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  frequency TEXT NOT NULL CHECK (frequency IN ('hourly','daily','weekly')),
  due_at INTEGER NOT NULL,
  claimed INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0,1)),
  PRIMARY KEY (user_id, frequency, due_at)
);
CREATE INDEX idx_email_digest_due ON email_digest_buckets(due_at, user_id, frequency);

CREATE TABLE email_digest_items (
  user_id INTEGER NOT NULL,
  frequency TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('assignment','comment','mention','deadline')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task','event','event_work_item')),
  entity_key TEXT NOT NULL CHECK (length(entity_key) <= 100),
  PRIMARY KEY (user_id, frequency, due_at, kind, entity_type, entity_key),
  FOREIGN KEY (user_id, frequency, due_at) REFERENCES email_digest_buckets(user_id, frequency, due_at) ON DELETE CASCADE
);

CREATE INDEX idx_notification_deliveries_created ON notification_deliveries(created_at);

-- Daily deadline runs are consumed once, including crashes and suppressed recipients.
CREATE TABLE email_dispatch_runs (
  dispatch_key TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL DEFAULT (unixepoch())
);
