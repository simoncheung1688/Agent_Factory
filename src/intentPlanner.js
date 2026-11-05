import { CAPABILITIES, CAPABILITY_ORDER } from './capabilityCatalog.js';

/**
 * Turn a natural-language request into an ordered list of task specs.
 * This is the Pipeline Runner's planning step. It does not create agents.
 */
export function planRequest(requestText) {
  const text = requestText.toLowerCase();
  const matched = CAPABILITY_ORDER.filter((key) => CAPABILITIES[key].match(text));
  const keys = matched.length > 0 ? matched : ['general-assistant'];

  return {
    label: keys.map((key) => CAPABILITIES[key].label).join(' → '),
    capabilities: keys,
    steps: keys.map((key) => {
      const capability = CAPABILITIES[key];
      return {
        capability: key,
        task: capability.task,
        skills: [...capability.skills],
        tools: [...capability.tools],
        policy: {
          ...capability.policy,
          mcpServers: [...capability.mcpServers],
        },
      };
    }),
  };
}
