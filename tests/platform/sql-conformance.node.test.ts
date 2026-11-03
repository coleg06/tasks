/// <reference types="node" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';
import { describeSqlContract } from './sql-contract';

describeSqlContract('node:sqlite driver', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-sql-'));
  const database = new SqliteDatabase(join(directory, 'conformance.db'));
  runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
  return {
    db: database,
    dispose: async () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
});
