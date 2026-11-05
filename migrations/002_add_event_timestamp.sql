-- When the pipeline recorded the event.
-- created_at remains the time PostgreSQL stored the row.

ALTER TABLE agent_events
  ADD COLUMN event_timestamp TIMESTAMPTZ;

UPDATE agent_events
  SET event_timestamp = created_at
  WHERE event_timestamp IS NULL;

ALTER TABLE agent_events
  ALTER COLUMN event_timestamp SET DEFAULT NOW();

ALTER TABLE agent_events
  ALTER COLUMN event_timestamp SET NOT NULL;

COMMENT ON COLUMN agent_events.event_timestamp IS
  'When the pipeline recorded the event.';

CREATE INDEX IF NOT EXISTS agent_events_event_timestamp_idx
  ON agent_events (event_timestamp);
