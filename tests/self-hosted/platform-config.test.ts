/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlatformConfig } from '../../src/self-hosted/platform';
import { startSelfHostedServer } from '../../src/self-hosted/server';

const base = { ENVIRONMENT: 'local', RELEASE_SHA: 'test' } as const;

describe('platform configuration', () => {
  it('is adapter-only (null) when nothing is configured', () => {
    expect(parsePlatformConfig({})).toBeNull();
    expect(parsePlatformConfig({ TASKS_DATASTORE: '' })).toBeNull();
  });

  it('parses a complete sqlite + filesystem configuration with defaults', () => {
    const config = parsePlatformConfig({
      TASKS_DATASTORE: 'sqlite',
      TASKS_SQLITE_PATH: '/data/tasks.db',
      TASKS_OBJECT_STORE: 'filesystem',
      TASKS_OBJECT_STORE_PATH: '/data/objects',
    });
    expect(config).toMatchObject({
      sqlitePath: '/data/tasks.db',
      objectStorePath: '/data/objects',
      migrateOnStart: true,
      scheduler: true,
    });
  });

  it.each([
    [{ TASKS_DATASTORE: 'postgres', TASKS_SQLITE_PATH: '/x' }, 'not supported'],
    [{ TASKS_DATASTORE: 'sqlite' }, 'TASKS_SQLITE_PATH is required'],
    [{ TASKS_DATASTORE: 'sqlite', TASKS_SQLITE_PATH: ':memory:' }, 'filesystem path'],
    [{ TASKS_SQLITE_PATH: '/x/tasks.db' }, 'without TASKS_DATASTORE'],
    [
      { TASKS_OBJECT_STORE: 'filesystem', TASKS_OBJECT_STORE_PATH: '/x' },
      'without TASKS_DATASTORE',
    ],
    [
      { TASKS_DATASTORE: 'sqlite', TASKS_SQLITE_PATH: '/x/t.db', TASKS_OBJECT_STORE: 'filesystem' },
      'TASKS_OBJECT_STORE_PATH is required',
    ],
    [
      { TASKS_DATASTORE: 'sqlite', TASKS_SQLITE_PATH: '/x/t.db', TASKS_OBJECT_STORE_PATH: '/y' },
      'without TASKS_OBJECT_STORE=filesystem',
    ],
    [
      { TASKS_DATASTORE: 'sqlite', TASKS_SQLITE_PATH: '/x/t.db', TASKS_OBJECT_STORE: 's3' },
      'not supported',
    ],
    [
      { TASKS_DATASTORE: 'sqlite', TASKS_SQLITE_PATH: '/x/t.db', TASKS_MIGRATE_ON_START: 'maybe' },
      'TASKS_MIGRATE_ON_START',
    ],
  ])('rejects invalid or partial configuration %#', (extra, message) => {
    expect(() => parsePlatformConfig(extra)).toThrow(message);
  });

  it('startSelfHostedServer rejects before binding a port or creating files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-config-'));
    try {
      await expect(
        startSelfHostedServer({
          ...base,
          TASKS_SITE_PORT: '39999',
          TASKS_SQLITE_PATH: join(directory, 'x.db'),
        }),
      ).rejects.toThrow('without TASKS_DATASTORE');
      await expect(
        startSelfHostedServer({ ...base, TASKS_SITE_PORT: '39999', TASKS_DATASTORE: 'sqlite' }),
      ).rejects.toThrow('TASKS_SQLITE_PATH is required');
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Worker bundle isolation', () => {
  it('keeps node:sqlite out of the Worker bundle and out of Worker-reachable sources', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-bundle-'));
    try {
      const outfile = join(directory, 'worker.js');
      execFileSync(
        resolve('node_modules/.bin/esbuild'),
        [
          'src/index.ts',
          '--bundle',
          '--format=esm',
          '--platform=browser',
          '--target=es2023',
          '--conditions=worker,browser',
          '--external:node:*',
          `--outfile=${outfile}`,
          '--log-level=error',
        ],
        { stdio: 'pipe' },
      );
      const bundle = readFileSync(outfile, 'utf8');
      expect(bundle).not.toMatch(/node:sqlite/);
      expect(bundle).not.toMatch(/DatabaseSync/);
      expect(bundle).not.toMatch(/self-hosted|fs-object-store/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
