import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../src/db.js';
import { loadEnv } from '../src/loadEnv.js';
import { applyMigrations } from '../src/migrate.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

loadEnv(join(root, '.env'));

const pool = createPool();
if (!pool) {
  console.error('Set DATABASE_URL or PGHOST / PGDATABASE before running migrations.');
  process.exit(1);
}

try {
  await applyMigrations(pool);
} finally {
  await pool.end();
}
