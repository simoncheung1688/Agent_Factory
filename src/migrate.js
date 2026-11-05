import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultMigrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Apply migrations/*.sql once and record them in schema_migrations.
 * The caller owns the pool.
 */
export async function applyMigrations(pool, {
  migrationsDir = defaultMigrationsDir,
  logger = console,
} = {}) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const files = (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
    if (existing.rowCount > 0) {
      logger.log?.(`skip ${file}`);
      continue;
    }

    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.log?.(`applied ${file}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
