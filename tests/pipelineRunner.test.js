import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EventLog } from '../src/eventLog.js';
import { planRequest } from '../src/intentPlanner.js';
import { runPipeline } from '../src/pipelineRunner.js';
import { harness } from './helpers.js';

const RAN_REPORT = 'Investigate the RAN drop at cell site TST-12, check the SOP, and draft an incident report';

describe('Pipeline Runner', () => {
  test('plans capabilities, tools, and policy without creating agents', () => {
    const plan = planRequest(RAN_REPORT);
    assert.deepEqual(plan.capabilities, ['ran-analysis', 'knowledge-retrieval', 'report-writing']);
    assert.equal(plan.label, 'RAN Analyst → Knowledge Analyst → Report Writer');
    assert.deepEqual(plan.steps[0].tools, ['ran.query_kpis', 'ran.list_cells']);
    assert.equal(plan.steps[0].policy.dataScope, 'ran-internal');
    assert.deepEqual(plan.steps[0].policy.mcpServers, ['ran-mcp']);
    assert.deepEqual(planRequest('Say hello').capabilities, ['general-assistant']);
  });

  test('creates specialists on a pool miss, then reuses them on the next request', async () => {
    const { pool, factory, run } = harness();
    const first = await run(RAN_REPORT);

    assert.deepEqual(first.agents.map((agent) => agent.origin), ['created', 'created', 'created']);
    assert.equal(first.summary.created, 3);
    assert.equal(first.summary.reused, 0);
    assert.equal(pool.list().length, 3);
    assert.deepEqual(
      first.events.map((event) => event.type),
      [
        'request.received',
        'intent.extracted',
        'pool.lookup',
        'agent.created',
        'audit.allowed',
        'task.completed',
        'handoff',
        'pool.lookup',
        'agent.created',
        'audit.allowed',
        'task.completed',
        'handoff',
        'pool.lookup',
        'agent.created',
        'audit.allowed',
        'task.completed',
        'pipeline.completed',
      ],
    );

    const original = factory.createAgent.bind(factory);
    let factoryCalls = 0;
    factory.createAgent = (...args) => {
      factoryCalls += 1;
      return original(...args);
    };

    const second = await run(RAN_REPORT);
    assert.equal(factoryCalls, 0);
    assert.deepEqual(second.agents.map((agent) => agent.origin), ['reused', 'reused', 'reused']);
    assert.deepEqual(
      second.agents.map((agent) => agent.agentId),
      first.agents.map((agent) => agent.agentId),
    );
    assert.equal(pool.list().length, 3);
    assert.equal(pool.get(first.agents[0].agentId).metadata.runs, 2);
    assert.equal(pool.get(first.agents[0].agentId).metadata.lastSessionId, second.session.id);
  });

  test('reuses a healthy match and creates only the missing capabilities', async () => {
    const { pool, factory, run } = harness();
    const existing = factory.createAgent({ capability: 'knowledge-retrieval' });
    const result = await run(RAN_REPORT);
    const byCapability = Object.fromEntries(result.agents.map((agent) => [agent.capability, agent]));

    assert.equal(byCapability['knowledge-retrieval'].origin, 'reused');
    assert.equal(byCapability['knowledge-retrieval'].agentId, existing.id);
    assert.equal(byCapability['ran-analysis'].origin, 'created');
    assert.equal(byCapability['report-writing'].origin, 'created');
    assert.equal(pool.list({ status: 'healthy' }).length, 3);
  });

  test('does not reuse an unavailable agent', async () => {
    const { pool, factory, run } = harness();
    const existing = factory.createAgent({ capability: 'ran-analysis' });
    pool.setStatus(existing.id, 'unavailable');

    const result = await run('Investigate the RAN drop at cell site TST-12 and draft an incident report');
    const ran = result.agents.find((agent) => agent.capability === 'ran-analysis');

    assert.equal(ran.origin, 'created');
    assert.notEqual(ran.agentId, existing.id);
    assert.equal(pool.get(existing.id).status, 'unavailable');
    assert.equal(pool.get(ran.agentId).status, 'healthy');
  });

  test('passes earlier structured output into the next agent', async () => {
    const { run } = harness();
    const result = await run(RAN_REPORT);
    const ran = result.result.artifacts.find((item) => item.capability === 'ran-analysis');
    const knowledge = result.result.artifacts.find((item) => item.capability === 'knowledge-retrieval');
    const report = result.result.artifacts.find((item) => item.capability === 'report-writing');

    assert.equal(ran.data.siteId, 'TST-12');
    assert.ok(ran.data.kpis.dropRatePct > ran.data.kpis.baselineDropRatePct);
    assert.equal(knowledge.data.sopId, 'SOP-RAN-003');
    assert.match(result.result.text, /TST-12/);
    assert.match(result.result.text, new RegExp(String(ran.data.kpis.dropRatePct)));
    assert.match(result.result.text, /SOP-RAN-003/);
    assert.deepEqual(report.data.citedAgents, [ran.agentId, knowledge.agentId]);
    assert.equal(result.result.text, report.data.deliverable);
  });

  test('appends each run to the shared event log', async () => {
    const { pool, factory } = harness();
    const audit = new EventLog();
    const request = 'Look up the SOP for handover failures and summarize the steps';
    const first = await runPipeline(request, { pool, factory, events: audit });
    const second = await runPipeline(request, { pool, factory, events: audit });

    assert.equal(audit.list().length, first.events.length + second.events.length);
    assert.equal(audit.list()[0].type, 'request.received');
    assert.equal(audit.list().at(-1).type, 'pipeline.completed');
    assert.equal(second.summary.reused, second.summary.steps);
    assert.ok(first.events.length >= 2);
  });

  test('runs the new specialists and records which MCP server each tool used', async () => {
    const { run } = harness();
    const alarms = await run('Triage critical alarms at TST-12 and map neighbour topology');
    assert.deepEqual(alarms.intent.capabilities, ['alarm-triage', 'topology-mapping']);
    assert.match(alarms.result.text, /ALM-1044/);
    assert.match(alarms.result.text, /Topology MCP/);
    const alarmArtifact = alarms.result.artifacts[0];
    assert.deepEqual(alarmArtifact.data.toolCalls, [
      { tool: 'ran.list_alarms', mcpServer: 'ran-mcp' },
      { tool: 'ran.query_kpis', mcpServer: 'ran-mcp' },
    ]);

    const access = await run('Review who can access radio operations in Keycloak and open a vendor ticket for site TST-12');
    assert.deepEqual(access.intent.capabilities, ['access-review', 'vendor-liaison']);
    assert.match(access.result.text, /Vendor MCP/);
    assert.match(access.result.text, /VND-1008/);

    const change = await run('Plan a maintenance window for site TST-12');
    assert.deepEqual(change.intent.capabilities, ['change-planner']);
    assert.match(change.result.text, /SOP-CHG-006/);
    assert.match(change.result.text, /Knowledge MCP/);
    assert.match(change.result.text, /Topology MCP/);
    assert.deepEqual(
      change.result.artifacts[0].data.toolCalls.map((call) => call.mcpServer),
      ['knowledge-mcp', 'knowledge-mcp', 'topology-mcp', 'topology-mcp'],
    );
  });

  test('rejects an empty request', async () => {
    const { run } = harness();
    await assert.rejects(() => run('   '), /Request text is required/);
  });
});
