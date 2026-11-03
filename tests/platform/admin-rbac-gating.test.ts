/// <reference types="node" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { app } from '../../src/app';
import { signSession } from '../../src/auth/session';
import type { Env } from '../../src/env';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';

const ORIGIN = 'http://tasks.invalid';
const CSRF = 'c'.repeat(43);
const legacy = tenantProfile.tasks.apiMode === 'legacy';

// The profile is the tenant's decision: a tenant that replaces user administration, or serves the
// portable task API from an external backend, must not gain the role endpoints.
describe.skipIf(!legacy)('role and directory endpoints respect the tenant profile', () => {
  let directory = '';
  let database: SqliteDatabase;
  let env: Env;
  let cookie = '';

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'tasks-rbac-gate-'));
    database = new SqliteDatabase(join(directory, 'gate.db'));
    runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
    env = {
      DB: database,
      ASSETS: { fetch: async () => new Response('asset') },
      ENVIRONMENT: 'local',
      RELEASE_SHA: 'gate',
      SESSION_SECRET: 'gate-session-secret-0123456789abcdef0123456789abcd',
    } as unknown as Env;
    const user = await env.DB.prepare(
      "INSERT INTO users (email) VALUES ('gate-admin@example.org') RETURNING id",
    ).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO user_permissions (user_id, permission_key) VALUES (?, 'platform.admin')",
    )
      .bind(user?.id)
      .run();
    const token = await signSession(
      env,
      { id: Number(user?.id), email: 'gate-admin@example.org' },
      [],
    );
    const prefix = tenantProfile.security.cookiePrefix;
    cookie = `${prefix}_session=${token}; ${prefix}_csrf=${CSRF}`;
  });
  afterAll(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const call = (method: string, path: string, body?: unknown) =>
    app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie,
          Origin: ORIGIN,
          'X-CSRF-Token': CSRF,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );

  const endpoints: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/roles'],
    ['POST', '/api/admin/roles', { label: 'X', permissions: ['tasks.view'] }],
    ['PATCH', '/api/admin/roles/viewer', { label: 'X' }],
    ['DELETE', '/api/admin/roles/viewer'],
    ['GET', '/api/admin/directory'],
    ['GET', '/api/admin/audit'],
    ['GET', '/api/admin/users/1'],
    ['PUT', '/api/admin/users/1/roles', { roles: [] }],
    ['POST', '/api/admin/users/bulk', { action: 'disable', userIds: [1] }],
    ['POST', '/api/admin/users/bulk-invite', { entries: [{ email: 'a@example.org' }] }],
  ];

  it('serves them when user administration is enabled', async () => {
    expect((await call('GET', '/api/admin/roles')).status).toBe(200);
    expect((await call('GET', '/api/admin/directory')).status).toBe(200);
    expect((await call('GET', '/api/admin/audit')).status).toBe(200);
  });

  it('answers 404 for every one of them when the tenant disables user administration', async () => {
    const tasks = tenantProfile.tasks as { userAdministration: boolean };
    const original = tasks.userAdministration;
    tasks.userAdministration = false;
    try {
      for (const [method, path, body] of endpoints) {
        expect((await call(method, path, body)).status, `${method} ${path}`).toBe(404);
      }
    } finally {
      tasks.userAdministration = original;
    }
  });

  it('closes every one of them on a portable tenant, which never reaches /api/admin', async () => {
    const tasks = tenantProfile.tasks as { apiMode: string };
    const original = tasks.apiMode;
    tasks.apiMode = 'portable';
    try {
      for (const [method, path, body] of endpoints) {
        expect((await call(method, path, body)).status, `${method} ${path}`).toBe(404);
      }
    } finally {
      tasks.apiMode = original;
    }
  });
});
