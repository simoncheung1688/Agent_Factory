/**
 * Specialized agent. One class, many instances.
 * The factory supplies capability, skills, tools, and the MCP servers this
 * instance is authorized to call. execute picks a handler from the capability.
 */

import { authorizeMcpCall, dispatchTool } from './mcpGateway.js';
import { guardAuditRead, HARNESS_ID } from './piHarness.js';

export function extractSiteId(request) {
  const match = String(request).match(/\b([A-Z]{2,6}-\d{1,4})\b/);
  return match ? match[1] : 'SITE-UNKNOWN';
}

function runRanAnalysis(agent, input, callTool) {
  const siteId = extractSiteId(input.request);
  const kpis = callTool('ran.query_kpis', { siteId });
  const cells = callTool('ran.list_cells', { siteId });
  const finding = `${siteId} drop rate is ${kpis.dropRatePct}% against a ${kpis.baselineDropRatePct}% baseline. RSRP is ${kpis.rsrpDbm} dBm and handover success is ${kpis.handoverSuccessPct}%. Serving cells: ${cells.cells.join(', ')}.`;
  const deliverable = [
    `RAN finding for ${siteId}`,
    'Source: RAN MCP (ran-mcp).',
    finding,
    'Remote checks to run next: alarm history, neighbour relations, and backhaul latency.',
  ].join('\n');
  return {
    summary: `${siteId} drop rate ${kpis.dropRatePct}% (baseline ${kpis.baselineDropRatePct}%)`,
    siteId,
    kpis,
    cells: cells.cells,
    finding,
    deliverable,
    simulated: true,
  };
}

function runAlarmTriage(agent, input, callTool) {
  const siteId = extractSiteId(input.request);
  const alarmView = callTool('ran.list_alarms', { siteId });
  const kpis = callTool('ran.query_kpis', { siteId });
  const lines = alarmView.alarms.map((alarm) => `${alarm.id} ${alarm.severity} — ${alarm.text}`);
  const deliverable = [
    `Alarm triage for ${siteId}`,
    'Source: RAN MCP (ran-mcp).',
    ...lines,
    `KPI cross-check: drop rate ${kpis.dropRatePct}% against baseline ${kpis.baselineDropRatePct}%.`,
  ].join('\n');
  return {
    summary: `${siteId} ${alarmView.alarms[0].id} ${alarmView.alarms[0].severity}`,
    siteId,
    alarms: alarmView.alarms,
    deliverable,
    simulated: true,
  };
}

function runTopology(agent, input, callTool) {
  const siteId = extractSiteId(input.request);
  const neighbors = callTool('topology.list_neighbors', { siteId });
  const path = callTool('topology.trace_path', { siteId });
  const lines = [
    `Topology for ${siteId}`,
    'Source: Topology MCP (topology-mcp).',
    `Neighbours: ${neighbors.neighbors.join(', ')}.`,
    `Backhaul path: ${path.hops.join(' → ')}.`,
  ];
  const priorAlarm = input.context?.['alarm-triage']?.summary;
  if (priorAlarm) lines.push(`Prior alarm triage: ${priorAlarm}.`);
  return {
    summary: `${siteId} neighbours ${neighbors.neighbors.join(', ')}`,
    siteId,
    neighbors: neighbors.neighbors,
    hops: path.hops,
    deliverable: lines.join('\n'),
    simulated: true,
  };
}

function runKnowledge(agent, input, callTool) {
  const query = [input.request, input.context?.['ran-analysis']?.finding].filter(Boolean).join('\n');
  const match = callTool('knowledge.search', { query });
  const sop = callTool('knowledge.read_sop', { id: match.id });
  const deliverable = [
    `${sop.id} — ${sop.title}`,
    'Source: Knowledge MCP (knowledge-mcp).',
    ...sop.steps.map((step, index) => `${index + 1}. ${step}`),
  ].join('\n');
  return {
    summary: `${sop.id} ${sop.title}`,
    sopId: sop.id,
    title: sop.title,
    steps: sop.steps,
    deliverable,
    simulated: true,
  };
}

function runAccessReview(agent, input, callTool) {
  const account = callTool('identity.lookup_user', { query: input.request });
  const roles = callTool('identity.list_roles', { userId: account.id });
  const deliverable = [
    'Access review',
    'Source: Identity MCP (identity-mcp).',
    `${account.displayName} (${account.account}).`,
    `Roles: ${roles.roles.join(', ')}.`,
  ].join('\n');
  return {
    summary: `${account.account} roles ${roles.roles.join(', ')}`,
    account: account.account,
    roles: roles.roles,
    deliverable,
    simulated: true,
  };
}

