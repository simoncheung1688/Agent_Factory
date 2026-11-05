/**
 * Adapter around @earendil-works/pi-agent-core.
 * The rest of the demo talks to this module, not to pi types.
 * beforeToolCall is the guardrail: predefined agents may read agent_events,
 * and dynamic agents are blocked before the tool runs.
 */

import { Agent } from '@earendil-works/pi-agent-core';
import { Type, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

export const HARNESS_ID = '@earendil-works/pi-agent-core';
export const AUDIT_TOOL = 'agent_events.read';

const BLOCK_REASON = 'Dynamic agents are not allowed to read agent_events.';

function localModel() {
  const faux = fauxProvider({
    provider: 'agent-factory-pi',
    models: [{ id: 'guardrail' }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall(AUDIT_TOOL, { runId: '' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Audit check complete.'),
  ]);
  return {
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
  };
}

/**
 * Ask the pi Agent loop to read agent_events.
 * The tool body runs only when beforeToolCall allows it.
 */
export async function guardAuditRead(agent, { runId = null, readEvents = null } = {}) {
  const { model, streamFn } = localModel();
  const origin = agent.metadata?.origin === 'dynamic' ? 'dynamic' : 'predefined';
  let rows = null;
  let allowed = origin === 'predefined';
  let reason = allowed ? null : BLOCK_REASON;

  const pi = new Agent({
    initialState: {
      systemPrompt: 'Use agent_events.read when you need audit context for this run.',
      model,
      tools: [
        {
          name: AUDIT_TOOL,
          label: 'Read agent events',
          description: 'Read audit rows for one pipeline run.',
          parameters: Type.Object({
            runId: Type.String({ description: 'Pipeline run id' }),
          }),
          execute: async () => {
            rows = readEvents ? await readEvents(runId) : [];
            return {
              content: [{ type: 'text', text: JSON.stringify(rows) }],
              details: { rows },
            };
          },
        },
      ],
    },
    streamFn,
    beforeToolCall: async ({ toolCall }) => {
      if (toolCall.name !== AUDIT_TOOL) return undefined;
      if (origin === 'dynamic') {
        allowed = false;
        reason = BLOCK_REASON;
        rows = null;
        return { block: true, reason, terminate: true };
      }
      allowed = true;
      reason = null;
      return undefined;
    },
  });

  await pi.prompt(`Read agent_events for run ${runId ?? 'unknown'}.`);

  const toolMessage = pi.state.messages.find((message) => message.role === 'toolResult' && message.toolName === AUDIT_TOOL);
  return {
    harness: HARNESS_ID,
    access: {
      tool: AUDIT_TOOL,
      allowed,
      reason,
      rowCount: Array.isArray(rows) ? rows.length : 0,
    },
    rows,
    trace: {
      name: AUDIT_TOOL,
      args: { runId },
      result: allowed
        ? { allowed: true, rowCount: Array.isArray(rows) ? rows.length : 0 }
        : { allowed: false, reason },
      blocked: !allowed,
      mcpServer: null,
    },
    pi: {
      id: HARNESS_ID,
      messages: pi.state.messages.map((message) => message.role),
      blocked: Boolean(toolMessage?.isError),
    },
  };
}
