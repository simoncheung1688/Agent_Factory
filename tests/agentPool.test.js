import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AgentPool } from '../src/agentPool.js';

function sampleAgent(overrides = {}) {
  return {
    id: 'agt_test',
    name: 'Research Analyst 1',
    capability: 'research',
    skills: ['research', 'source-triage'],
    status: 'healthy',
    metadata: { team: 'strategy', capability: 'research' },
    toJSON() {
      return { ...this, toJSON: undefined };
    },
    ...overrides,
  };
}

describe('Agent Pool', () => {
  test('registers an agent and retrieves it by id', () => {
    const pool = new AgentPool();
    const agent = sampleAgent();
    pool.register(agent);
    assert.equal(pool.get(agent.id), agent);
    assert.equal(pool.list().length, 1);
  });

  test('rejects a duplicate id and an agent with no id', () => {
    const pool = new AgentPool();
    pool.register(sampleAgent());
    assert.throws(() => pool.register(sampleAgent()), /already registered/i);
    assert.throws(() => pool.register({ name: 'missing' }), /id is required/i);
  });

  test('finds a healthy agent by capability, skill, and metadata', () => {
    const pool = new AgentPool();
    pool.register(sampleAgent());
    pool.register(sampleAgent({
      id: 'agt_other',
      capability: 'report-writing',
      skills: ['report-writing'],
      metadata: { team: 'ops' },
    }));

    const byCapability = pool.findMatching({ capability: 'research' });
    const bySkill = pool.findMatching({ skills: ['source-triage'] });
    const byMetadata = pool.findMatching({ capability: 'research', metadata: { team: 'strategy' } });
    const miss = pool.findMatching({ capability: 'research', metadata: { team: 'ops' } });

    assert.equal(byCapability.id, 'agt_test');
    assert.equal(bySkill.id, 'agt_test');
    assert.equal(byMetadata.id, 'agt_test');
    assert.equal(miss, null);
  });

  test('skips unavailable agents unless that status is requested', () => {
    const pool = new AgentPool();
    const agent = sampleAgent();
    pool.register(agent);
    pool.setStatus(agent.id, 'unavailable');

    assert.equal(pool.findMatching({ capability: 'research' }), null);
    assert.equal(pool.findMatching({ capability: 'research', status: 'unavailable' }).id, agent.id);
    assert.throws(() => pool.setStatus('missing', 'healthy'), /Unknown agent/);
    assert.throws(() => pool.setStatus(agent.id, 'paused'), /Status must be/);
  });

  test('clears the registry', () => {
    const pool = new AgentPool();
    pool.register(sampleAgent());
    assert.equal(pool.clear(), 1);
    assert.equal(pool.get('agt_test'), null);
  });
});
