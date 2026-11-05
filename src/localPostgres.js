import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { createPool, databaseConfig } from './db.js';
import { applyMigrations } from './migrate.js';

const { Client } = pg;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.pgdata');

export const LOCAL_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/agent_factory';

const MANAGED_URLS = new Set([
  LOCAL_DATABASE_URL,
  'postgres://postgres:postgres@localhost:5432/agent_factory',
]);

function shouldManage(env) {
  if (!databaseConfig(env)) return true;
  return MANAGED_URLS.has(env.DATABASE_URL?.trim());
}

async function canConnect(connectionString) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 1000,
  });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function createDatabase(name) {
  const client = new Client({
    host: '127.0.0.1',
    port: 5432,
    user: 'postgres',
    password: 'postgres',
    database: 'postgres',
    connectionTimeoutMillis: 2000,
  });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (existing.rowCount === 0) {
      await client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`);
    }
  } finally {
    await client.end();
  }
}

async function migrate(env, logger) {
  const pool = createPool(env);
  if (!pool) return;
  try {
    await applyMigrations(pool, { logger });
  } finally {
    await pool.end();
  }
}

/**
 * Start the demo database when nothing else is configured, then apply migrations.
 * A DATABASE_URL that is not the local demo URL is left alone.
 * Returns a stop function when this process owns the cluster.
 */
export async function ensureLocalPostgres(env = process.env, logger = console) {
  if (!shouldManage(env)) return null;

  if (await canConnect(LOCAL_DATABASE_URL)) {
    env.DATABASE_URL = LOCAL_DATABASE_URL;
    await migrate(env, logger);
    return null;
  }

  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: 5432,
    persistent: true,
    autoRehydrateSymlinks: true,
    onLog() {},
    onError(message) {
      const text = message instanceof Error ? message.message : String(message ?? '');
      if (text.trim()) logger.warn?.(`[agent_events] ${text.trim()}`);
    },
  });

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    await cluster.initialise();
  }
  await cluster.start();
  await createDatabase('agent_factory');
  env.DATABASE_URL = LOCAL_DATABASE_URL;
  await migrate(env, logger);
  return () => cluster.stop();
}
