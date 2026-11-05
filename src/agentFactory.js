import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES } from './capabilityCatalog.js';
import { SpecializedAgent } from './specializedAgent.js';

const defaultSkillsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

function dynamicSkill(definition, capability) {
  return [
    `# ${definition.label}`,
    '',
    `Generated capability \`${capability}\`. This agent is dynamic and cannot read agent_events.`,
    '',
    definition.task,
    '',
    `Skills: ${definition.skills.join(', ')}`,
    `Tools: ${definition.tools.join(', ')}`,
  ].join('\n');
}

/**
 * Agent Factory — creator and configurator.
 * Builds one specialist, loads its skill.md, applies runtime policy, and registers it.
 * It does not decide execution order. That belongs to the Pipeline Runner.
 */
export class AgentFactory {
  constructor({ pool, skillsDir = defaultSkillsDir } = {}) {
    if (!pool) {
      throw new Error('AgentFactory requires an Agent Pool.');
    }
    this.pool = pool;
    this.skillsDir = skillsDir;
  }

  createAgent(spec = {}) {
    const capability = typeof spec.capability === 'string' ? spec.capability.trim() : '';
    if (!capability) {
      throw new Error('createAgent requires a capability.');
    }
    const catalog = CAPABILITIES[capability];
    if (!catalog && !spec.label?.trim()) {
      throw new Error(`No skill catalogue entry for capability "${capability}".`);
    }
    const origin = catalog ? 'predefined' : 'dynamic';
    const definition = catalog ?? {
      label: spec.label.trim(),
      skills: spec.skills?.length ? [...spec.skills] : [capability],
      tools: spec.tools?.length ? [...spec.tools] : ['assistant.respond'],
      mcpServers: [...(spec.mcpServers ?? spec.policy?.mcpServers ?? [])],
      policy: {
        timeoutMs: 8000,
        maxToolCalls: 4,
        dataScope: 'dynamic',
        ...(spec.policy || {}),
      },
      task: spec.task?.trim() || `Handle the request as ${spec.label.trim()}.`,
      skillFile: null,
    };

    const id = this.#nextId();
    const serial = this.pool.list({ capability }).length + 1;
    const tools = spec.tools?.length ? [...spec.tools] : [...definition.tools];
    const skills = spec.skills?.length ? [...spec.skills] : [...definition.skills];
    const skillDoc = catalog
      ? readFileSync(join(this.skillsDir, definition.skillFile), 'utf8')
      : dynamicSkill(definition, capability);
    const mcpServers = [...(spec.policy?.mcpServers ?? definition.mcpServers ?? [])];
    const policy = {
      ...definition.policy,
      ...(spec.policy || {}),
      allowedTools: [...tools],
      mcpServers,
      identity: `agent:${id}`,
    };
    const storedSpec = {
      capability,
      label: definition.label,
      skills: [...skills],
      tools: [...tools],
      mcpServers: [...mcpServers],
      policy: {
        timeoutMs: policy.timeoutMs,
        maxToolCalls: policy.maxToolCalls,
        dataScope: policy.dataScope,
      },
      task: definition.task,
      skillFile: definition.skillFile,
      origin,
    };

    const agent = new SpecializedAgent({
      id,
      name: `${definition.label} ${serial}`,
      capability,
      skills,
      tools,
      policy,
      skillDoc,
      status: 'healthy',
      metadata: {
        ...(spec.metadata || {}),
        createdAt: new Date().toISOString(),
        createdBy: 'agent-factory',
        capability,
        skillFile: definition.skillFile,
        origin,
        spec: storedSpec,
        runs: 0,
      },
    });

    this.pool.register(agent);
    return agent;
  }

  #nextId() {
    let id = `agt_${randomUUID().slice(0, 8)}`;
    while (this.pool.get(id)) {
      id = `agt_${randomUUID().slice(0, 8)}`;
    }
    return id;
  }
}