function runVendor(agent, input, callTool) {
  const siteId = extractSiteId(input.request);
  const found = callTool('vendor.search_notices', { query: input.request });
  const notice = found.notices[0];
  const ticket = callTool('vendor.draft_ticket', { siteId, noticeId: notice.id });
  const deliverable = [
    'Vendor liaison',
    'Source: Vendor MCP (vendor-mcp).',
    `${notice.id} — ${notice.title}.`,
    `Draft ticket ${ticket.ticketId} for ${siteId} is ${ticket.status}.`,
  ].join('\n');
  return {
    summary: `${ticket.ticketId} cites ${notice.id}`,
    notice,
    ticket,
    deliverable,
    simulated: true,
  };
}

function runChangePlan(agent, input, callTool) {
  const siteId = extractSiteId(input.request);
  const match = callTool('knowledge.search', { query: input.request });
  const sop = callTool('knowledge.read_sop', { id: match.id });
  const neighbors = callTool('topology.list_neighbors', { siteId });
  const path = callTool('topology.trace_path', { siteId });
  const deliverable = [
    `Change plan for ${siteId}`,
    'Sources: Knowledge MCP (knowledge-mcp) and Topology MCP (topology-mcp).',
    `${sop.id} — ${sop.title}.`,
    ...sop.steps.map((step, index) => `${index + 1}. ${step}`),
    `Neighbours in the window: ${neighbors.neighbors.join(', ')}.`,
    `Backhaul path: ${path.hops.join(' → ')}.`,
    'Rollback owner: noc.duty.',
  ].join('\n');
  return {
    summary: `${sop.id} window for ${siteId}`,
    siteId,
    sopId: sop.id,
    neighbors: neighbors.neighbors,
    hops: path.hops,
    deliverable,
    simulated: true,
  };
}

function runResearch(agent, input, callTool) {
  const topic = input.request.trim();
  const scan = callTool('research.scan', { topic });
  const findings = [
    { point: 'Scope', detail: topic },
    { point: 'Catalogue', detail: `Sources in scope: ${scan.sources.join(', ')}.` },
    {
      point: 'Limit',
      detail: 'This demo returns a structured research payload from the agent skill. It does not call a live data source.',
    },
  ];
  const deliverable = [
    'Research notes',
    'Source: Knowledge MCP (knowledge-mcp).',
    ...findings.map((item) => `${item.point}: ${item.detail}`),
  ].join('\n');
  return {
    summary: 'Research notes captured for the request',
    topic,
    sources: scan.sources,
    findings,
    deliverable,
    simulated: true,
  };
}

function runSummary(agent, input, callTool) {
  const prior = input.priorOutputs ?? [];
  callTool('brief.compose', { parts: prior.length });
  const bullets = prior.length > 0 ? prior.map((item) => item.summary) : [input.request.trim()];
  const deliverable = ['Brief', ...bullets.map((bullet) => `• ${bullet}`)].join('\n');
  return {
    summary: bullets[0],
    bullets,
    deliverable,
    simulated: true,
  };
}

function runReport(agent, input, callTool) {
  callTool('report.compose', { session: input.session?.id });
  const sections = [
    ['Radio', input.context?.['ran-analysis']?.deliverable],
    ['Alarms', input.context?.['alarm-triage']?.deliverable],
    ['Topology', input.context?.['topology-mapping']?.deliverable],
    ['Research', input.context?.research?.deliverable],
    ['Procedure', input.context?.['knowledge-retrieval']?.deliverable],
    ['Access', input.context?.['access-review']?.deliverable],
    ['Vendor', input.context?.['vendor-liaison']?.deliverable],
    ['Change', input.context?.['change-planner']?.deliverable],
    ['Brief', input.context?.['incident-summary']?.deliverable],
  ].filter(([, body]) => body);

  const lines = ['Incident report', '', `Request: ${input.request}`, ''];
  if (sections.length === 0) {
    lines.push('The report was drafted from the request alone. No earlier specialist output was attached.', '');
  } else {
    for (const [heading, body] of sections) {
      lines.push(heading, body, '');
    }
  }
  lines.push(`Prepared by ${agent.name}.`);
  return {
    summary: `Drafted report (${agent.name})`,
    deliverable: lines.join('\n'),
    citedAgents: (input.priorOutputs ?? []).map((item) => item.agentId),
    simulated: true,
  };
}

function toolArgs(name, input) {
  const request = input.request ?? '';
  const siteId = extractSiteId(request);
  if (name.startsWith('ran.') || name.startsWith('topology.')) return { siteId };
  if (name === 'knowledge.search' || name === 'vendor.search_notices' || name === 'identity.lookup_user') {
    return { query: request };
  }
  if (name === 'knowledge.read_sop') return { id: 'SOP-GEN-001' };
  if (name === 'research.scan') return { topic: request };
  if (name === 'brief.compose') return { parts: input.priorOutputs?.length ?? 0 };
  if (name === 'report.compose') return { session: input.session?.id };
  if (name === 'vendor.draft_ticket') return { siteId };
  return {};
}

