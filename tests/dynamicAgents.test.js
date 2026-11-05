import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EventLogger } from '../src/eventLogger.js';
import { createLlmPlanner, DEFAULT_MODEL, parsePlannerJson, completeWithPi } from '../src/llmPlanner.js';
import { guardAuditRead, HARNESS_ID } from '../src/piHarness.js';
import { runPipeline } from '../src/pipelineRunner.js';
import { harness } from './helpers.js';

const PARCEL = 'File the blue parcel from dock 4 under the name of a clerk who does not exist in any catalogue';

function parcelPlan() {
  return {
    label: 'Parcel Clerk',
    capabilities: ['parcel-clerk'],
    steps: [{
      capability: 'parcel-clerk',
      label: 'Parcel Clerk',
      skills: ['parcel-intake'],
      tools: ['assistant.respond'],
      mcpServers: [],
      policy: { timeoutMs: 6000, maxToolCalls: 3, dataScope: 'dynamic' },
      task: 'Acknowledge the parcel and name the dock.',
      origin: 'dynamic',
    }],
  };
}

describe('dynamic agents and the pi harness', () => {
  test('creates a dynamic agent from arbitrary input and reuses it', async () => {
    const { pool, run } = harness({ plan: async () => parcelPlan() });
    const first = await run(PARCEL);

    assert.deepEqual(first.intent.capabilities, ['parcel-clerk']);
    assert.equal(first.agents[0].kind, 'dynamic');
    assert.equal(first.agents[0].origin, 'created');
    assert.equal(first.agents[0].spec.label, 'Parcel Clerk');
    assert.equal(first.agents[0].spec.origin, 'dynamic');
    assert.equal(first.agents[0].auditAccess.allowed, false);
    assert.equal(pool.list()[0].metadata.origin, 'dynamic');
    assert.match(first.result.text, /Parcel Clerk/);
    assert.equal(first.agents[0].harness ?? first.result.artifacts[0].data.harness, HARNESS_ID);

    const second = await run(PARCEL);
    assert.equal(second.agents[0].origin, 'reused');
    assert.equal(second.agents[0].agentId, first.agents[0].agentId);
    assert.equal(second.agents[0].kind, 'dynamic');
    assert.equal(second.agents[0].auditAccess.allowed, false);
    assert.equal(pool.list().length, 1);
  });

  test('parses an LLM spec that is not in the catalogue', () => {
    const plan = parsePlannerJson(`{
      "steps": [{
        "capability": "tide-watcher",
        "label": "Tide Watcher",
        "skills": ["harbour-watch"],
        "tools": ["assistant.respond"],
        "mcpServers": [],
        "policy": { "timeoutMs": 5000, "maxToolCalls": 2, "dataScope": "harbour" },
        "task": "Report the tide at the named dock."
      }]
    }`);
    assert.equal(plan[0].origin, 'dynamic');
    assert.equal(plan[0].capability, 'tide-watcher');
    assert.equal(plan[0].label, 'Tide Watcher');
    assert.deepEqual(plan[0].skills, ['harbour-watch']);
    assert.equal(plan[0].policy.dataScope, 'harbour');
  });

  test('the default model is grok-4.7 and the xAI key is read from the environment', async () => {
    assert.equal(DEFAULT_MODEL, 'grok-4.7');
    await assert.rejects(
      () => completeWithPi('system', 'user', {}),
      /XAI_API_KEY/,
    );
  });

  test('the planner calls the supplied LLM and keeps a catalogue match predefined', async () => {
    let prompted = '';
    const plan = createLlmPlanner({
      complete: async (_system, user) => {
        prompted = user;
        return JSON.stringify({
          steps: [{ capability: 'report-writing' }],
        });
      },
    });
    const resolved = await plan('write the dock report');
    assert.match(prompted, /write the dock report/);
    assert.equal(resolved.steps[0].origin, 'predefined');
    assert.equal(resolved.steps[0].label, 'Report Writer');
    assert.deepEqual(resolved.steps[0].tools, ['report.compose']);
  });

  test('predefined agents read agent_events through the pi harness', async () => {
    const { factory } = harness();
    const agent = factory.createAgent({ capability: 'report-writing' });
    const seen = [];
    const result = await guardAuditRead(agent, {
      runId: 'run-predefined',
      readEvents: async (runId) => {
        seen.push(runId);
        return [{ event_type: 'run_start' }];
      },
    });

    assert.equal(agent.metadata.origin, 'predefined');
    assert.equal(result.harness, HARNESS_ID);
    assert.equal(result.access.allowed, true);
    assert.deepEqual(seen, ['run-predefined']);
    assert.equal(result.access.rowCount, 1);
    assert.equal(result.pi.blocked, false);
    assert.ok(result.pi.messages.includes('toolResult'));
  });

  test('dynamic agents are blocked from reading agent_events and the denial is logged', async () => {
    const { pool, factory } = harness();
    let reads = 0;
    const written = [];
    const eventLogger = new EventLogger({
      query: async (sql, params) => {
        if (sql.includes('INSERT INTO agent_events')) {
          written.push({ type: params[3], status: params[4], tool: params[7], error: params[10] });
          return { rows: [{ id: written.length }] };
        }
        return { rows: [] };
      },
      logger: { log() {}, warn() {} },
    });
    const readEvents = async () => {
      reads += 1;
      return [{ event_type: 'run_start', secret: true }];
    };
    eventLogger.listByRun = readEvents;

    const result = await runPipeline(PARCEL, {
      pool,
      factory,
      eventLogger,
      plan: async () => parcelPlan(),
    });

    assert.equal(reads, 0);
    assert.equal(result.agents[0].auditAccess.allowed, false);
    assert.match(result.agents[0].auditAccess.reason, /not allowed/);
    assert.equal(result.result.artifacts[0].data.harness, HARNESS_ID);
    const denied = written.filter((row) => row.type === 'audit_denied');
    assert.equal(denied.length, 1);
    assert.equal(denied[0].tool, 'agent_events.read');
    assert.equal(denied[0].status, 'error');
    assert.match(denied[0].error, /not allowed/);

    const predefined = factory.createAgent({ capability: 'knowledge-retrieval' });
    const allowed = await predefined.execute({
      request: 'check the SOP',
      runId: 'run-predefined',
      context: {},
      priorOutputs: [],
      session: { id: 'ses_test' },
      auditReader: async () => [{ event_type: 'run_start' }],
    });
    assert.equal(allowed.auditAccess.allowed, true);
    assert.equal(allowed.auditAccess.rowCount, 1);
    assert.equal(allowed.harness.id, HARNESS_ID);
  });
});
