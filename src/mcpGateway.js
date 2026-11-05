/**
 * In-process MCP gateway.
 * Five servers publish tools. A specialized agent may call a tool only when
 * its runtime policy lists that server.
 */

const SOPS = [
  {
    id: 'SOP-RAN-014',
    title: 'Handover failure response',
    keywords: ['handover'],
    steps: [
      'Confirm the alarm and the neighbour relations involved.',
      'Compare handover success with the 24-hour baseline.',
      'Escalate to RAN operations if success stays under 95% for 15 minutes.',
    ],
  },
  {
    id: 'SOP-RAN-003',
    title: 'Elevated drop-rate investigation',
    keywords: ['drop', 'outage', 'rsrp'],
    steps: [
      'Open the cell KPI view for the last six hours.',
      'Check alarms, backhaul latency, and dominant RSRP.',
      'Dispatch a field check if the drop rate stays above 2% after a remote reset.',
    ],
  },
  {
    id: 'SOP-CHG-006',
    title: 'Maintenance window for a radio site',
    keywords: ['maintenance', 'change', 'window'],
    steps: [
      'Confirm the site, the neighbour list, and the backhaul path.',
      'Book a low-traffic window and name the rollback owner.',
      'Cite this SOP id on the change request before work starts.',
    ],
  },
  {
    id: 'SOP-IT-008',
    title: 'Knowledge catalogue lookup',
    keywords: ['catalog', 'catalogue', 'knowledge', 'memo', 'policy'],
    steps: [
      'Search the catalogue by system and symptom.',
      'Open the current approved document, not a draft.',
      'Cite the document id in the ticket.',
    ],
  },
];

const GENERIC_SOP = {
  id: 'SOP-GEN-001',
  title: 'General request handling',
  keywords: [],
  steps: [
    'Restate the request and the system it refers to.',
    'Attach any specialist output already collected.',
    'Return the draft to the caller with the document ids you used.',
  ],
};

const DIRECTORY = [
  {
    id: 'usr-ran-ops',
    account: 'ran.ops',
    displayName: 'RAN operations role account',
    roles: ['ran-operations', 'ran-read'],
    keywords: ['ran', 'radio', 'keycloak', 'kpi'],
  },
  {
    id: 'usr-noc-duty',
    account: 'noc.duty',
    displayName: 'NOC duty role account',
    roles: ['incident-read', 'change-approve'],
    keywords: ['noc', 'change', 'maintenance'],
  },
  {
    id: 'usr-vendor',
    account: 'vendor.liaison',
    displayName: 'Vendor liaison role account',
    roles: ['vendor-ticket'],
    keywords: ['vendor', 'rma', 'firmware'],
  },
];

const FIELD_NOTICES = [
  {
    id: 'FN-4481',
    title: 'Radio unit restart loop after firmware 12.4',
    keywords: ['radio', 'firmware', 'drop', 'alarm'],
  },
  {
    id: 'FN-4502',
    title: 'Handover timer mismatch on the neighbour relation',
    keywords: ['handover', 'neighbour', 'neighbor'],
  },
  {
    id: 'FN-4518',
    title: 'Backhaul latency after a maintenance window',
    keywords: ['backhaul', 'maintenance', 'window'],
  },
];

function hashString(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function kpisFor(siteId) {
  const hash = hashString(siteId);
  return {
    rsrpDbm: -100 - (hash % 12),
    dropRatePct: Number((2 + (hash % 35) / 10).toFixed(1)),
    baselineDropRatePct: Number((0.4 + (hash % 4) / 10).toFixed(1)),
    handoverSuccessPct: 90 + (hash % 8),
  };
}

function searchKnowledge(query) {
  const text = String(query).toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const sop of SOPS) {
    const score = sop.keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      best = sop;
      bestScore = score;
    }
  }
  return best ?? GENERIC_SOP;
}

function readSop(id) {
  const sop = [...SOPS, GENERIC_SOP].find((item) => item.id === id);
  if (!sop) {
    throw new Error(`Unknown SOP: ${id}`);
  }
  return { id: sop.id, title: sop.title, steps: [...sop.steps] };
}

