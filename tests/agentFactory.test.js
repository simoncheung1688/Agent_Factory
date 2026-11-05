import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { harness } from './helpers.js';

describe('Agent Factory', () => {
  test('creates one specialist, loads its skill, applies policy, and registers it', () => {
    const { pool, factory } = harness();
    const agent = factory.createAgent({
      capability: 'research',
      metadata: { team: 'strategy' },
    });
    const skillDoc = readFileSync(new URL('../skills/research.md', import.meta.url), 'utf8');

    assert.match(agent.id, /^agt_[0-9a-f]{8}$/);
    assert.equal(agent.name, 'Research Analyst 1');
    assert.equal(agent.status, 'healthy');
    assert.deepEqual(agent.skills, ['research', 'source-triage']);
    assert.deepEqual(agent.tools, ['research.scan']);
    assert.equal(agent.policy.identity, `agent:${agent.id}`);
    assert.deepEqual(agent.policy.allowedTools, ['research.scan']);
    assert.equal(agent.policy.dataScope, 'internal-knowledge');
    assert.deepEqual(agent.policy.mcpServers, ['knowledge-mcp']);
    assert.equal(agent.skillDoc, skillDoc);
    assert.equal(agent.metadata.createdBy, 'agent-factory');
    assert.equal(agent.metadata.team, 'strategy');
    assert.equal(agent.metadata.skillFile, 'research.md');
    assert.equal(pool.get(agent.id), agent);
  });

  test('numbers further agents of the same capability', () => {
    const { factory } = harness();
    const first = factory.createAgent({ capability: 'ran-analysis' });
    const second = factory.createAgent({ capability: 'ran-analysis' });
    assert.equal(first.name, 'RAN Analyst 1');
    assert.equal(second.name, 'RAN Analyst 2');
    assert.notEqual(first.id, second.id);
  });

  test('rejects a missing or unknown capability', () => {
    const { factory } = harness();
    assert.throws(() => factory.createAgent({}), /requires a capability/);
    assert.throws(() => factory.createAgent({ capability: 'vendor-shell' }), /No skill catalogue entry/);
  });

  test('the MCP gateway allows a tool only when the agent is authorized for that server', () => {
    const { factory } = harness();
    const alarms = factory.createAgent({
      capability: 'alarm-triage',
      tools: ['ran.list_alarms', 'topology.list_neighbors'],
      policy: { mcpServers: ['ran-mcp'], maxToolCalls: 4 },
    });
    const alarmView = alarms.callTool('ran.list_alarms', { siteId: 'TST-12' });
    assert.equal(alarmView.alarms[0].id, 'ALM-1044');
    assert.throws(() => alarms.callTool('topology.list_neighbors', { siteId: 'TST-12' }), /MCP gateway denied/);

    const planner = factory.createAgent({ capability: 'change-planner' });
    assert.deepEqual(planner.policy.mcpServers, ['knowledge-mcp', 'topology-mcp']);
    const sop = planner.callTool('knowledge.search', { query: 'maintenance window' });
    const neighbors = planner.callTool('topology.list_neighbors', { siteId: 'TST-12' });
    assert.equal(sop.id, 'SOP-CHG-006');
    assert.equal(neighbors.neighbors.length, 3);
  });

  test('runtime policy blocks tools that were not granted and enforces the call limit', () => {
    const { factory } = harness();
    const ran = factory.createAgent({ capability: 'ran-analysis' });
    assert.throws(() => ran.callTool('vendor.shell', {}), /denied/i);

    const writer = factory.createAgent({ capability: 'report-writing' });
    writer.callTool('report.compose', {});
    writer.callTool('report.compose', {});
    assert.throws(() => writer.callTool('report.compose', {}), /limit/i);
  });
});
