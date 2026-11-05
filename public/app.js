const emptyCopy = 'Run a request to see the final response, and which agents were created or reused.';

const examples = [
  'Investigate the RAN drop at cell site TST-12, check the SOP, and draft an incident report',
  'Triage critical alarms at TST-12 and map neighbour topology',
  'Review who can access radio operations in Keycloak and open a vendor ticket for site TST-12',
  'Plan a maintenance window for site TST-12',
  'Look up the SOP for handover failures and summarize the steps',
  'Research private 5G trends and write a short briefing',
];

const form = document.querySelector('#request-form');
const requestInput = document.querySelector('#request');
const runButton = document.querySelector('#run');
const resetButton = document.querySelector('#reset');
const statusLine = document.querySelector('#status');
const examplesHost = document.querySelector('#examples');
const emptyResult = document.querySelector('#empty-result');
const outcome = document.querySelector('#outcome');
const counts = document.querySelector('#counts');
const intent = document.querySelector('#intent');
const usage = document.querySelector('#usage');
const deliverable = document.querySelector('#deliverable');
const artifacts = document.querySelector('#artifacts');
const events = document.querySelector('#events');
const poolHost = document.querySelector('#pool');
const mcpHost = document.querySelector('#mcp');

examples.forEach((example) => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = example;
  button.addEventListener('click', () => {
    requestInput.value = example;
    requestInput.focus();
  });
  examplesHost.append(button);
});

requestInput.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    form.requestSubmit();
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await runPipeline();
});

