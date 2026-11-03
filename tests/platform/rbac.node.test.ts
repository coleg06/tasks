/// <reference types="node" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';
import { describeRbacScenario } from './rbac-scenario';

describeRbacScenario('node:sqlite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-rbac-'));
  const database = new SqliteDatabase(join(directory, 'rbac.db'));
  runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
  return {
    db: database,
    dispose: async () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
});
