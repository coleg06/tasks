/// <reference types="node" />

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { signSession } from '../../src/auth/session';
import type { Env } from '../../src/env';
import { type RunningSelfHostedServer, startSelfHostedServer } from '../../src/self-hosted/server';
import { effectiveMigrationsDirectory } from '../support/migrations';

const GATEWAY = 'g'.repeat(40);
const MCP_TOKEN = 't'.repeat(40);

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

const legacy = tenantProfile.tasks.apiMode === 'legacy';

// The legacy surface (tasks, admin, session login, MCP) only exists for a legacy tenant profile.
describe.skipIf(!legacy)(
  'self-hosted server with sqlite + filesystem object store (real server, real files)',
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-e2e-'));
    const dataDirectory = join(directory, 'data');
    let running: RunningSelfHostedServer;
    let base = '';
    let cookie = '';
    const csrf = 'c'.repeat(43);
    const headers = (extra: Record<string, string> = {}) => ({
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: base,
      'X-CSRF-Token': csrf,
      ...extra,
    });

    beforeAll(async () => {
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      running = await startSelfHostedServer({
        ENVIRONMENT: 'local',
        RELEASE_SHA: 'e2e',
        SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
        GOOGLE_CLIENT_ID: 'e2e-client-id',
        GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
        TASKS_SITE_HOST: '127.0.0.1',
        TASKS_SITE_PORT: String(port),
        TASKS_DATASTORE: 'sqlite',
        TASKS_SQLITE_PATH: join(dataDirectory, 'tasks.db'),
        TASKS_OBJECT_STORE: 'filesystem',
        TASKS_OBJECT_STORE_PATH: join(dataDirectory, 'objects'),
        TASKS_MIGRATIONS_DIR: effectiveMigrationsDirectory(),
        TASKS_SCHEDULER: 'enabled',
        TASKS_MCP_GATEWAY_SECRET: GATEWAY,
        TASKS_MCP_CREDENTIALS_JSON: JSON.stringify({
          version: 1,
          credentials: [
            {
              clientId: 'e2e',
              name: 'E2E',
              role: 'Agent',
              runtime: 'test',
              scope: 'read_write',
              token: MCP_TOKEN,
            },
          ],
        }),
      });
      // The session/identity path is Google-specific (cookie signed by this app); seeding a user
      // and signing a session stands in for the OAuth redirect, which needs a Google tenant.
      const admin = tenantProfile.identity.initialAdminEmail;
      const env = running.env as Env;
      await env.DB.prepare('INSERT INTO users (email, first_name) VALUES (?, ?)')
        .bind(admin, 'Admin')
        .run();
      const user = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
        .bind(admin)
        .first<{ id: number }>();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'platform.admin')",
      )
        .bind(user?.id)
        .run();
      await env.DB.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, ?, 'owner' FROM workspaces",
      )
        .bind(user?.id)
        .run();
      const permissions = (
        await env.DB.prepare('SELECT key FROM permissions ORDER BY key').all<{ key: string }>()
      ).results.map((row) => row.key);
      const token = await signSession(env, { id: Number(user?.id), email: admin }, permissions);
      cookie = `${tenantProfile.security.cookiePrefix}_session=${token}; ${tenantProfile.security.cookiePrefix}_csrf=${csrf}`;
    });

    afterAll(async () => {
      await running?.close();
      rmSync(directory, { recursive: true, force: true });
    });

    it('migrated an empty database, created the data files, and is ready', async () => {
      expect(readdirSync(dataDirectory).sort()).toEqual(
        expect.arrayContaining(['objects', 'tasks.db']),
      );
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ ok: true, tenant: tenantProfile.key });
    });

    it('rejects unauthenticated API access', async () => {
      expect((await fetch(`${base}/api/tasks`)).status).toBe(401);
      expect([401, 403]).toContain((await fetch(`${base}/api/admin`)).status);
    });

    it('serves the full legacy API: create, read, update with version check, comment, admin', async () => {
      const created = await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          title: 'Self-hosted round trip',
          description: 'persisted in sqlite',
          status: 'not_started',
          priority: null,
          effort: null,
          assigneeEmail: null,
          dueDate: null,
          projectKey: tenantProfile.defaultProjectKey,
          taskTypes: [],
        }),
      });
      expect(created.status).toBe(201);
      const { task } = (await created.json()) as { task: { key: string; version: number } };

      const fetched = await fetch(`${base}/api/tasks/${task.key}`, { headers: headers() });
      expect(fetched.status).toBe(200);

      // Exercises the `meta.changes !== 1` optimistic-concurrency check on an FTS-trigger table.
      const patched = await fetch(`${base}/api/tasks/${task.key}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ title: 'Self-hosted round trip (edited)' }),
      });
      expect(patched.status).toBe(200);

      const stale = await fetch(`${base}/api/tasks/${task.key}`, {
        method: 'PATCH',
        headers: headers({ 'If-Match': '"1"' }),
        body: JSON.stringify({ title: 'stale write' }),
      });
      expect(stale.status).toBe(409);

      const comment = await fetch(`${base}/api/tasks/${task.key}/comments`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ body: 'hello from sqlite', mutationKey: 'e2e-comment-1' }),
      });
      expect([200, 201]).toContain(comment.status);

      const listed = (await (
        await fetch(`${base}/api/tasks?view=backlog`, { headers: headers() })
      ).json()) as {
        tasks: { key: string; title: string }[];
      };
      expect(listed.tasks.find((entry) => entry.key === task.key)?.title).toBe(
        'Self-hosted round trip (edited)',
      );

      const searched = (await (
        await fetch(`${base}/api/tasks?view=backlog&search=edited`, { headers: headers() })
      ).json()) as { tasks: { key: string }[] };
      expect(searched.tasks.map((entry) => entry.key)).toContain(task.key);

      const admin = await fetch(`${base}/api/admin`, { headers: headers() });
      expect(admin.status).toBe(200);
    });

    it('serves MCP at /mcp: rejects anonymous callers, lists tools for a credentialed client', async () => {
      const anonymous = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
      expect(anonymous.status).toBe(403);
      const response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${MCP_TOKEN}`,
          'Content-Type': 'application/json',
          [tenantProfile.mcp.gatewayHeader]: GATEWAY,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('task');
    });

    it('stores event assets on the filesystem object store', async () => {
      const env = running.env as Env;
      await env.EVENT_ASSETS.put('events/E-1/D-1/probe', 'asset bytes');
      expect((await env.EVENT_ASSETS.get('events/E-1/D-1/probe'))?.size).toBe(11);
    });

    it('/readyz fails when the datastore becomes unavailable', async () => {
      const env = running.env as Env;
      const original = env.PLATFORM_READINESS_CHECKS;
      env.PLATFORM_READINESS_CHECKS = [
        async () => {
          throw new Error('datastore down');
        },
      ];
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      env.PLATFORM_READINESS_CHECKS = original as NonNullable<typeof original>;
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    });
  },
);