resetButton.addEventListener('click', async () => {
  resetButton.disabled = true;
  try {
    const response = await fetch('/api/pool/reset', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not clear the pool.');
    clearResult();
    statusLine.textContent = `Pool cleared (${body.cleared} removed). The next request creates new agents.`;
    await refreshPool();
  } catch (error) {
    statusLine.textContent = error.message;
  } finally {
    resetButton.disabled = false;
  }
});

async function runPipeline() {
  const request = requestInput.value.trim();
  if (!request) return;
  runButton.disabled = true;
  statusLine.textContent = 'Pipeline Runner is working…';
  try {
    const response = await fetch('/api/pipeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Pipeline failed.');
    renderResult(body);
    statusLine.textContent = `${body.summary.created} created · ${body.summary.reused} reused · session ${body.session.id} · run ${body.runId}`;
    await refreshPool();
  } catch (error) {
    statusLine.textContent = error.message;
    showError(error.message);
  } finally {
    runButton.disabled = false;
  }
}

function renderResult(body) {
  emptyResult.hidden = true;
  outcome.hidden = false;
  counts.replaceChildren();
  counts.append(countPill('create', body.summary.created, 'created'));
  counts.append(countPill('reuse', body.summary.reused, 'reused'));
  intent.textContent = `Plan: ${body.intent.label}`;

  usage.replaceChildren();
  body.agents.forEach((agent, index) => {
    const item = document.createElement('li');
    item.className = agent.origin === 'created' ? 'created' : 'reused';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `${index + 1}. ${agent.name}`;
    const originTag = document.createElement('span');
    originTag.className = 'tag';
    originTag.textContent = agent.origin === 'created' ? 'Created' : 'Reused';
    const kindTag = document.createElement('span');
    kindTag.className = `tag ${agent.kind === 'dynamic' ? 'dynamic' : 'predefined'}`;
    kindTag.textContent = agent.kind === 'dynamic' ? 'Dynamic' : 'Predefined';
    const audit = document.createElement('span');
    const allowed = agent.auditAccess?.allowed === true;
    audit.className = `tag ${allowed ? 'allowed' : 'blocked'}`;
    audit.textContent = allowed ? 'agent_events allowed' : 'agent_events blocked';
    const summary = document.createElement('span');
    summary.className = 'summary';
    summary.textContent = agent.summary;
    item.append(who, originTag, kindTag, audit, summary);
    if (agent.kind === 'dynamic' && agent.spec) {
      const spec = document.createElement('pre');
      spec.className = 'spec';
      spec.textContent = JSON.stringify(agent.spec, null, 2);
      item.append(spec);
    }
    usage.append(item);
  });

  deliverable.textContent = body.result.text;
  artifacts.textContent = JSON.stringify(body.result.artifacts, null, 2);
  renderEvents(body.events);
}

function countPill(kind, value, label) {
  const pill = document.createElement('span');
  pill.className = `count ${kind}`;
  const strong = document.createElement('strong');
  strong.textContent = String(value);
  pill.append(strong, document.createTextNode(label));
  return pill;
}

function renderEvents(entries) {
  events.replaceChildren();
  if (!entries?.length) {
    const item = document.createElement('li');
    item.className = 'empty-line';
    item.textContent = 'No run yet.';
    events.append(item);
    return;
  }
  entries.forEach((entry) => {
    const item = document.createElement('li');
    item.className = entry.type.replace('.', '-');
    item.textContent = entry.message;
    events.append(item);
  });
}

function clearResult() {
  emptyResult.hidden = false;
  emptyResult.textContent = emptyCopy;
  outcome.hidden = true;
  renderEvents([]);
}

function showError(message) {
  emptyResult.hidden = false;
  emptyResult.textContent = message;
  outcome.hidden = true;
}

async function refreshPool() {
  let body;
  try {
    const response = await fetch('/api/pool');
    body = await response.json();
  } catch (error) {
    poolHost.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = error.message;
    poolHost.append(empty);
    return;
  }
  poolHost.replaceChildren();
  if (!body.agents?.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Pool is empty. The first matching request creates a specialist.';
    poolHost.append(empty);
    return;
  }
  body.agents.forEach((agent) => poolHost.append(renderAgent(agent)));
}

function renderAgent(agent) {
  const card = document.createElement('article');
  card.className = 'agent';

  const top = document.createElement('div');
  top.className = 'agent-top';
  const title = document.createElement('h3');
  title.textContent = agent.name;
  const status = document.createElement('span');
  status.className = agent.status === 'healthy' ? 'status' : 'status unavailable';
  status.textContent = agent.status;
  top.append(title, status);

  const meta = document.createElement('p');
  meta.className = 'meta';
  const kind = agent.metadata.origin === 'dynamic' ? 'dynamic' : 'predefined';
  const skillName = agent.metadata.skillFile || 'generated skill';
  meta.textContent = `${agent.id} · ${agent.capability} · ${kind} · ${agent.metadata.runs} run${agent.metadata.runs === 1 ? '' : 's'} · ${skillName}`;

  const chips = document.createElement('div');
  chips.className = 'chips';
  agent.skills.forEach((skill) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = skill;
    chips.append(chip);
  });

  const servers = agent.policy.mcpServers?.length ? agent.policy.mcpServers.join(', ') : 'none';
  const tools = document.createElement('p');
  tools.className = 'meta';
  tools.textContent = `MCP: ${servers} · tools ${agent.tools.join(', ')} · scope ${agent.policy.dataScope}`;

  const skill = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = agent.skillTitle;
  const doc = document.createElement('pre');
  doc.textContent = agent.skillDoc;
  skill.append(summary, doc);

  card.append(top, meta, chips, tools, skill);
  return card;
}

async function refreshMcp() {
  try {
    const response = await fetch('/api/mcp');
    const body = await response.json();
    mcpHost.replaceChildren();
    body.servers.forEach((server) => {
      const card = document.createElement('article');
      card.className = 'server';
      const title = document.createElement('h3');
      title.textContent = server.name;
      const meta = document.createElement('p');
      meta.className = 'meta';
      meta.textContent = server.id;
      const description = document.createElement('p');
      description.className = 'meta';
      description.textContent = server.description;
      const tools = document.createElement('p');
      tools.className = 'meta';
      tools.textContent = server.tools.join(', ');
      card.append(title, meta, description, tools);
      mcpHost.append(card);
    });
  } catch (error) {
    mcpHost.replaceChildren();
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = error.message;
    mcpHost.append(empty);
  }
}

refreshPool();
refreshMcp();
