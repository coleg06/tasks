import { pathToFileURL } from 'node:url';
import { SqliteDatabase } from '../platform/sqlite/driver';
import { pendingMigrations, readMigrations, runMigrations } from '../platform/sqlite/migrate';
import { parsePlatformConfig } from './platform';

/**
 * Apply SQLite migrations: `node dist/migrate.js [--status]`.
 * Uses the same TASKS_DATASTORE / TASKS_SQLITE_PATH / TASKS_MIGRATIONS_DIR variables as the server.
 * Idempotent; exits non-zero on failure (each migration is rolled back individually).
 */
export function migrateSqlite(source: NodeJS.ProcessEnv, statusOnly = false) {
  const config = parsePlatformConfig(source);
  if (!config) throw new Error('TASKS_DATASTORE=sqlite and TASKS_SQLITE_PATH are required');
  const database = new SqliteDatabase(config.sqlitePath);
  try {
    const migrations = readMigrations(config.migrationsDir);
    if (statusOnly) return { pending: pendingMigrations(database.raw, migrations) };
    return runMigrations(database.raw, migrations);
  } finally {
    database.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    console.log(JSON.stringify(migrateSqlite(process.env, process.argv.includes('--status'))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
