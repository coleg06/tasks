/// <reference types="node" />
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';
import { describeSessionLifecycle } from './session-lifecycle';

describeSessionLifecycle('node:sqlite', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-sessions-'));
  const path = join(directory, 'sessions.db');
  let database = new SqliteDatabase(path);
  runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
  return {
    db: database,
    restart: async () => {
      database.close();
      database = new SqliteDatabase(path);
      return database;
    },
    dispose: async () => {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
});
