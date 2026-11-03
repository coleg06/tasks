-- Neutral replacement: seeded descriptions are reworded and the default time zone is UTC.
PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO permissions (key, label, description) VALUES
  ('events.view', 'View events', 'View event plans, communication deliverables, and readiness.'),
  ('events.create', 'Request events', 'Create event requests and generated promotion plans.'),
  ('events.manage', 'Manage events', 'Edit event facts, assignments, deliverables, and workflow state.'),
  ('events.approve', 'Approve event work', 'Approve event copy, translations, assets, and publication readiness.');

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT user_id, 'events.view' FROM user_permissions WHERE permission_key = 'tasks.view';

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT user_id, 'events.create' FROM user_permissions WHERE permission_key = 'tasks.view';

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT user_id, 'events.manage' FROM user_permissions WHERE permission_key = 'tasks.manage';

INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
SELECT user_id, 'events.approve' FROM user_permissions WHERE permission_key = 'tasks.manage';

CREATE TABLE event_workflow_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active_version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE event_workflow_template_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES event_workflow_templates(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(template_id, version),
  CHECK (json_valid(definition_json))
);

INSERT INTO event_workflow_templates (template_key, name, description) VALUES
  ('announcement', 'Announcement only', 'Calendar, registration, and optional website communication without a full campaign.'),
  ('standard', 'Standard event', 'A typical event with calendar, website, display screens, and social communication.'),
  ('major', 'Major organization-wide event', 'An early, broad campaign with digital, print, physical, reminder, and recap options.'),
  ('recurring', 'Recurring class or group', 'A reusable class or group campaign with registration and occurrence-aware reminders.');

INSERT INTO event_workflow_template_versions (template_id, version, definition_json)
SELECT id, 1,
  CASE template_key
    WHEN 'announcement' THEN '{"schemaVersion":1,"leadSundays":2,"defaultChannels":["calendar","website"],"defaultOperations":[]}'
    WHEN 'standard' THEN '{"schemaVersion":1,"leadSundays":5,"defaultChannels":["calendar","website","screens","social"],"defaultOperations":[]}'
    WHEN 'major' THEN '{"schemaVersion":1,"leadSundays":7,"defaultChannels":["calendar","website","screens","social","print","physical"],"defaultOperations":["media"]}'
    ELSE '{"schemaVersion":1,"leadSundays":4,"defaultChannels":["calendar","website","screens","social"],"defaultOperations":[]}'
  END
FROM event_workflow_templates;

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  seq INTEGER NOT NULL UNIQUE,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  template_version_id INTEGER NOT NULL REFERENCES event_workflow_template_versions(id) ON DELETE RESTRICT,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  ministry TEXT NOT NULL DEFAULT '',
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  start_at TEXT NOT NULL,
  end_at TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  location TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'draft',
  readiness_status TEXT NOT NULL DEFAULT 'blocked',
  facts_version INTEGER NOT NULL DEFAULT 1,
  recurrence_json TEXT,
  source_system TEXT,
  source_id TEXT,
  source_url TEXT,
  source_metadata_json TEXT,
  source_content_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  archived_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (stage IN ('draft','needs_information','planning','producing','approval','scheduled','event_ready','post_event','archived')),
  CHECK (readiness_status IN ('blocked','at_risk','ready')),
  CHECK (recurrence_json IS NULL OR json_valid(recurrence_json)),
  CHECK (source_metadata_json IS NULL OR json_valid(source_metadata_json)),
  CHECK (source_content_json IS NULL OR json_valid(source_content_json))
);

CREATE UNIQUE INDEX uq_events_source ON events(source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX idx_events_workspace_date ON events(workspace_id, archived_at, start_at);
CREATE INDEX idx_events_owner ON events(owner_user_id, archived_at, start_at);
CREATE INDEX idx_events_stage ON events(stage, readiness_status, start_at);

CREATE TABLE event_fact_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  facts_json TEXT NOT NULL,
  changed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  change_reason TEXT,
  source_system TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(event_id, version),
  CHECK (json_valid(facts_json))
);

CREATE TABLE event_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  campus TEXT NOT NULL DEFAULT 'all',
  language TEXT NOT NULL DEFAULT 'en',
  required INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'planned',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(event_id, channel, campus, language),
  CHECK (channel IN ('calendar','website','program','screens','social','print','physical','qr','media')),
  CHECK (language IN ('en','es')),
  CHECK (required IN (0,1)),
  CHECK (status IN ('planned','in_progress','ready','published','retired','not_needed'))
);

CREATE INDEX idx_event_channels_queue ON event_channels(channel, status, language, event_id);

CREATE TABLE event_deliverables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deliverable_key TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  channel_id INTEGER REFERENCES event_channels(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  asset_type TEXT NOT NULL,
  campus TEXT NOT NULL DEFAULT 'all',
  language TEXT NOT NULL DEFAULT 'en',
  status TEXT NOT NULL DEFAULT 'waiting_on_facts',
  due_at TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  critical INTEGER NOT NULL DEFAULT 1,
  fact_version INTEGER NOT NULL DEFAULT 1,
  approved_copy_version_id INTEGER,
  approved_asset_version_id INTEGER,
  published_at TEXT,
  source_system TEXT,
  source_id TEXT,
  source_url TEXT,
  source_metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (language IN ('en','es')),
  CHECK (status IN ('not_requested','waiting_on_facts','drafting','proofing','design_in_progress','review_requested','changes_requested','approved','scheduled','published','retired')),
  CHECK (critical IN (0,1)),
  CHECK (source_metadata_json IS NULL OR json_valid(source_metadata_json))
);

