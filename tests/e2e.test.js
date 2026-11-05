import assert from 'node:assert/strict';
import { once } from 'node:events';
import { describe, test } from 'node:test';
import { createApp } from '../src/server.js';

const RAN_REPORT = 'Investigate the RAN drop at cell site TST-12, check the SOP, and draft an incident report';

async function startTestServer() {
  const server = createApp();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    server,
    base: `http://127.0.0.1:${port}`,
  };
}

async function post(base, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

describe('end-to-end portal flow', () => {
  test('serves the portal and runs create-then-reuse through the HTTP API', async () => {
    const { server, base } = await startTestServer();
    try {
      const page = await fetch(`${base}/`);
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /Agent Factory/);
      assert.match(html, /Run pipeline/);

      const mcp = await fetch(`${base}/api/mcp`);
      const mcpBody = await mcp.json();
      assert.equal(mcp.status, 200);
      assert.deepEqual(mcpBody.servers.map((server) => server.id), [
        'ran-mcp',
        'knowledge-mcp',
        'topology-mcp',
        'identity-mcp',
        'vendor-mcp',
      ]);

      const styles = await fetch(`${base}/styles.css`);
      assert.equal(styles.status, 200);
      assert.match(styles.headers.get('content-type'), /text\/css/);

      const first = await post(base, '/api/pipeline', { request: RAN_REPORT });
      assert.equal(first.status, 200);
      assert.equal(first.payload.summary.created, 3);
      assert.equal(first.payload.summary.reused, 0);
      assert.match(first.payload.result.text, /TST-12/);
      assert.match(first.payload.result.text, /SOP-RAN-003/);

      const second = await post(base, '/api/pipeline', { request: RAN_REPORT });
      assert.equal(second.status, 200);
      assert.equal(second.payload.summary.created, 0);
      assert.equal(second.payload.summary.reused, 3);
      assert.deepEqual(
        second.payload.agents.map((agent) => agent.agentId),
        first.payload.agents.map((agent) => agent.agentId),
      );

      const pool = await fetch(`${base}/api/pool`);
      const poolBody = await pool.json();
      assert.equal(poolBody.agents.length, 3);
      assert.equal(poolBody.agents[0].metadata.runs, 2);

      const audit = await fetch(`${base}/api/events`);
      const auditBody = await audit.json();
      assert.ok(auditBody.events.length > first.payload.events.length);
      assert.equal(auditBody.events.at(-1).type, 'pipeline.completed');

      const empty = await post(base, '/api/pipeline', { request: '   ' });
      assert.equal(empty.status, 400);

      const reset = await post(base, '/api/pool/reset', {});
      assert.equal(reset.payload.cleared, 3);
      const afterReset = await (await fetch(`${base}/api/pool`)).json();
      assert.deepEqual(afterReset.agents, []);

      const third = await post(base, '/api/pipeline', { request: RAN_REPORT });
      assert.equal(third.payload.summary.created, 3);
      assert.equal(third.payload.summary.reused, 0);
    } finally {
      server.closeAllConnections?.();
      server.close();
      await once(server, 'close');
    }
  });
});
