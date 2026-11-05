/**
 * Agent Pool — in-memory registry of specialists created by the Agent Factory.
 * The Pipeline Runner looks here before it asks the factory for a new agent.
 */
export class AgentPool {
  constructor() {
    this.agents = new Map();
  }

  register(agent) {
    if (!agent?.id) {
      throw new Error('Agent id is required.');
    }
    if (this.agents.has(agent.id)) {
      throw new Error(`Agent already registered: ${agent.id}`);
    }
    this.agents.set(agent.id, agent);
    return agent;
  }

  get(id) {
    return this.agents.get(id) ?? null;
  }

  /**
   * Find one agent. Status defaults to healthy so unavailable agents are skipped.
   * Query by capability, skills, status, and exact metadata matches.
   */
  findMatching({ capability, skills, status = 'healthy', metadata } = {}) {
    for (const agent of this.agents.values()) {
      if (status && agent.status !== status) continue;
      if (capability && agent.capability !== capability) continue;
      if (skills?.length && !skills.every((skill) => agent.skills.includes(skill))) continue;
      if (metadata) {
        const agentMeta = agent.metadata ?? {};
        const matches = Object.entries(metadata).every(([key, value]) => agentMeta[key] === value);
        if (!matches) continue;
      }
      return agent;
    }
    return null;
  }

  list({ capability, status } = {}) {
    return [...this.agents.values()]
      .filter((agent) => {
        if (capability && agent.capability !== capability) return false;
        if (status && agent.status !== status) return false;
        return true;
      })
      .map((agent) => (typeof agent.toJSON === 'function' ? agent.toJSON() : { ...agent }));
  }

  setStatus(id, status) {
    const agent = this.get(id);
    if (!agent) {
      throw new Error(`Unknown agent: ${id}`);
    }
    if (status !== 'healthy' && status !== 'unavailable') {
      throw new Error('Status must be "healthy" or "unavailable".');
    }
    agent.status = status;
    return agent;
  }

  clear() {
    const removed = this.agents.size;
    this.agents.clear();
    return removed;
  }
}
