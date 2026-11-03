/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { ObjectStore, SqlDatabase } from '../../src/platform/ports';
import { effectiveMigrationsDirectory } from '../support/migrations';

export interface WorkerdBindings {
  db: SqlDatabase;
  bucket: ObjectStore;
  dispose(): Promise<void>;
}

/**
 * Real Cloudflare bindings backed by workerd (Miniflare, via wrangler's platform proxy).
 * Migrations are applied with `wrangler d1 migrations apply --local`, the same code path used
 * for real D1 databases, so this also proves the migration files are valid D1 input.
 */
export async function openWorkerdBindings(): Promise<WorkerdBindings> {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-workerd-'));
  const state = join(directory, 'state');
  const config = join(directory, 'wrangler.jsonc');
  writeFileSync(
    config,
    JSON.stringify({
      name: 'conformance',
      compatibility_date: '2026-01-01',
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'conformance',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: effectiveMigrationsDirectory(),
        },
      ],
      r2_buckets: [{ binding: 'BUCKET', bucket_name: 'conformance-bucket' }],
    }),
  );
  execFileSync(
    resolve('node_modules/.bin/wrangler'),
    ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state, '--config', config],
    {
      stdio: 'pipe',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
    },
  );
  const proxy = await getPlatformProxy<{ DB: SqlDatabase; BUCKET: ObjectStore }>({
    configPath: config,
    persist: { path: join(state, 'v3') },
  });
  return {
    db: proxy.env.DB,
    bucket: proxy.env.BUCKET,
    dispose: async () => {
      await proxy.dispose();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
