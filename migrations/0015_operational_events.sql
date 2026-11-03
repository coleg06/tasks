PRAGMA foreign_keys = ON;

-- Operational failures are intentionally separate from the immutable user audit trail.
-- Request bodies, cookies, authorization headers, and secrets must never be stored here.
CREATE TABLE operational_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  severity TEXT NOT NULL,
  event TEXT NOT NULL,
  source TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  request_id TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (severity IN ('warning','error')),
  CHECK (length(event) BETWEEN 1 AND 120),
  CHECK (length(source) BETWEEN 1 AND 60),
  CHECK (length(message) <= 500),
  CHECK (details_json IS NULL OR json_valid(details_json))
);

CREATE INDEX idx_operational_events_created ON operational_events(id DESC);
CREATE INDEX idx_operational_events_severity ON operational_events(severity, id DESC);
CREATE INDEX idx_operational_events_event ON operational_events(event, id DESC);
CREATE INDEX idx_operational_events_request ON operational_events(request_id)
  WHERE request_id IS NOT NULL;