function runDynamic(agent, input, callTool) {
  const results = [];
  for (const name of agent.tools) {
    try {
      results.push({ tool: name, result: callTool(name, toolArgs(name, input)) });
    } catch (error) {
      results.push({ tool: name, error: error.message });
    }
  }
  const lines = [
    agent.name,
    agent.metadata?.spec?.task ?? '',
    input.request.trim(),
    ...results.map((item) => (
      item.error ? `${item.tool}: ${item.error}` : `${item.tool}: ${JSON.stringify(item.result)}`
    )),
  ];
  return {
    summary: `${agent.name} handled the request`,
    deliverable: lines.filter(Boolean).join('\n'),
    dynamic: true,
    simulated: true,
  };
}

function runGeneral(agent, input, callTool) {
  callTool('assistant.respond', {});
  const deliverable = [
    'General assistant',
    'No specialist capability was detected, so the Pipeline Runner used the general assistant.',
    input.request.trim(),
    'Mention RAN, an alarm, topology, an SOP, Keycloak, a vendor, a maintenance window, research, a summary, or a report to see specialists created and reused.',
  ].join('\n');
  return {
    summary: 'Handled by the general assistant',
    deliverable,
    simulated: true,
  };
}

const HANDLERS = {
  'ran-analysis': runRanAnalysis,
  'alarm-triage': runAlarmTriage,
  'topology-mapping': runTopology,
  'knowledge-retrieval': runKnowledge,
  'access-review': runAccessReview,
  'vendor-liaison': runVendor,
  'change-planner': runChangePlan,
  research: runResearch,
  'incident-summary': runSummary,
  'report-writing': runReport,
  'general-assistant': runGeneral,
};

export class SpecializedAgent {
  constructor({ id, name, capability, skills, tools, policy, skillDoc, status = 'healthy', metadata = {} }) {
    this.id = id;
    this.name = name;
    this.capability = capability;
    this.skills = skills;
    this.tools = tools;
    this.policy = policy;
    this.skillDoc = skillDoc;
    this.status = status;
    this.metadata = metadata;
    this._toolCalls = 0;
  }

  skillTitle() {
    const heading = this.skillDoc.split('\n').find((line) => line.startsWith('# '));
    return heading ? heading.slice(2).trim() : this.name;
  }

  callTool(name, args) {
    return this._invoke(name, args).result;
  }

  _invoke(name, args) {
    const allowed = this.policy?.allowedTools ?? this.tools;
    if (!allowed.includes(name)) {
      const error = new Error(`Runtime policy denied tool "${name}" for ${this.name}.`);
      error.code = 'POLICY_DENIED';
      throw error;
    }
    const mcpServer = authorizeMcpCall(this, name);
    if (this._toolCalls >= this.policy.maxToolCalls) {
      const error = new Error(`Runtime policy tool-call limit (${this.policy.maxToolCalls}) reached for ${this.name}.`);
      error.code = 'POLICY_LIMIT';
      throw error;
    }
    this._toolCalls += 1;
    return { mcpServer, result: dispatchTool(name, args) };
  }

  async execute(input) {
    const handler = HANDLERS[this.capability] ?? runDynamic;
    const audit = await guardAuditRead(this, {
      runId: input.runId ?? null,
      readEvents: input.auditReader ?? null,
    });
    this._toolCalls = 0;
    const calls = [];
    const toolTrace = [];
    const callTool = (name, args) => {
      const { mcpServer, result } = this._invoke(name, args);
      calls.push({ tool: name, mcpServer: mcpServer?.id ?? null });
      toolTrace.push({
        name,
        args,
        result,
        mcpServer: mcpServer?.id ?? null,
      });
      return result;
    };
    const data = handler(this, input, callTool);
    toolTrace.push(audit.trace);
    return {
      agentId: this.id,
      agentName: this.name,
      capability: this.capability,
      summary: data.summary,
      data: { ...data, toolCalls: calls, auditAccess: audit.access, harness: HARNESS_ID },
      toolTrace,
      auditAccess: audit.access,
      harness: audit.pi,
    };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      capability: this.capability,
      skills: [...this.skills],
      tools: [...this.tools],
      policy: {
        ...this.policy,
        allowedTools: [...this.policy.allowedTools],
        mcpServers: [...(this.policy.mcpServers ?? [])],
      },
      status: this.status,
      metadata: { ...this.metadata },
      skillTitle: this.skillTitle(),
      skillDoc: this.skillDoc,
    };
  }
}
