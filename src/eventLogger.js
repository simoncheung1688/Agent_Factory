/**
 * Writes pipeline observability rows to agent_events.
 * Logging failures are reported and swallowed so a database outage
 * cannot stop the Pipeline Runner from handing payloads between agents.
 */

export const INSERT_AGENT_EVENT_SQL = `
INSERT INTO agent_events (
  run_id,
  sequence_num,
  agent_name,
  event_type,
  status,
  input_payload,
  output_payload,
  tool_name,
  tool_args,
  tool_result,
  error_message,
  duration_ms,
  parent_event_id,
  event_timestamp
) VALUES (
  $1, $2, $3, $4, $5,
  $6::jsonb, $7::jsonb, $8, $9::jsonb, $10::jsonb,
  $11, $12, $13, $14
)
RETURNING
  id, run_id, sequence_num, agent_name, event_type, status,
  input_payload, output_payload, tool_name, tool_args, tool_result,
  error_message, duration_ms, parent_event_id, event_timestamp, created_at
`;

export const LIST_AGENT_EVENTS_SQL = `
SELECT
  id, run_id, sequence_num, agent_name, event_type, status,
  input_payload, output_payload, tool_name, tool_args, tool_result,
  error_message, duration_ms, parent_event_id, event_timestamp, created_at
FROM agent_events
WHERE run_id = $1
ORDER BY sequence_num ASC
`;

function toJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

export class EventLogger {
  /**
   * @param {{
   *   query?: (text: string, params?: unknown[]) => Promise<{ rows: object[] }>,
   *   ping?: () => Promise<unknown>,
   *   close?: () => Promise<unknown>,
   *   logger?: { log?: Function, warn?: Function }
   * }} [options]
   */
  constructor({ query = null, ping = null, close = null, logger = console } = {}) {
    this.query = query;
    this.ping = ping;
    this.closePool = close;
    this.logger = logger;
    this.mode = query ? 'database' : 'disabled';
    this.sequences = new Map();
    this.warned = false;
  }

  available() {
    return this.mode === 'database';
  }

  #nextSequence(runId) {
    const next = (this.sequences.get(runId) ?? 0) + 1;
    this.sequences.set(runId, next);
    return next;
  }

  #fail(error) {
    if (this.warned) return;
    this.warned = true;
    this.mode = 'fallback';
    const message = error?.message || 'unknown database error';
    this.logger.warn?.(
      `[agent_events] database unavailable (${message}). Further events will be written to the console.`,
    );
  }

  #consoleLine(entry) {
    this.logger.log?.(`[agent_events] ${JSON.stringify(entry)}`);
  }

  async probe() {
    if (!this.ping) {
      this.logger.log?.(
        '[agent_events] PostgreSQL is not configured. Pipeline events stay in the process log.',
      );
      return false;
    }
    try {
      await this.ping();
      this.logger.log?.('[agent_events] PostgreSQL logging enabled');
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  /**
   * Insert one event. Never throws.
   * Returns the inserted row when the database accepts it, otherwise a local preview.
   */
  async write(event = {}) {
    if (!event.runId || !event.eventType) {
      this.logger.warn?.('[agent_events] skipped a log entry missing runId or eventType');
      return { persisted: false, id: null };
    }

    const sequenceNum = this.#nextSequence(event.runId);
    const entry = {
      runId: event.runId,
      sequenceNum,
      agentName: event.agentName ?? null,
      eventType: event.eventType,
      status: event.status ?? null,
      input: event.input ?? null,
      output: event.output ?? null,
      toolName: event.toolName ?? null,
      toolArgs: event.toolArgs ?? null,
      toolResult: event.toolResult ?? null,
      errorMessage: event.errorMessage ?? null,
      durationMs: event.durationMs ?? null,
      parentEventId: event.parentEventId ?? null,
      eventTimestamp: event.eventTimestamp ?? new Date().toISOString(),
    };

    if (this.mode !== 'database') {
      if (this.mode === 'fallback') this.#consoleLine(entry);
      return { persisted: false, id: null, ...entry };
    }

    const params = [
      entry.runId,
      entry.sequenceNum,
      entry.agentName,
      entry.eventType,
      entry.status,
      toJson(entry.input),
      toJson(entry.output),
      entry.toolName,
      toJson(entry.toolArgs),
      toJson(entry.toolResult),
      entry.errorMessage,
      entry.durationMs,
      entry.parentEventId,
      entry.eventTimestamp,
    ];

    try {
      const result = await this.query(INSERT_AGENT_EVENT_SQL, params);
      const row = result?.rows?.[0] ?? null;
      return { persisted: true, id: row?.id ?? null, ...entry, row };
    } catch (error) {
      this.#fail(error);
      this.#consoleLine(entry);
      return { persisted: false, id: null, ...entry };
    }
  }

  async listByRun(runId) {
    if (!this.query) return [];
    const result = await this.query(LIST_AGENT_EVENTS_SQL, [runId]);
    return result.rows ?? [];
  }

  async close() {
    if (this.closePool) await this.closePool();
  }
}