function bestMatch(items, query) {
  const text = String(query).toLowerCase();
  let best = items[0];
  let bestScore = 0;
  for (const item of items) {
    const score = item.keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

export const MCP_SERVERS = [
  {
    id: 'ran-mcp',
    name: 'RAN MCP',
    description: 'Radio KPIs, serving cells, and active alarms.',
    tools: ['ran.query_kpis', 'ran.list_cells', 'ran.list_alarms'],
  },
  {
    id: 'knowledge-mcp',
    name: 'Knowledge MCP',
    description: 'Approved SOPs, the internal catalogue, and research scans.',
    tools: ['knowledge.search', 'knowledge.read_sop', 'research.scan'],
  },
  {
    id: 'topology-mcp',
    name: 'Topology MCP',
    description: 'Neighbour relations and the backhaul path for a site.',
    tools: ['topology.list_neighbors', 'topology.trace_path'],
  },
  {
    id: 'identity-mcp',
    name: 'Identity MCP',
    description: 'Role accounts and the roles granted in the directory.',
    tools: ['identity.lookup_user', 'identity.list_roles'],
  },
  {
    id: 'vendor-mcp',
    name: 'Vendor MCP',
    description: 'Field notices and draft vendor tickets.',
    tools: ['vendor.search_notices', 'vendor.draft_ticket'],
  },
];

const serversByTool = new Map();
for (const server of MCP_SERVERS) {
  for (const tool of server.tools) {
    serversByTool.set(tool, server);
  }
}

export function listMcpServers() {
  return MCP_SERVERS.map((server) => ({
    id: server.id,
    name: server.name,
    description: server.description,
    tools: [...server.tools],
  }));
}

export function serverForTool(toolName) {
  return serversByTool.get(toolName) ?? null;
}

/** Returns the MCP server for this tool, or null when the tool is local. */
export function authorizeMcpCall(agent, toolName) {
  const server = serverForTool(toolName);
  if (!server) return null;
  const granted = agent.policy?.mcpServers ?? [];
  if (!granted.includes(server.id)) {
    const allowed = granted.length ? granted.join(', ') : 'none';
    const error = new Error(
      `MCP gateway denied ${toolName} on ${server.id} for ${agent.name}. Authorized servers: ${allowed}.`,
    );
    error.code = 'MCP_DENIED';
    throw error;
  }
  return server;
}

export function dispatchTool(name, args = {}) {
  switch (name) {
    case 'ran.query_kpis': {
      const siteId = args.siteId || 'SITE-UNKNOWN';
      return { siteId, ...kpisFor(siteId) };
    }
    case 'ran.list_cells': {
      const siteId = args.siteId || 'SITE-UNKNOWN';
      return { siteId, cells: [`${siteId}-A`, `${siteId}-B`] };
    }
    case 'ran.list_alarms': {
      const siteId = args.siteId || 'SITE-UNKNOWN';
      const kpis = kpisFor(siteId);
      return {
        siteId,
        alarms: [
          {
            id: 'ALM-1044',
            severity: 'critical',
            text: `${siteId} drop rate ${kpis.dropRatePct}% is above the ${kpis.baselineDropRatePct}% baseline`,
          },
          {
            id: 'ALM-2210',
            severity: 'major',
            text: `${siteId} handover success ${kpis.handoverSuccessPct}% is under the 95% floor`,
          },
        ],
      };
    }
    case 'knowledge.search':
      return { id: searchKnowledge(args.query || '').id };
    case 'knowledge.read_sop':
      return readSop(args.id);
    case 'research.scan':
      return {
        topic: args.topic ?? '',
        sources: ['access-catalogue', 'operations-index', 'sop-index'],
      };
    case 'topology.list_neighbors': {
      const siteId = args.siteId || 'SITE-UNKNOWN';
      const hash = hashString(`${siteId}:neighbors`);
      const suffix = (hash % 80) + 10;
      return { siteId, neighbors: [`N-${suffix}`, `N-${suffix + 3}`, `N-${suffix + 11}`] };
    }
    case 'topology.trace_path': {
      const siteId = args.siteId || 'SITE-UNKNOWN';
      return { siteId, hops: [siteId, 'AGG-01', 'CORE-R1'] };
    }
    case 'identity.lookup_user': {
      const account = bestMatch(DIRECTORY, args.query || '');
      return {
        id: account.id,
        account: account.account,
        displayName: account.displayName,
      };
    }
    case 'identity.list_roles': {
      const account = DIRECTORY.find((item) => item.id === args.userId) ?? DIRECTORY[1];
      return { userId: account.id, account: account.account, roles: [...account.roles] };
    }
    case 'vendor.search_notices': {
      const notice = bestMatch(FIELD_NOTICES, args.query || '');
      return { notices: [{ id: notice.id, title: notice.title }] };
    }
    case 'vendor.draft_ticket': {
      const siteId = args.siteId || 'SITE-UNKNOWN';
      return {
        ticketId: 'VND-1008',
        siteId,
        noticeId: args.noticeId ?? null,
        status: 'draft',
      };
    }
    case 'brief.compose':
      return { parts: args.parts ?? 0 };
    case 'report.compose':
      return { session: args.session ?? 'none' };
    case 'assistant.respond':
      return { accepted: true };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
