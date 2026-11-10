import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';
import { describeEmailDelivery } from './email-delivery-scenario';

describeEmailDelivery('node:sqlite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tasks-email-'));
  const db = new SqliteDatabase(join(dir, 'email.db'));
  runMigrations(db.raw, readMigrations(effectiveMigrationsDirectory()));
  return {
    db,
    dispose: async () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
});
