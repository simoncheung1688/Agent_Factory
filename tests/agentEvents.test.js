import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { databaseConfig } from '../src/db.js';
import { EventLogger, INSERT_AGENT_EVENT_SQL } from '../src/eventLogger.js';
import { loadEnv } from '../src/loadEnv.js';
import { runPipeline } from '../src/pipelineRunner.js';
import { createApp } from '../src/server.js';
import { harness } from './helpers.js';

const RAN_REPORT = 'Investigate the RAN drop at cell site TST-12, check the SOP, and draft an incident report';

function memoryQuery() {
  const rows = [];
  let nextId = 1;
  return {
    rows,
    async query(sql, params = []) {
      if (sql.includes('INSERT INTO agent_events')) {
        const row = {
          id: nextId,
          run_id: params[0],
          sequence_num: params[1],
          agent_name: params[2],
          event_type: params[3],
          status: params[4],
          input_payload: params[5] == null ? null : JSON.parse(params[5]),
          output_payload: params[6] == null ? null : JSON.parse(params[6]),
          tool_name: params[7],
          tool_args: params[8] == null ? null : JSON.parse(params[8]),
          tool_result: params[9] == null ? null : JSON.parse(params[9]),
          error_message: params[10],
          duration_ms: params[11],
          parent_event_id: params[12],
          event_timestamp: params[13],
          created_at: new Date().toISOString(),
        };
        nextId += 1;
        rows.push(row);
        return { rows: [{ ...row }] };
      }
      if (sql.includes('FROM agent_events')) {
        const found = rows
          .filter((row) => row.run_id === params[0])
          .sort((left, right) => left.sequence_num - right.sequence_num);
        return { rows: found.map((row) => ({ ...row })) };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

function types(rows) {
  return rows.map((row) => row.event_type);
}

describe('agent_events logging', () => {
  test('schema and insert statement cover the audit columns and indexes', async () => {
    const files = ['001_create_agent_events.sql', '002_add_event_timestamp.sql'];
    const sql = (await Promise.all(files.map((name) => (
      readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
    )))).join('\n');
    for (const column of [
      'id',
      'run_id',
      'sequence_num',
      'agent_name',
      'event_type',
      'status',
      'input_payload',
      'output_payload',
      'tool_name',
      'tool_args',
      'tool_result',
      'error_message',
      'duration_ms',
      'parent_event_id',
      'event_timestamp',
      'created_at',
    ]) {
      assert.match(sql, new RegExp(`\\b${column}\\b`));
      assert.match(INSERT_AGENT_EVENT_SQL, new RegExp(`\\b${column}\\b`));
    }
    assert.match(sql, /agent_events_run_sequence_idx[\s\S]*\(run_id, sequence_num\)/);
    assert.match(sql, /agent_events_run_created_idx[\s\S]*\(run_id, created_at\)/);
    assert.match(sql, /agent_events_agent_created_idx[\s\S]*\(agent_name, created_at\)/);
    assert.match(sql, /agent_events_event_type_idx[\s\S]*\(event_type\)/);
    assert.match(sql, /REFERENCES agent_events \(id\)/);
  });

  test('records a create path, then a reuse path, without using the log as the handoff', async () => {
    const db = memoryQuery();
    const eventLogger = new EventLogger({ query: db.query.bind(db), logger: { log() {}, warn() {} } });
    const { pool, factory } = harness();
    const logged = (request) => runPipeline(request, { pool, factory, eventLogger });

    const first = await logged(RAN_REPORT);
    const createdRows = db.rows.filter((row) => row.run_id === first.runId);

    assert.match(first.runId, /^[0-9a-f-]{36}$/);
    assert.equal(createdRows[0].event_type, 'run_start');
    assert.equal(createdRows[0].input_payload.request, RAN_REPORT);
    assert.equal(createdRows.at(-1).event_type, 'run_end');
    assert.equal(createdRows.at(-1).status, 'success');
    assert.deepEqual(
      createdRows.map((row) => row.sequence_num),
      createdRows.map((_, index) => index + 1),
    );
    assert.equal(createdRows.filter((row) => row.event_type === 'agent_created').length, 3);
    assert.ok(
      createdRows
        .filter((row) => row.event_type === 'agent_selected')
        .every((row) => row.output_payload.decision === 'create' && row.agent_name == null),
    );
    assert.equal(createdRows.filter((row) => row.event_type === 'handoff').length, 2);

    const kpi = createdRows.find((row) => row.tool_name === 'ran.query_kpis');
    assert.equal(kpi.event_type, 'tool_call');
    assert.equal(kpi.tool_args.siteId, 'TST-12');
    assert.equal(typeof kpi.tool_result.dropRatePct, 'number');

    for (const end of createdRows.filter((row) => row.event_type === 'agent_end')) {
      const start = createdRows.find((row) => row.id === end.parent_event_id);
      assert.equal(start.event_type, 'agent_start');
      assert.equal(start.agent_name, end.agent_name);
      assert.equal(typeof end.duration_ms, 'number');
      assert.ok(end.duration_ms >= 0);
    }

    const handoff = createdRows.find((row) => row.event_type === 'handoff');
    assert.equal(handoff.output_payload.to, 'knowledge-retrieval');
    assert.equal(first.result.artifacts[1].data.sopId, 'SOP-RAN-003');

    const stored = await eventLogger.listByRun(first.runId);
    assert.deepEqual(types(stored), types(createdRows));

    const second = await logged(RAN_REPORT);
    assert.deepEqual(second.agents.map((agent) => agent.origin), ['reused', 'reused', 'reused']);
    const reusedRows = db.rows.filter((row) => row.run_id === second.runId);
    assert.notEqual(second.runId, first.runId);
    assert.equal(reusedRows.filter((row) => row.event_type === 'agent_created').length, 0);
    assert.deepEqual(
      reusedRows.filter((row) => row.event_type === 'agent_selected').map((row) => row.output_payload.decision),
      ['reuse', 'reuse', 'reuse'],
    );
    assert.deepEqual(
      reusedRows.filter((row) => row.event_type === 'agent_selected').map((row) => row.agent_name),
      second.agents.map((agent) => agent.name),
    );
    assert.equal(reusedRows.at(-1).output_payload.reused, 3);
    assert.equal(reusedRows.at(-1).output_payload.created, 0);
  });

  test('records error and run_end when an agent fails, and still rejects the run', async () => {
    const db = memoryQuery();
    const eventLogger = new EventLogger({ query: db.query.bind(db), logger: { log() {}, warn() {} } });
    const { pool, factory } = harness();
    const original = factory.createAgent.bind(factory);
    factory.createAgent = (spec) => {
      const agent = original(spec);
      agent.execute = async () => {
        throw new Error('simulated failure');
      };
      return agent;
    };

    await assert.rejects(
      () => runPipeline('Say hello', { pool, factory, eventLogger }),
      /simulated failure/,
    );

    assert.equal(db.rows.at(-2).event_type, 'error');
    assert.equal(db.rows.at(-2).status, 'error');
    assert.equal(db.rows.at(-2).error_message, 'simulated failure');
    assert.equal(db.rows.at(-1).event_type, 'run_end');
    assert.equal(db.rows.at(-1).status, 'error');
    assert.equal(db.rows.filter((row) => row.event_type === 'agent_end').length, 0);
    assert.ok(db.rows.some((row) => row.event_type === 'agent_start'));
  });

  test('keeps the pipeline running when the database write fails', async () => {
    const warnings = [];
    const lines = [];
    let queries = 0;
    const eventLogger = new EventLogger({
      logger: {
        warn: (message) => warnings.push(message),
        log: (message) => lines.push(message),
      },
      query: async () => {
        queries += 1;
        throw new Error('connection refused');
      },
    });
    const { pool, factory } = harness();
    const result = await runPipeline('Say hello', { pool, factory, eventLogger });

    assert.equal(result.summary.created, 1);
    assert.match(result.result.text, /General assistant/);
    assert.ok(queries >= 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /connection refused/);
    assert.ok(lines.length > 1);
    assert.match(lines.at(-1), /run_end/);
  });

  test('does not open a run for an empty request', async () => {
    let queries = 0;
    const eventLogger = new EventLogger({
      query: async () => {
        queries += 1;
        return { rows: [{ id: 1 }] };
      },
      logger: { log() {}, warn() {} },
    });
    const { pool, factory } = harness();
    await assert.rejects(
      () => runPipeline('   ', { pool, factory, eventLogger }),
      /Request text is required/,
    );
    assert.equal(queries, 0);
  });

  test('serves stored rows for a run id', async () => {
    const db = memoryQuery();
    const eventLogger = new EventLogger({ query: db.query.bind(db), logger: { log() {}, warn() {} } });
    const server = createApp({ eventLogger, logger: { log() {} } });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const response = await fetch(`${base}/api/pipeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: 'Say hello' }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200);

      const listed = await fetch(`${base}/api/agent-events?runId=${payload.runId}`);
      const body = await listed.json();
      assert.equal(listed.status, 200);
      assert.equal(body.events[0].event_type, 'run_start');
      assert.equal(body.events.at(-1).event_type, 'run_end');
      assert.equal(body.events.at(-1).status, 'success');

      const missing = await fetch(`${base}/api/agent-events`);
      assert.equal(missing.status, 400);
    } finally {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    }
  });

  test('reads DATABASE_URL ahead of discrete PG variables', () => {
    assert.deepEqual(
      databaseConfig({
        DATABASE_URL: 'postgres://localhost/agent_factory',
        PGHOST: 'other',
      }),
      { connectionString: 'postgres://localhost/agent_factory' },
    );
    assert.deepEqual(
      databaseConfig({
        PGHOST: 'db.internal',
        PGPORT: '5433',
        PGUSER: 'agent',
        PGPASSWORD: 'secret',
        PGDATABASE: 'agent_factory',
      }),
      {
        host: 'db.internal',
        port: 5433,
        user: 'agent',
        password: 'secret',
        database: 'agent_factory',
      },
    );
    assert.equal(databaseConfig({}), null);
  });

  test('loads a dotenv file without overriding existing variables', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-events-'));
    const file = join(dir, '.env');
    await writeFile(file, 'DATABASE_URL=postgres://from-file/db\n# comment\nPGHOST=localhost\n');
    try {
      const env = { DATABASE_URL: 'postgres://already-set/db' };
      loadEnv(file, env);
      assert.equal(env.DATABASE_URL, 'postgres://already-set/db');
      assert.equal(env.PGHOST, 'localhost');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
