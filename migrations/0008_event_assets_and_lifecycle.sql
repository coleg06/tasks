PRAGMA foreign_keys = ON;

ALTER TABLE event_asset_versions ADD COLUMN original_filename TEXT;
ALTER TABLE event_asset_versions ADD COLUMN content_type TEXT;
ALTER TABLE event_asset_versions ADD COLUMN size_bytes INTEGER;
ALTER TABLE event_asset_versions ADD COLUMN object_key TEXT;
ALTER TABLE event_asset_versions ADD COLUMN is_final INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_asset_versions ADD COLUMN finalized_at TEXT;
ALTER TABLE event_asset_versions ADD COLUMN drive_delivery_status TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE event_asset_versions ADD COLUMN drive_file_id TEXT;
ALTER TABLE event_asset_versions ADD COLUMN drive_web_view_link TEXT;
ALTER TABLE event_asset_versions ADD COLUMN drive_delivered_at TEXT;
ALTER TABLE event_asset_versions ADD COLUMN delivery_error TEXT;

CREATE UNIQUE INDEX uq_event_asset_object_key ON event_asset_versions(object_key)
  WHERE object_key IS NOT NULL;
CREATE INDEX idx_event_asset_final ON event_asset_versions(deliverable_id, is_final, version DESC);
CREATE INDEX idx_event_asset_drive_queue ON event_asset_versions(drive_delivery_status, finalized_at)
  WHERE is_final = 1;

CREATE TABLE workflow_tracking_started (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  started_at TEXT NOT NULL
);

INSERT INTO workflow_tracking_started (id, started_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%SZ','now'));
