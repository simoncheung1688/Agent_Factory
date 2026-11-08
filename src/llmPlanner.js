/**
 * Turns a free-form request into catalog-shaped agent steps.
 * The HTTP server calls an LLM. Tests pass their own complete() or catalogPlan().
 */

import { createModels } from '@earendil-works/pi-ai';
import { completeSimple } from '@earendil-works/pi-ai/compat';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { CAPABILITIES, CAPABILITY_ORDER } from './capabilityCatalog.js';
import { planRequest } from './intentPlanner.js';

export const DEFAULT_MODEL = 'grok-4.7';

function catalogSummary() {
  return CAPABILITY_ORDER.map((key) => {
    const entry = CAPABILITIES[key];
    return `- ${key}: ${entry.label}; tools ${entry.tools.join(', ')}; task ${entry.task}`;
  }).join('\n');
}

function dynamicAgentLabel(agent) {
  if (typeof agent?.label === 'string' && agent.label.trim()) return agent.label.trim();
  const specLabel = agent?.metadata?.spec?.label;
  if (typeof specLabel === 'string' && specLabel.trim()) return specLabel.trim();
  return '';
}

function dynamicAgentBlock(agents = []) {
  const lines = [];
  for (const agent of agents) {
    const capability = typeof agent?.capability === 'string' ? agent.capability.trim() : '';
    if (!capability) continue;
    const skills = Array.isArray(agent.skills) ? agent.skills.map((skill) => String(skill)) : [];
    lines.push(`- ${JSON.stringify({ capability, label: dynamicAgentLabel(agent), skills })}`);
  }
  if (!lines.length) return '';
  return [
    'Existing dynamic agents:',
    ...lines,
    'When the request fits an existing dynamic agent, copy that agent\'s capability, label, and skills exactly.',
    'Do not invent a synonym capability, a new label, or a different skill list for the same specialist.',
  ].join('\n');
}

function plannerPrompt(request, dynamicAgents = []) {
  const existing = dynamicAgentBlock(dynamicAgents);
  return [
    'Return JSON only. No markdown.',
    'Shape: {"steps":[{"capability":"kebab-case","label":"Name","skills":["skill"],"tools":["tool.name"],"mcpServers":[],"policy":{"timeoutMs":8000,"maxToolCalls":4,"dataScope":"dynamic"},"task":"what this agent should do"}]}',
    'Use one or more steps. A step may reuse a known capability key when it fits.',
    'When the request does not fit a known capability or an existing dynamic agent, invent a new capability key, label, skills, tools, and task.',
    'Known capabilities:',
    catalogSummary(),
    ...(existing ? ['', existing] : []),
    '',
    `Request: ${request}`,
  ].join('\n');
}

export function slugify(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'dynamic-agent';
}

function textFrom(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n').trim();
}

export function parsePlannerJson(text) {
  const trimmed = String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new Error('LLM planner did not return JSON.');
  }
  let value;
  try {
    value = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new Error('LLM planner returned invalid JSON.');
  }
  const steps = Array.isArray(value.steps) ? value.steps : [value];
  if (!steps.length || !steps[0]) {
    throw new Error('LLM planner returned no agent steps.');
  }
  return steps.slice(0, 4).map(normalizeStep);
}

export function normalizeStep(raw = {}) {
  const catalogKey = typeof raw.capability === 'string' ? raw.capability.trim() : '';
  const catalog = CAPABILITIES[catalogKey];
  if (catalog) {
    return {
      capability: catalogKey,
      label: catalog.label,
      skills: [...catalog.skills],
      tools: [...catalog.tools],
      mcpServers: [...catalog.mcpServers],
      policy: {
        ...catalog.policy,
        mcpServers: [...catalog.mcpServers],
      },
      task: catalog.task,
      skillFile: catalog.skillFile,
      origin: 'predefined',
    };
  }

  const label = typeof raw.label === 'string' ? raw.label.trim() : '';
  if (!label) {
    throw new Error('LLM planner returned a dynamic agent with no label.');
  }
  const capability = slugify(catalogKey || label);
  const skills = Array.isArray(raw.skills) && raw.skills.length
    ? raw.skills.map((skill) => String(skill))
    : [capability];
  const tools = Array.isArray(raw.tools) && raw.tools.length
    ? raw.tools.map((tool) => String(tool))
    : ['assistant.respond'];
  const mcpServers = Array.isArray(raw.mcpServers) ? raw.mcpServers.map((server) => String(server)) : [];
  const policy = {
    timeoutMs: Number(raw.policy?.timeoutMs) || 8000,
    maxToolCalls: Number(raw.policy?.maxToolCalls) || 4,
    dataScope: raw.policy?.dataScope || 'dynamic',
    mcpServers,
  };
  return {
    capability,
    label,
    skills,
    tools,
    mcpServers,
    policy,
    task: typeof raw.task === 'string' && raw.task.trim() ? raw.task.trim() : `Handle the request as ${label}.`,
    skillFile: null,
    origin: 'dynamic',
  };
}

export function stepsToPlan(steps) {
  return {
    label: steps.map((step) => step.label).join(' → '),
    capabilities: steps.map((step) => step.capability),
    steps,
  };
}

/** Keyword catalogue plan used when a caller does not supply an LLM. The pool is ignored. */
export function catalogPlan(request) {
  const plan = planRequest(request);
  return stepsToPlan(plan.steps.map((step) => normalizeStep({ capability: step.capability })));
}

export async function completeWithPi(systemPrompt, userText, env = process.env) {
  if (!env.XAI_API_KEY?.trim()) {
    const error = new Error('Set XAI_API_KEY in .env so the Pipeline Runner can call grok-4.7.');
    error.status = 503;
    throw error;
  }
  const models = createModels();
  models.setProvider(xaiProvider());
  const modelId = (env.PI_MODEL || DEFAULT_MODEL).trim();
  const model = models.getModel('xai', modelId);
  if (!model) {
    throw new Error(`Unknown xAI model "${modelId}".`);
  }
  const message = await completeSimple(model, {
    systemPrompt,
    messages: [{ role: 'user', content: userText, timestamp: Date.now() }],
  });
  if (message.stopReason === 'error') {
    throw new Error(message.errorMessage || 'LLM request failed.');
  }
  const text = textFrom(message);
  if (!text) {
    throw new Error('LLM planner returned an empty response.');
  }
  return text;
}

export function createLlmPlanner({ complete = completeWithPi, dynamicAgents = () => [] } = {}) {
  return async function plan(request) {
    const listed = typeof dynamicAgents === 'function' ? dynamicAgents() : dynamicAgents;
    const text = await complete(
      'You plan specialist agents. Return JSON only.',
      plannerPrompt(request, Array.isArray(listed) ? listed : []),
    );
    return stepsToPlan(parsePlannerJson(text));
  };
}
