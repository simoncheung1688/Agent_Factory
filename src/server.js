import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentFactory } from './agentFactory.js';
import { AgentPool } from './agentPool.js';
import { createEventLogger } from './db.js';
import { EventLog } from './eventLog.js';
import { loadEnv } from './loadEnv.js';
import { listMcpServers } from './mcpGateway.js';
import { createLlmPlanner } from './llmPlanner.js';
import { runPipeline } from './pipelineRunner.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const staticFiles = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/styles.css': 'styles.css',
  '/app.js': 'app.js',
};
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(Object.assign(new Error('Request body is too large.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createApp({
  pool = new AgentPool(),
  events = new EventLog(),
  eventLogger = null,
  logger = { log() {} },
  plan = null,
} = {}) {
  const factory = new AgentFactory({ pool });
  const audit = events;

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    try {
      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && pathname === '/api/pool') {
        sendJson(res, 200, { agents: pool.list() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/mcp') {
        sendJson(res, 200, { servers: listMcpServers() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        sendJson(res, 200, { events: audit.list() });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/agent-events') {
        const runId = url.searchParams.get('runId');
        if (!runId) {
          sendJson(res, 400, { error: 'runId is required.' });
          return;
        }
        if (!eventLogger?.available?.()) {
          sendJson(res, 503, {
            error: 'PostgreSQL logging is not available.',
            events: [],
          });
          return;
        }
        try {
          const rows = await eventLogger.listByRun(runId);
          sendJson(res, 200, { runId, events: rows });
        } catch (error) {
          sendJson(res, 503, {
            error: 'Could not read agent_events.',
            detail: error.message,
          });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/pool/reset') {
        const removed = pool.clear();
        sendJson(res, 200, { cleared: removed });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/pipeline') {
        const raw = await readBody(req);
        let body;
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { error: 'Request body must be JSON.' });
          return;
        }
        const result = await runPipeline(body.request, {
          pool,
          factory,
          events: audit,
          eventLogger,
          logger,
          ...(plan ? { plan } : {}),
        });
        sendJson(res, 200, result);
        return;
      }

      if (req.method === 'GET' && staticFiles[pathname]) {
        const filename = staticFiles[pathname];
        const filePath = join(publicDir, filename);
        const extension = filename.slice(filename.lastIndexOf('.'));
        const file = readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentTypes[extension] ?? 'text/plain; charset=utf-8',
          'Content-Length': file.length,
          'Cache-Control': 'no-store',
        });
        res.end(file);
        return;
      }

      if (pathname.startsWith('/api/')) {
        sendJson(res, 404, { error: 'Not found.' });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      const status = error.status ?? 500;
      sendJson(res, status, { error: error.message || 'Pipeline failed.' });
    }
  });
}

export function start(port = Number(process.env.PORT) || 3000, {
  logger = console,
  eventLogger = null,
  plan = null,
  pool,
} = {}) {
  const server = createApp({
    logger,
    eventLogger,
    plan,
    ...(pool ? { pool } : {}),
  });
  server.listen(port);
  return server;
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (launchedDirectly) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  loadEnv(join(root, '.env'));
  let stopPostgres = null;
  try {
    const { ensureLocalPostgres } = await import('./localPostgres.js');
    stopPostgres = await ensureLocalPostgres(process.env, console);
  } catch (error) {
    console.warn(
      `[agent_events] Could not start local PostgreSQL (${error?.message || 'unknown error'}). Pipeline events stay in the process log.`,
    );
  }
  const eventLogger = createEventLogger(process.env, console);
  const pool = new AgentPool();
  const server = start(undefined, {
    logger: console,
    eventLogger,
    pool,
    plan: createLlmPlanner({
      dynamicAgents: () => pool.list({ status: 'healthy' })
        .filter((agent) => agent.metadata?.origin === 'dynamic'),
    }),
  });
  server.on('listening', () => {
    const { port } = server.address();
    console.log(`Agent Factory demo ready at http://localhost:${port}`);
    eventLogger.probe();
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    server.close();
    await eventLogger.close();
    if (stopPostgres) await stopPostgres();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
