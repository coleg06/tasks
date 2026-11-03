-- Additive rollout: existing and imported events keep their legacy workflow until explicitly
-- converted. No work, assignments, dependencies, approvals, or source records are removed.
ALTER TABLE events ADD COLUMN workflow_mode TEXT NOT NULL DEFAULT 'legacy'
  CHECK (workflow_mode IN ('legacy','responsibilities'));
ALTER TABLE events ADD COLUMN original_request_json TEXT
  CHECK (original_request_json IS NULL OR json_valid(original_request_json));
ALTER TABLE events ADD COLUMN original_request_kind TEXT;

UPDATE events SET
  original_request_json = COALESCE(
    CASE WHEN json_type(source_content_json, '$.intake') = 'object'
      THEN json_extract(source_content_json, '$.intake') END,
    (SELECT facts_json FROM event_fact_versions WHERE event_id = events.id ORDER BY version LIMIT 1)
  ),
  original_request_kind = CASE WHEN json_type(source_content_json, '$.intake') = 'object'
    THEN 'source_intake' ELSE 'earliest_saved_facts' END;

CREATE TRIGGER event_original_request_immutable
BEFORE UPDATE OF original_request_json, original_request_kind ON events
WHEN OLD.original_request_json IS NOT NULL AND (
  NEW.original_request_json IS NOT OLD.original_request_json OR
  NEW.original_request_kind IS NOT OLD.original_request_kind
)
BEGIN
  SELECT RAISE(ABORT, 'original_event_request_is_immutable');
END;

CREATE TABLE event_responsibilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  responsibility_key TEXT NOT NULL UNIQUE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  area TEXT NOT NULL CHECK (area IN (
    'communications','facilities','production','registration','finance','hospitality',
    'transportation','volunteers','safety_childcare','other'
  )),
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_acknowledgment' CHECK (status IN (
    'awaiting_acknowledgment','acknowledged','blocked','ready','not_needed'
  )),
  notes TEXT NOT NULL DEFAULT '',
  reviewed_facts_version INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  mutation_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(event_id, area),
  UNIQUE(id, event_id)
);
CREATE INDEX idx_event_responsibility_owner ON event_responsibilities(owner_user_id, event_id);

ALTER TABLE event_work_items ADD COLUMN responsibility_id INTEGER
  REFERENCES event_responsibilities(id) ON DELETE RESTRICT;
CREATE INDEX idx_event_work_responsibility ON event_work_items(responsibility_id, status);

CREATE TRIGGER event_work_responsibility_same_event_insert
BEFORE INSERT ON event_work_items
WHEN NEW.responsibility_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM event_responsibilities WHERE id = NEW.responsibility_id AND event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'responsibility_must_belong_to_event');
END;
CREATE TRIGGER event_work_responsibility_same_event_update
BEFORE UPDATE OF responsibility_id, event_id ON event_work_items
WHEN NEW.responsibility_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM event_responsibilities WHERE id = NEW.responsibility_id AND event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'responsibility_must_belong_to_event');
END;
