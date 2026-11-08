import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EventLogger } from '../src/eventLogger.js';
import { createLlmPlanner, DEFAULT_MODEL, normalizeStep, parsePlannerJson, completeWithPi, stepsToPlan } from '../src/llmPlanner.js';
import { guardAuditRead, HARNESS_ID } from '../src/piHarness.js';
import { runPipeline } from '../src/pipelineRunner.js';
import { harness } from './helpers.js';

const PARCEL = 'File the blue parcel from dock 4 under the name of a clerk who does not exist in any catalogue';

function weatherPlan({
  capability = 'weather-lookup',
  label = 'Weather Analyst',
  skills = ['weather-query'],
} = {}) {
  return {
    label,
    capabilities: [capability],
    steps: [{
      capability,
      label,
      skills,
      tools: ['assistant.respond'],
      mcpServers: [],
      policy: { timeoutMs: 8000, maxToolCalls: 4, dataScope: 'dynamic' },
      task: 'Report the weather for the request.',
      origin: 'dynamic',
    }],
  };
}

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

  test('reuses a dynamic agent with the same capability when the skills differ', async () => {
    const plans = [
      weatherPlan({ skills: ['weather-query'], label: 'Weather Analyst' }),
      weatherPlan({ skills: ['weather-forecast'], label: 'Conditions Desk' }),
    ];
    let call = 0;
    const { pool, run } = harness({ plan: async () => plans[call++] });
    const first = await run('What is the weather in Victoria Harbour?');
    const second = await run('Will it rain over Victoria Harbour tomorrow?');

    assert.equal(first.agents[0].origin, 'created');
    assert.equal(first.agents[0].spec.label, 'Weather Analyst');
    assert.equal(second.agents[0].origin, 'reused');
    assert.equal(second.agents[0].agentId, first.agents[0].agentId);
    assert.equal(second.agents[0].capability, 'weather-lookup');
    assert.deepEqual(pool.get(first.agents[0].agentId).skills, ['weather-query']);
    assert.equal(pool.list().length, 1);
  });

  test('reuses a dynamic agent with the same label when the capability slug differs', async () => {
    const plans = [
      weatherPlan({ capability: 'weather-lookup', skills: ['weather-query'] }),
      weatherPlan({ capability: 'wx-brief', label: 'Weather Analyst', skills: ['sky-watch'] }),
    ];
    let call = 0;
    const { pool, run } = harness({ plan: async () => plans[call++] });
    const first = await run('What is the weather in Victoria Harbour?');
    const second = await run('Give me a weather brief for Victoria Harbour');

    assert.equal(second.agents[0].origin, 'reused');
    assert.equal(second.agents[0].agentId, first.agents[0].agentId);
    assert.equal(second.agents[0].capability, 'weather-lookup');
    assert.equal(second.agents[0].spec.label, 'Weather Analyst');
    assert.deepEqual(pool.get(first.agents[0].agentId).skills, ['weather-query']);
    assert.equal(pool.list().length, 1);
  });

  test('creates a second dynamic agent when the label and capability both differ', async () => {
    const plans = [
      weatherPlan(),
      weatherPlan({
        capability: 'weather-forecast',
        label: 'Weather Forecaster',
        skills: ['weather-forecast'],
      }),
    ];
    let call = 0;
    const { pool, run } = harness({ plan: async () => plans[call++] });
    const first = await run('What is the weather in Victoria Harbour?');
    const second = await run('Forecast the weather for Victoria Harbour');

    assert.equal(second.agents[0].origin, 'created');
    assert.equal(second.agents[0].kind, 'dynamic');
    assert.notEqual(second.agents[0].agentId, first.agents[0].agentId);
    assert.equal(second.agents[0].capability, 'weather-forecast');
    assert.equal(second.agents[0].spec.label, 'Weather Forecaster');
    assert.equal(pool.list().length, 2);
  });

  test('predefined catalogue steps keep exact skill matching and skip dynamic reuse', async () => {
    const { pool, factory, run } = harness({
      plan: async () => stepsToPlan([normalizeStep({ capability: 'report-writing' })]),
    });
    const decoy = factory.createAgent({
      capability: 'custom-report',
      label: 'Report Writer',
      skills: ['loose-drafting'],
      task: 'Draft a note.',
    });
    const partial = factory.createAgent({
      capability: 'report-writing',
      skills: ['report-writing'],
    });

    const created = await run('Draft the dock report');
    assert.equal(created.agents[0].origin, 'created');
    assert.equal(created.agents[0].kind, 'predefined');
    assert.equal(created.agents[0].capability, 'report-writing');
    assert.notEqual(created.agents[0].agentId, decoy.id);
    assert.notEqual(created.agents[0].agentId, partial.id);
    assert.deepEqual(pool.get(created.agents[0].agentId).skills, ['report-writing', 'drafting']);
    assert.equal(pool.get(decoy.id).metadata.runs, 0);
    assert.equal(pool.get(partial.id).metadata.runs, 0);
    assert.equal(pool.list().length, 3);

    const reused = await run('Draft the dock report again');
    assert.equal(reused.agents[0].origin, 'reused');
    assert.equal(reused.agents[0].kind, 'predefined');
    assert.equal(reused.agents[0].agentId, created.agents[0].agentId);
    assert.notEqual(reused.agents[0].agentId, partial.id);
    assert.equal(pool.get(decoy.id).metadata.runs, 0);
    assert.equal(pool.list().length, 3);
  });

  test('prefers the same capability slug, then the larger skill-word overlap', async () => {
    let preferCapability = true;
    const { pool, factory, run } = harness({
      plan: async () => (preferCapability
        ? weatherPlan({
          capability: 'weather-lookup',
          label: 'Weather Analyst',
          skills: ['weather-forecast'],
        })
        : weatherPlan({
          capability: 'other-desk',
          label: 'Weather Analyst',
          skills: ['weather-forecast'],
        })),
    });
    const broadLabel = factory.createAgent({
      capability: 'wx-brief',
      label: 'Weather Analyst',
      skills: ['tide-chart'],
      task: 'Watch the tide.',
    });
    const closerLabel = factory.createAgent({
      capability: 'sky-watch',
      label: 'Weather Analyst',
      skills: ['weather-query'],
      task: 'Watch the sky.',
    });
    const sameCapability = factory.createAgent({
      capability: 'weather-lookup',
      label: 'Forecast Desk',
      skills: ['marine'],
      task: 'Desk forecast.',
    });

    const byCapability = await run('What is the weather in Victoria Harbour?');
    assert.equal(byCapability.agents[0].origin, 'reused');
    assert.equal(byCapability.agents[0].agentId, sameCapability.id);
    assert.equal(pool.list().length, 3);

    preferCapability = false;
    const bySkills = await run('Describe the sky over Victoria Harbour');
    assert.equal(bySkills.agents[0].origin, 'reused');
    assert.equal(bySkills.agents[0].agentId, closerLabel.id);
    assert.notEqual(bySkills.agents[0].agentId, broadLabel.id);
    assert.equal(pool.list().length, 3);
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
    assert.doesNotMatch(prompted, /Existing dynamic agents/);
    assert.equal(resolved.steps[0].origin, 'predefined');
    assert.equal(resolved.steps[0].label, 'Report Writer');
    assert.deepEqual(resolved.steps[0].tools, ['report.compose']);
  });

  test('the planner prompt lists dynamic agents and tells the model to copy them', async () => {
    let prompted = '';
    const plan = createLlmPlanner({
      dynamicAgents: [{
        capability: 'weather-lookup',
        label: 'Weather Analyst',
        skills: ['weather-query'],
      }],
      complete: async (_system, user) => {
        prompted = user;
        return JSON.stringify({
          steps: [{
            capability: 'weather-lookup',
            label: 'Weather Analyst',
            skills: ['weather-query'],
            tools: ['assistant.respond'],
            task: 'Report the weather.',
          }],
        });
      },
    });
    const resolved = await plan('will it rain over Victoria Harbour');
    assert.match(prompted, /will it rain over Victoria Harbour/);
    assert.match(prompted, /"capability":"weather-lookup"/);
    assert.match(prompted, /"label":"Weather Analyst"/);
    assert.match(prompted, /"weather-query"/);
    assert.match(prompted, /copy that agent's capability, label, and skills exactly/);
    assert.equal(resolved.steps[0].origin, 'dynamic');
    assert.equal(resolved.steps[0].capability, 'weather-lookup');
    assert.deepEqual(resolved.steps[0].skills, ['weather-query']);
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