CREATE UNIQUE INDEX uq_event_deliverable_source ON event_deliverables(source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX idx_event_deliverables_event ON event_deliverables(event_id, status, due_at);
CREATE INDEX idx_event_deliverables_queue ON event_deliverables(asset_type, language, status, due_at);

CREATE TABLE event_copy_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'en',
  current_version INTEGER NOT NULL DEFAULT 0,
  approved_version_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(event_id, purpose, language),
  CHECK (purpose IN ('full_promo','slide','calendar','social','handout','website')),
  CHECK (language IN ('en','es'))
);

CREATE TABLE event_copy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  copy_variant_id INTEGER NOT NULL REFERENCES event_copy_variants(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source_copy_version_id INTEGER REFERENCES event_copy_versions(id) ON DELETE SET NULL,
  fact_version INTEGER NOT NULL,
  body TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'human',
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_system TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(copy_variant_id, version),
  CHECK (author_type IN ('human','ai_draft','imported'))
);

CREATE TABLE event_asset_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deliverable_id INTEGER NOT NULL REFERENCES event_deliverables(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  storage_provider TEXT,
  provider_file_id TEXT,
  checksum_sha256 TEXT,
  metadata_json TEXT,
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  source_system TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(deliverable_id, version),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

CREATE UNIQUE INDEX uq_event_asset_source ON event_asset_versions(source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE event_approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  subject_version INTEGER NOT NULL,
  scope TEXT NOT NULL,
  decision TEXT NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 1,
  approver_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  comment TEXT NOT NULL DEFAULT '',
  source_system TEXT,
  source_id TEXT,
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (subject_type IN ('copy','asset','deliverable','event')),
  CHECK (scope IN ('english_copy','translation','design','publication','event_facts','event_ready')),
  CHECK (decision IN ('approved','changes_requested')),
  CHECK (trusted IN (0,1))
);

CREATE INDEX idx_event_approvals_subject ON event_approvals(subject_type, subject_id, subject_version, invalidated_at);
CREATE INDEX idx_event_approvals_event ON event_approvals(event_id, created_at DESC);
CREATE UNIQUE INDEX uq_event_approval_source ON event_approvals(source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE event_work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_key TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES event_work_items(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_started',
  due_at TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  critical INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_system TEXT,
  source_id TEXT,
  source_url TEXT,
  source_metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (phase IN ('intake','administration','copy','translation','design','publishing','operations','post_event')),
  CHECK (status IN ('not_started','in_progress','blocked','done','not_needed')),
  CHECK (critical IN (0,1)),
  CHECK (source_metadata_json IS NULL OR json_valid(source_metadata_json))
);

CREATE UNIQUE INDEX uq_event_work_item_source ON event_work_items(source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;
CREATE INDEX idx_event_work_items_event ON event_work_items(event_id, phase, status, sort_order);

CREATE TABLE event_work_item_dependencies (
  work_item_id INTEGER NOT NULL REFERENCES event_work_items(id) ON DELETE CASCADE,
  depends_on_work_item_id INTEGER NOT NULL REFERENCES event_work_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (work_item_id, depends_on_work_item_id),
  CHECK (work_item_id <> depends_on_work_item_id)
);

CREATE TABLE event_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL DEFAULT 'event',
  subject_id INTEGER,
  author_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  source_system TEXT,
  source_id TEXT,
  source_created_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (subject_type IN ('event','deliverable','copy','asset','work_item')),
  CHECK (length(trim(body)) BETWEEN 1 AND 10000)
);

CREATE INDEX idx_event_comments_event ON event_comments(event_id, id);
CREATE UNIQUE INDEX uq_event_comment_source ON event_comments(source_system, source_id)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;

CREATE TABLE event_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  correlation_id TEXT,
  source_system TEXT,
  source_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (json_valid(changes_json))
);

CREATE INDEX idx_event_activity_event ON event_activity(event_id, id DESC);
CREATE UNIQUE INDEX uq_event_activity_source ON event_activity(source_system, source_id, action)
  WHERE source_system IS NOT NULL AND source_id IS NOT NULL;

CREATE TRIGGER event_activity_no_update
BEFORE UPDATE ON event_activity
BEGIN
  SELECT RAISE(ABORT, 'event activity is immutable');
END;

CREATE TRIGGER event_activity_no_delete
BEFORE DELETE ON event_activity
BEGIN
  SELECT RAISE(ABORT, 'event activity is immutable');
END;

CREATE TABLE event_ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  input_versions_json TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  result_json TEXT,
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (json_valid(input_versions_json)),
  CHECK (result_json IS NULL OR json_valid(result_json)),
  CHECK (status IN ('pending','succeeded','failed','rejected'))
);

CREATE INDEX idx_event_ai_runs_event ON event_ai_runs(event_id, id DESC);
