-- Append-only observability log for one pipeline run.
-- Agents still hand payloads to each other in process. This table is not a queue.

CREATE TABLE IF NOT EXISTS agent_events (
  id              BIGSERIAL PRIMARY KEY,
  run_id          UUID NOT NULL,
  sequence_num    INTEGER NOT NULL,
  agent_name      TEXT,
  event_type      TEXT NOT NULL,
  status          TEXT,
  input_payload   JSONB,
  output_payload  JSONB,
  tool_name       TEXT,
  tool_args       JSONB,
  tool_result     JSONB,
  error_message   TEXT,
  duration_ms     INTEGER,
  parent_event_id BIGINT REFERENCES agent_events (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT agent_events_sequence_positive CHECK (sequence_num >= 1),
  CONSTRAINT agent_events_duration_nonnegative CHECK (duration_ms IS NULL OR duration_ms >= 0),
  CONSTRAINT agent_events_type_not_blank CHECK (length(btrim(event_type)) > 0),
  CONSTRAINT agent_events_status_known CHECK (
    status IS NULL OR status IN ('success', 'error', 'running', 'skipped')
  )
);

COMMENT ON TABLE agent_events IS
  'Audit and debug log for pipeline runs. Not the channel agents use to pass work.';

COMMENT ON COLUMN agent_events.run_id IS
  'Groups every event from a single user request.';

COMMENT ON COLUMN agent_events.sequence_num IS
  'Order of events inside one run. Unique per run_id.';

COMMENT ON COLUMN agent_events.parent_event_id IS
  'Optional link to the event that caused this one, such as agent_end back to agent_start.';

CREATE UNIQUE INDEX IF NOT EXISTS agent_events_run_sequence_idx
  ON agent_events (run_id, sequence_num);

CREATE INDEX IF NOT EXISTS agent_events_run_created_idx
  ON agent_events (run_id, created_at);

CREATE INDEX IF NOT EXISTS agent_events_agent_created_idx
  ON agent_events (agent_name, created_at);

CREATE INDEX IF NOT EXISTS agent_events_event_type_idx
  ON agent_events (event_type);

CREATE INDEX IF NOT EXISTS agent_events_parent_idx
  ON agent_events (parent_event_id);
