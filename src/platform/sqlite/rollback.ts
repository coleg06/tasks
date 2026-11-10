import { closeSync, openSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { type MigrationFile, pendingMigrations } from './migrate';

const featureMigrations = ['0021_email_delivery_preferences.sql', '0022_browser_sessions.sql'];

/** Offline rollback only. The complete pre-rollback database is retained in a required backup. */
export function rollbackTo110(
  db: DatabaseSync,
  migrations: readonly MigrationFile[],
  backupPath: string,
) {
  if (!backupPath) throw new Error('A new backup file path is required for rollback');
  if (pendingMigrations(db, migrations).length)
    throw new Error('Apply all migrations before rollback');
  const added = migrations.filter((m) => m.name >= '0021_').map((m) => m.name);
  if (JSON.stringify(added) !== JSON.stringify(featureMigrations)) {
    throw new Error('Rollback supports only the 1.11.0 migration set');
  }
  // VACUUM INTO creates a consistent, complete snapshot and refuses an existing nonempty file.
  // Do this before any destructive statement; all writers/schedulers must already be stopped.
  closeSync(openSync(backupPath, 'wx', 0o600));
  try {
    db.prepare('VACUUM INTO ?').run(backupPath);
  } catch (error) {
    rmSync(backupPath);
    throw error;
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`DROP TRIGGER revoke_browser_sessions_on_disable;
      DROP TABLE browser_sessions;
      DROP TABLE email_digest_items;
      DROP TABLE email_digest_buckets;
      DROP TABLE email_send_attempts;
      DROP TABLE email_delivery_preferences;
      DROP TABLE email_delivery_settings;
      DROP TABLE email_dispatch_runs;
      DROP INDEX idx_notification_deliveries_created;`);
    for (const name of featureMigrations) {
      db.prepare('DELETE FROM schema_migrations WHERE name = ?').run(name);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) {
      throw new Error('Foreign key violations after rollback');
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
  return { rolledBack: featureMigrations, backupPath };
}
