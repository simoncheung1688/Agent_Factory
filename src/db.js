import pg from 'pg';
import { EventLogger } from './eventLogger.js';

const { Pool } = pg;

/**
 * DATABASE_URL wins. Otherwise PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE.
 * Returns null when neither form is set, so the demo can run with no database.
 */
export function databaseConfig(env = process.env) {
  const url = env.DATABASE_URL?.trim();
  if (url) return { connectionString: url };

  const host = env.PGHOST?.trim();
  const database = env.PGDATABASE?.trim();
  if (!host && !database) return null;

  return {
    host: host || 'localhost',
    port: env.PGPORT ? Number(env.PGPORT) : 5432,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: database || 'agent_factory',
  };
}

export function createPool(env = process.env) {
  const config = databaseConfig(env);
  if (!config) return null;
  return new Pool({
    ...config,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10_000,
    query_timeout: 2000,
    application_name: 'agent-factory',
  });
}

export function createEventLogger(env = process.env, logger = console) {
  const pool = createPool(env);
  if (!pool) return new EventLogger({ logger });
  return new EventLogger({
    logger,
    query: (text, params) => pool.query(text, params),
    ping: () => pool.query('SELECT 1'),
    close: () => pool.end(),
  });
}