describe.skipIf(!legacy)('identity configuration in sqlite mode', () => {
  const secretValue = 'super-secret-value-that-must-not-leak';
  const common = (directory: string, port: number) => ({
    RELEASE_SHA: 'identity',
    TASKS_SITE_HOST: '127.0.0.1',
    TASKS_SITE_PORT: String(port),
    TASKS_DATASTORE: 'sqlite',
    TASKS_SQLITE_PATH: join(directory, 'data', 'tasks.db'),
    TASKS_MIGRATIONS_DIR: effectiveMigrationsDirectory(),
  });

  it('refuses to start in production without session/identity credentials, naming only variables', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-identity-'));
    try {
      const port = await freePort();
      const failure = await startSelfHostedServer({
        ...common(directory, port),
        ENVIRONMENT: 'production',
        GOOGLE_CLIENT_SECRET: secretValue,
      }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure?.message).toBe(
        'Missing required identity configuration: SESSION_SECRET, GOOGLE_CLIENT_ID',
      );
      expect(failure?.message).not.toContain(secretValue);
      expect(readdirSync(directory)).toEqual([]); // nothing opened, nothing created
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow(); // nothing bound
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts outside production but never reports ready while identity is incomplete', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-identity-'));
    const port = await freePort();
    const running = await startSelfHostedServer({
      ...common(directory, port),
      ENVIRONMENT: 'local',
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
    } finally {
      await running.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts in production when the credentials are present', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-identity-'));
    const port = await freePort();
    const running = await startSelfHostedServer({
      ...common(directory, port),
      ENVIRONMENT: 'production',
      SESSION_SECRET: 'x'.repeat(40),
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    try {
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    } finally {
      await running.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('default adapter-only mode is unchanged', () => {
  it('has no datastore: legacy routes stay closed and /readyz is not ready', async () => {
    const port = await freePort();
    const adapterOnly = await startSelfHostedServer({
      ENVIRONMENT: 'local',
      RELEASE_SHA: 'plain',
      TASKS_SITE_HOST: '127.0.0.1',
      TASKS_SITE_PORT: String(port),
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      // Legacy profile: the tenant gate fails closed (503). Portable profile: routes do not exist.
      const closed = legacy ? 503 : 404;
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/readyz`)).status).toBe(503);
      expect((await fetch(`${base}/api/tasks`)).status).toBe(closed);
      expect((await fetch(`${base}/api/admin`)).status).toBe(closed);
      // MCP is off unless enabled, so it is absent (404) regardless of the tenant gate.
      expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
      expect((adapterOnly.env as { DB?: unknown }).DB).toBeUndefined();
    } finally {
      await adapterOnly.close();
    }
  });
});

describe.skipIf(legacy)('portable tenant profile with sqlite configured', () => {
  it('does not widen the surface: legacy routes remain closed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-portable-'));
    const port = await freePort();
    const running = await startSelfHostedServer({
      ENVIRONMENT: 'local',
      RELEASE_SHA: 'portable',
      TASKS_SITE_HOST: '127.0.0.1',
      TASKS_SITE_PORT: String(port),
      TASKS_DATASTORE: 'sqlite',
      TASKS_SQLITE_PATH: join(directory, 'tasks.db'),
      TASKS_MIGRATIONS_DIR: effectiveMigrationsDirectory(),
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      for (const path of ['/api/tasks', '/api/admin', '/api/agent/v1/tasks', '/auth/login']) {
        expect((await fetch(`${base}${path}`)).status, path).toBe(404);
      }
      expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
    } finally {
      await running.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
