import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const MIGRATIONS_TABLE = 'schema_migrations';

const MIGRATION_NAME = /^\d{4,}_[A-Za-z0-9_.-]+\.sql$/;
const FOREIGN_KEYS_PRAGMA =
  /^[ \t]*PRAGMA[ \t]+foreign_keys[ \t]*=[ \t]*(ON|OFF|1|0|TRUE|FALSE)[ \t]*;?[ \t]*$/gim;

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationReport {
  applied: string[];
  skipped: string[];
}

export function readMigrations(directory: string): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of names) {
    if (!MIGRATION_NAME.test(name)) throw new Error(`Unexpected migration file name: ${name}`);
  }
  if (names.length === 0) throw new Error(`No migrations found in ${directory}`);
  return names.map((name) => {
    const sql = readFileSync(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

/**
 * `PRAGMA foreign_keys` is a no-op inside a transaction, so a migration's own pragma lines are
 * lifted out and applied around the transaction instead. Returns the first requested state, if
 * any (a trailing `PRAGMA foreign_keys = ON` merely restores it, which the runner does itself).
 */
export function splitForeignKeyPragma(sql: string): { sql: string; foreignKeys: boolean | null } {
  let foreignKeys: boolean | null = null;
  const stripped = sql.replace(FOREIGN_KEYS_PRAGMA, (_line, value: string) => {
    // The first pragma is the state the migration body runs under; later ones only restore it.
    foreignKeys ??= ['on', '1', 'true'].includes(value.toLowerCase());
    return '';
  });
  return { sql: stripped, foreignKeys };
}

function foreignKeysEnabled(db: DatabaseSync) {
  return (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys === 1;
}

/**
 * A Cloudflare D1 export/import carries its own `d1_migrations` history. Replaying our files over
 * it would re-run applied migrations, so importing one is unsupported: refuse instead.
 */
function assertNotD1Database(db: DatabaseSync) {
  const marker = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'")
    .get();
  if (marker) {
    throw new Error(
      'Database contains a d1_migrations table (a Cloudflare D1 export). Importing a D1 database is not supported; start from an empty SQLite file.',
    );
  }
}

function ensureTable(db: DatabaseSync) {
  assertNotD1Database(db);
  db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
}

function appliedChecksums(db: DatabaseSync) {
  const rows = db.prepare(`SELECT name, checksum FROM ${MIGRATIONS_TABLE}`).all() as {
    name: string;
    checksum: string;
  }[];
  return new Map(rows.map((row) => [row.name, row.checksum]));
}

/** Names of migration files that have not been applied. Throws on checksum drift. */
export function pendingMigrations(db: DatabaseSync, migrations: readonly MigrationFile[]) {
  ensureTable(db);
  const applied = appliedChecksums(db);
  assertNoDrift(applied, migrations);
  return migrations.filter((migration) => !applied.has(migration.name)).map((m) => m.name);
}

function assertNoDrift(applied: Map<string, string>, migrations: readonly MigrationFile[]) {
  const known = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
  for (const [name, checksum] of applied) {
    const expected = known.get(name);
    if (expected === undefined) {
      throw new Error(`Database has applied migration ${name} which is missing from the image`);
    }
    if (expected !== checksum) {
      throw new Error(`Migration ${name} changed after it was applied (checksum mismatch)`);
    }
  }
}

/**
 * Apply pending migrations in order, one transaction each. Safe to re-run and safe against a
 * concurrent runner (each migration re-checks the tracking table after taking the write lock).
 */
export function runMigrations(
  db: DatabaseSync,
  migrations: readonly MigrationFile[],
): MigrationReport {
  ensureTable(db);
  assertNoDrift(appliedChecksums(db), migrations);
  const report: MigrationReport = { applied: [], skipped: [] };
  const restoreForeignKeys = foreignKeysEnabled(db);
  try {
    for (const migration of migrations) {
      const { sql, foreignKeys } = splitForeignKeyPragma(migration.sql);
      if (foreignKeys !== null) db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
      db.exec('BEGIN IMMEDIATE');
      try {
        const existing = db
          .prepare(`SELECT checksum FROM ${MIGRATIONS_TABLE} WHERE name = ?`)
          .get(migration.name) as { checksum: string } | undefined;
        if (existing) {
          db.exec('COMMIT');
          report.skipped.push(migration.name);
          continue;
        }
        db.exec(sql);
        db.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name, checksum) VALUES (?, ?)`).run(
          migration.name,
          migration.checksum,
        );
        // Checked even when the migration disabled enforcement for a table rebuild.
        if (db.prepare('PRAGMA foreign_key_check').all().length > 0) {
          throw new Error(`foreign key violations after ${migration.name}`);
        }
        db.exec('COMMIT');
        report.applied.push(migration.name);
        db.exec(`PRAGMA foreign_keys = ${restoreForeignKeys ? 'ON' : 'OFF'}`);
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        db.exec(`PRAGMA foreign_keys = ${restoreForeignKeys ? 'ON' : 'OFF'}`);
        throw new Error(
          `Migration ${migration.name} failed and was rolled back: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${restoreForeignKeys ? 'ON' : 'OFF'}`);
  }
  return report;
}
