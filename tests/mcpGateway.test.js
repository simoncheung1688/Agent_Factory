import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { listMcpServers, serverForTool } from '../src/mcpGateway.js';

describe('MCP gateway', () => {
  test('publishes five servers and routes each tool to one of them', () => {
    const servers = listMcpServers();
    assert.deepEqual(servers.map((server) => server.id), [
      'ran-mcp',
      'knowledge-mcp',
      'topology-mcp',
      'identity-mcp',
      'vendor-mcp',
    ]);
    assert.equal(serverForTool('ran.list_alarms').id, 'ran-mcp');
    assert.equal(serverForTool('knowledge.read_sop').id, 'knowledge-mcp');
    assert.equal(serverForTool('topology.trace_path').id, 'topology-mcp');
    assert.equal(serverForTool('identity.list_roles').id, 'identity-mcp');
    assert.equal(serverForTool('vendor.draft_ticket').id, 'vendor-mcp');
    assert.equal(serverForTool('report.compose'), null);
  });
});
