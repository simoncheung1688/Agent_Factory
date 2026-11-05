import { randomUUID } from 'node:crypto';
import { EventLog } from './eventLog.js';
import { catalogPlan } from './llmPlanner.js';

/**
 * Pipeline Runner — coordinator and sequence owner.
 *
 * Request → analyse → pool lookup → reuse or factory → execute → hand off → respond.
 * The Agent Factory is called only when the pool has no healthy match.
 * agent_events rows are an audit log. Agents still receive the next payload directly.
 */
export async function runPipeline(userRequest, {
  pool,
  factory,
  events,
  eventLogger,
  logger,
  plan = catalogPlan,
} = {}) {
  if (!pool) {
    throw new Error('Pipeline Runner requires an Agent Pool.');
  }
  if (!factory?.createAgent) {
    throw new Error('Pipeline Runner requires an Agent Factory.');
  }
  if (typeof userRequest !== 'string' || !userRequest.trim()) {
    const error = new Error('Request text is required.');
    error.status = 400;
    throw error;
  }

  const request = userRequest.trim();
  const runLog = new EventLog();
  const sessionId = `ses_${randomUUID().slice(0, 8)}`;
  const runId = randomUUID();
  const startedAt = Date.now();

  const emit = (event) => {
    const entry = runLog.record(event);
    if (events && events !== runLog) {
      events.record(event);
    }
    logger?.log?.(entry.message);
    return entry;
  };

  const persist = async (event) => {
    if (!eventLogger?.write) return null;
    try {
      const row = await eventLogger.write({ runId, ...event });
      return row?.id ?? null;
    } catch (error) {
      logger?.warn?.(`[agent_events] ${error.message}`);
      return null;
    }
  };

  const resolved = await plan(request);
  let currentAgentName = null;

  try {
    emit({
      type: 'request.received',
      message: '1 · Request received',
      request,
    });

    emit({
      type: 'intent.extracted',
      message: `2 · Pipeline Runner determined capabilities, tools, and runtime policy · ${resolved.label}`,
      capabilities: resolved.capabilities,
      label: resolved.label,
    });

    await persist({
      eventType: 'run_start',
      status: 'running',
      input: { request },
      output: {
        sessionId,
        label: resolved.label,
        capabilities: resolved.capabilities,
      },
    });

    let payload = {
      request,
      session: { id: sessionId },
      context: {},
      priorOutputs: [],
    };
    const agents = [];
    const artifacts = [];

    for (let index = 0; index < resolved.steps.length; index += 1) {
      const step = resolved.steps[index];
      const existing = pool.findMatching({
        capability: step.capability,
        skills: step.skills,
        status: 'healthy',
      });

      emit({
        type: 'pool.lookup',
        message: existing
          ? `3 · Pool lookup hit · ${step.capability} · healthy agent available`
          : `3 · Pool lookup miss · ${step.capability} · no healthy agent`,
        capability: step.capability,
        hit: Boolean(existing),
      });

      const selectedId = await persist({
        eventType: 'agent_selected',
        status: 'success',
        agentName: existing?.name ?? null,
        input: { capability: step.capability, skills: step.skills },
        output: {
          decision: existing ? 'reuse' : 'create',
          capability: step.capability,
          agentId: existing?.id ?? null,
        },
      });

      let agent;
      let origin;
      let stepParentId = selectedId;
      if (existing) {
        agent = existing;
        origin = 'reused';
        emit({
          type: 'agent.reused',
          message: `4a · Reused ${agent.name} · session ${sessionId}`,
          agentId: agent.id,
          name: agent.name,
          capability: step.capability,
          sessionId,
        });
      } else {
        agent = factory.createAgent({
          capability: step.capability,
          label: step.label,
          skills: step.skills,
          tools: step.tools,
          task: step.task,
          mcpServers: step.mcpServers,
          policy: step.policy,
        });
        origin = 'created';
        emit({
          type: 'agent.created',
          message: `4b · Agent Factory created ${agent.name} and registered it in the pool`,
          agentId: agent.id,
          name: agent.name,
          capability: step.capability,
        });
        stepParentId = await persist({
          eventType: 'agent_created',
          status: 'success',
          agentName: agent.name,
          parentEventId: selectedId,
          input: { capability: step.capability, skills: step.skills },
          output: {
            agentId: agent.id,
            capability: step.capability,
            mcpServers: agent.policy?.mcpServers ?? [],
            origin: agent.metadata?.origin ?? null,
            spec: agent.metadata?.spec ?? null,
          },
        });
      }

      currentAgentName = agent.name;
      agent.metadata.runs += 1;
      agent.metadata.lastSessionId = sessionId;

      const agentInput = {
        ...payload,
        task: step.task,
        capability: step.capability,
        runId,
        auditReader: eventLogger?.listByRun ? (id) => eventLogger.listByRun(id) : null,
      };
      const execStarted = Date.now();
      const startId = await persist({
        eventType: 'agent_start',
        status: 'running',
        agentName: agent.name,
        parentEventId: stepParentId,
        input: agentInput,
      });

      const output = await agent.execute(agentInput);
      const auditAccess = output.auditAccess;
      if (auditAccess) {
        emit({
          type: auditAccess.allowed ? 'audit.allowed' : 'audit.blocked',
          message: auditAccess.allowed
            ? `5a · ${agent.name} read agent_events (${auditAccess.rowCount} rows)`
            : `5a · ${agent.name} was blocked from reading agent_events`,
          agentId: agent.id,
          allowed: auditAccess.allowed,
        });
      }

      for (const trace of output.toolTrace ?? []) {
        await persist({
          eventType: trace.blocked ? 'audit_denied' : 'tool_call',
          status: trace.blocked ? 'error' : 'success',
          agentName: agent.name,
          parentEventId: startId,
          toolName: trace.name,
          toolArgs: trace.args ?? null,
          toolResult: trace.result ?? null,
          errorMessage: trace.blocked ? trace.result?.reason ?? null : null,
          output: { mcpServer: trace.mcpServer ?? null, allowed: trace.blocked ? false : true },
        });
      }

      const endId = await persist({
        eventType: 'agent_end',
        status: 'success',
        agentName: agent.name,
        parentEventId: startId,
        durationMs: Date.now() - execStarted,
        output: {
          agentId: agent.id,
          capability: step.capability,
          summary: output.summary,
          data: output.data,
        },
      });

      emit({
        type: 'task.completed',
        message: `5 · ${agent.name} completed the task · ${output.summary}`,
        agentId: agent.id,
        name: agent.name,
        capability: step.capability,
        summary: output.summary,
      });

      const artifact = {
        capability: step.capability,
        agentId: agent.id,
        agentName: agent.name,
        summary: output.summary,
        data: output.data,
      };
      artifacts.push(artifact);
      agents.push({
        agentId: agent.id,
        name: agent.name,
        capability: step.capability,
        origin,
        kind: agent.metadata?.origin ?? 'predefined',
        spec: agent.metadata?.origin === 'dynamic' ? agent.metadata.spec : null,
        auditAccess: output.auditAccess ?? null,
        summary: output.summary,
      });

      payload = {
        request,
        session: { id: sessionId },
        context: { ...payload.context, [step.capability]: output.data },
        priorOutputs: [...payload.priorOutputs, artifact],
      };

      if (index < resolved.steps.length - 1) {
        const next = resolved.steps[index + 1];
        emit({
          type: 'handoff',
          message: `6 · Logged the step and passed the payload to ${next.capability}`,
          from: step.capability,
          to: next.capability,
        });
        await persist({
          eventType: 'handoff',
          status: 'success',
          agentName: agent.name,
          parentEventId: endId,
          input: {
            from: step.capability,
            summary: output.summary,
          },
          output: { to: next.capability },
        });
      }
    }

    const summary = {
      created: agents.filter((agent) => agent.origin === 'created').length,
      reused: agents.filter((agent) => agent.origin === 'reused').length,
      steps: agents.length,
    };

    emit({
      type: 'pipeline.completed',
      message: `7 · Final response returned · ${summary.created} created · ${summary.reused} reused`,
      ...summary,
    });

    await persist({
      eventType: 'run_end',
      status: 'success',
      durationMs: Date.now() - startedAt,
      output: { ...summary, sessionId },
    });

    return {
      request,
      runId,
      session: { id: sessionId },
      intent: { label: resolved.label, capabilities: resolved.capabilities },
      result: {
        text: artifacts.at(-1)?.data.deliverable ?? '',
        artifacts,
      },
      agents,
      summary,
      events: runLog.list(),
    };
  } catch (error) {
    await persist({
      eventType: 'error',
      status: 'error',
      agentName: currentAgentName,
      errorMessage: error.message,
    });
    await persist({
      eventType: 'run_end',
      status: 'error',
      agentName: currentAgentName,
      errorMessage: error.message,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
