import { AgentFactory } from '../src/agentFactory.js';
import { AgentPool } from '../src/agentPool.js';
import { runPipeline } from '../src/pipelineRunner.js';

export function harness({ plan } = {}) {
  const pool = new AgentPool();
  const factory = new AgentFactory({ pool });
  return {
    pool,
    factory,
    run: (request) => runPipeline(request, { pool, factory, ...(plan ? { plan } : {}) }),
  };
}
