PRAGMA foreign_keys = ON;

CREATE INDEX idx_event_work_items_owner
  ON event_work_items(owner_user_id, status, due_at)
  WHERE owner_user_id IS NOT NULL;
