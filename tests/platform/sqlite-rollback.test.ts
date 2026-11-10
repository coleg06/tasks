import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { rollbackTo110 } from '../../src/platform/sqlite/rollback';
import {
  pendingMigrations as previousPending,
  runMigrations as previousRun,
} from '../fixtures/v1.10.0/sqlite-migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';

describe('SQLite rollback to the actual v1.10.0 migration checker', () => {
  it('pins the unmodified checker from v1.10.0 commit 8c84b1d', () => {
    expect(
      createHash('sha256')
        .update(readFileSync('tests/fixtures/v1.10.0/sqlite-migrate.ts'))
        .digest('hex'),
    ).toBe('ce441a21e5314331338d2637d8706a15e0104f399b4454273430a85a60a4ecb6');
  });
  it('backs up feature data, restores old startup checks and data, and can upgrade again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tasks-rollback-'));
    const db = new DatabaseSync(join(dir, 'tasks.db'));
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = readMigrations(effectiveMigrationsDirectory());
    const previous = migrations.filter((m) => m.name < '0021_');
    try {
      previousRun(db, previous);
      db.exec("INSERT INTO users (email) VALUES ('rollback@example.org')");
      runMigrations(db, migrations);
      db.exec(
        "INSERT INTO email_delivery_preferences (user_id, hard_limit) SELECT id, 7 FROM users WHERE email='rollback@example.org'",
      );
      db.exec(`INSERT INTO browser_sessions (id, user_id, authenticated_at, expires_at, absolute_expires_at)
        SELECT 'parent', id, unixepoch(), unixepoch()+3600, unixepoch()+7200 FROM users WHERE email='rollback@example.org';
        INSERT INTO browser_sessions (id, user_id, authenticated_at, expires_at, absolute_expires_at, actor_session_id)
        SELECT 'child', id, unixepoch(), unixepoch()+3600, unixepoch()+7200, 'parent' FROM users WHERE email='rollback@example.org';
        INSERT INTO email_send_attempts (dedupe_key, user_id) SELECT 'retained-in-backup', id FROM users WHERE email='rollback@example.org';`);
      const originalUser = db
        .prepare("SELECT * FROM users WHERE email='rollback@example.org'")
        .get();
      expect(() => previousPending(db, previous)).toThrow('missing from the image');
      const backupPath = join(dir, 'backup.db');
      expect(rollbackTo110(db, migrations, backupPath).rolledBack).toHaveLength(2);
      expect(statSync(backupPath).mode & 0o777).toBe(0o600);
      expect(previousPending(db, previous)).toEqual([]);
      expect(previousRun(db, previous).applied).toEqual([]);
      expect(db.prepare("SELECT * FROM users WHERE email='rollback@example.org'").get()).toEqual(
        originalUser,
      );
      // Exercise legacy writes after rollback, including the previously trigger-bearing table.
      db.exec("UPDATE users SET status='disabled' WHERE email='rollback@example.org'");
      db.exec("UPDATE users SET status='active' WHERE email='rollback@example.org'");
      const snapshot = new DatabaseSync(backupPath);
      try {
        expect(snapshot.prepare('SELECT COUNT(*) AS n FROM browser_sessions').get()).toEqual({
          n: 2,
        });
        expect(snapshot.prepare('SELECT COUNT(*) AS n FROM email_send_attempts').get()).toEqual({
          n: 1,
        });
        expect(snapshot.prepare('SELECT hard_limit FROM email_delivery_preferences').get()).toEqual(
          { hard_limit: 7 },
        );
        expect(snapshot.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({
          n: migrations.length,
        });
      } finally {
        snapshot.close();
      }
      expect(runMigrations(db, migrations).applied).toEqual(
        migrations.filter((m) => m.name >= '0021_').map((m) => m.name),
      );
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      // A failed mandatory backup leaves the fully migrated database untouched.
      expect(() => rollbackTo110(db, migrations, backupPath)).toThrow();
      expect(() => previousPending(db, previous)).toThrow('missing from the image');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
