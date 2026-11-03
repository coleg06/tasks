import { afterEach, describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { app } from '../src/app';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  safeReturnTo,
  signSession,
  verifyOAuthState,
} from '../src/auth/session';
import type { Env } from '../src/env';
import { SessionIdentityProvider } from '../src/identity/session';
import { testOrigins } from './support/origins';
import { matchingTenantConfigurationRow } from './tenant-configuration-fixture';

const ORIGIN = testOrigins.development;
const CSRF_COOKIE = `${tenantProfile.security.cookiePrefix}_csrf`;
const CSRF = 'c'.repeat(43);
const ALL_PERMISSIONS = [
  'platform.admin',
  'tasks.comment',
  'tasks.manage',
  'tasks.personal',
  'tasks.view',
];

type User = { id: number; email: string; status: string };

const manager: User = { id: 2, email: 'manager@example.test', status: 'active' };
const admin: User = { id: 3, email: 'admin@example.test', status: 'active' };
const ordinary: User = { id: 4, email: 'person@example.test', status: 'active' };
const users = new Map([manager, admin, ordinary].map((user) => [user.id, user]));
const direct = new Map<number, string[]>([
  [manager.id, ['tasks.view', 'tasks.personal', 'tasks.comment', 'tasks.manage']],
  [admin.id, ['platform.admin']],
  [ordinary.id, ['tasks.view', 'tasks.personal']],
]);

function permissionsFor(userId: number) {
  const own = direct.get(userId) ?? [];
  const expanded = own.includes('platform.admin') ? ALL_PERMISSIONS : own;
  return ALL_PERMISSIONS.filter((permission) => expanded.includes(permission)).sort();
}

function environment() {
  const writes: string[] = [];
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first() {
        if (sql.includes('FROM tenant_configuration')) return matchingTenantConfigurationRow;
        if (sql.includes('FROM users WHERE id = ?')) return users.get(Number(values[0])) ?? null;
        if (sql.includes('is_platform_admin')) {
          const target = users.get(Number(values[0]));
          if (!target) return null;
          return {
            ...target,
            first_name: '',
            last_name: '',
            google_subject: null,
            is_manager: permissionsFor(target.id).includes('tasks.manage') ? 1 : 0,
            is_event_manager: 0,
            can_approve_events: 0,
            has_task_access: permissionsFor(target.id).includes('tasks.view') ? 1 : 0,
            is_platform_admin: direct.get(target.id)?.includes('platform.admin') ? 1 : 0,
          };
        }
        if (sql.includes("permission_key IN (?, 'platform.admin')")) {
          return permissionsFor(Number(values[0])).includes(String(values[1]))
            ? { allowed: 1 }
            : null;
        }
        throw new Error(`Unexpected first query: ${sql}`);
      },
      async all() {
        if (sql.includes('FROM permissions p')) {
          return {
            results: permissionsFor(Number(values[0])).map((permission_key) => ({
              permission_key,
            })),
          };
        }
        throw new Error(`Unexpected all query: ${sql}`);
      },
      async run() {
        writes.push(sql);
        return { meta: { changes: 1 } };
      },
    };
    return statement;
  };
  const env = {
    ASSETS: { fetch: async () => new Response('asset') },
    DB: { prepare, batch: async (statements: unknown[]) => statements.map(() => ({ meta: {} })) },
    ENVIRONMENT: 'dev',
    RELEASE_SHA: 'test-release',
    SESSION_SECRET: 'admin-privilege-regression-secret-0123456789',
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
  } as unknown as Env;
  return { env, writes };
}

async function authenticated(env: Env, user: User, path: string, init: RequestInit) {
  const token = await signSession(env, user, permissionsFor(user.id));
  return app.request(
    `${ORIGIN}${path}`,
    {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${CSRF}`,
        Origin: ORIGIN,
        'X-CSRF-Token': CSRF,
        ...init.headers,
      },
    },
    env,
  );
}

describe('post-login redirect target', () => {
  it('keeps only same-origin absolute paths', () => {
    expect(safeReturnTo(undefined)).toBe('/');
    expect(safeReturnTo('/tasks/T-1?view=open')).toBe('/tasks/T-1?view=open');
    for (const hostile of [
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'https://evil.example',
      'evil.example',
      `/${'a'.repeat(3_000)}`,
    ]) {
      expect(safeReturnTo(hostile), JSON.stringify(hostile)).toBe('/');
    }
  });

  it.skipIf(tenantProfile.tasks.apiMode !== 'legacy')(
    'signs the sanitised target into the OAuth state cookie',
    async () => {
      const { env } = environment();
      const response = await app.request(
        `${ORIGIN}/auth/login?returnTo=${encodeURIComponent('/\\evil.example')}`,
        {},
        env,
      );
      expect(response.status).toBe(302);
      const cookie = response.headers.get('set-cookie') ?? '';
      const state = new RegExp(`${OAUTH_COOKIE}=([^;]+)`).exec(cookie)?.[1] ?? '';
      expect((await verifyOAuthState(env, state)).returnTo).toBe('/');
    },
  );
});

// These suites exercise legacy routes (/api/admin, /api/agent/v1, /auth/login). A portable tenant
// profile closes those routes, so they only apply when apiMode is 'legacy'.
const legacyOnly = describe.skipIf(tenantProfile.tasks.apiMode !== 'legacy');

legacyOnly('administrator privilege boundaries', () => {
  it('refuses to let a task manager impersonate a platform administrator', async () => {
    const { env, writes } = environment();
    const response = await authenticated(env, manager, `/api/admin/users/${admin.id}/impersonate`, {
      method: 'POST',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'platform_admin_required' });
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('still lets a task manager impersonate a user with fewer privileges', async () => {
    const { env } = environment();
    const response = await authenticated(
      env,
      manager,
      `/api/admin/users/${ordinary.id}/impersonate`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });

  it('lets a platform administrator impersonate a manager', async () => {
    const { env } = environment();
    const response = await authenticated(env, admin, `/api/admin/users/${manager.id}/impersonate`, {
      method: 'POST',
    });
    expect(response.status).toBe(200);
  });

  it('refuses to let a task manager edit or disable a platform administrator', async () => {
    const { env, writes } = environment();
    const response = await authenticated(env, manager, `/api/admin/users/${admin.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'platform_admin_required' });
    expect(writes).toEqual([]);
  });
});

legacyOnly('impersonation is re-authorized on every request', () => {
  const resolve = async (env: Env, token: string, permission = 'tasks.view') =>
    new SessionIdentityProvider(env).resolve({ kind: 'browser', token, permission });
  const restore = () => {
    direct.set(ordinary.id, ['tasks.view', 'tasks.personal']);
    direct.set(manager.id, ['tasks.view', 'tasks.personal', 'tasks.comment', 'tasks.manage']);
    users.set(manager.id, manager);
    users.set(ordinary.id, ordinary);
  };
  afterEach(restore);

  async function impersonationToken(env: Env) {
    return signSession(env, ordinary, permissionsFor(ordinary.id), manager);
  }

  it('accepts a valid impersonation and attributes it to the actor', async () => {
    const { env } = environment();
    const resolved = await resolve(env, await impersonationToken(env));
    expect(resolved?.principal.email).toBe(ordinary.email);
    expect(resolved?.taskIdentity.auditUserId).toBe(manager.id);
  });

  it('rejects the existing cookie once the target is promoted above the actor', async () => {
    const { env } = environment();
    const token = await impersonationToken(env);
    direct.set(ordinary.id, ['platform.admin']);
    expect(await resolve(env, token)).toBeNull();
    expect(await resolve(env, token, 'platform.admin')).toBeNull();
  });

  it('rejects when the target gains any permission the actor lacks', async () => {
    const { env } = environment();
    const token = await impersonationToken(env);
    direct.set(manager.id, ['tasks.view', 'tasks.manage']);
    direct.set(ordinary.id, ['tasks.view', 'tasks.personal']);
    expect(await resolve(env, token)).toBeNull();
  });

  it('rejects after the actor loses the impersonation permission', async () => {
    const { env } = environment();
    const token = await impersonationToken(env);
    direct.set(manager.id, ['tasks.view', 'tasks.personal', 'tasks.comment']);
    expect(await resolve(env, token)).toBeNull();
  });

  it('rejects after the actor is disabled', async () => {
    const { env } = environment();
    const token = await impersonationToken(env);
    users.set(manager.id, { ...manager, status: 'disabled' });
    expect(await resolve(env, token)).toBeNull();
  });

  it('rejects when the actor no longer exists', async () => {
    const { env } = environment();
    const token = await impersonationToken(env);
    users.delete(manager.id);
    expect(await resolve(env, token)).toBeNull();
  });

  it('does not affect ordinary sessions', async () => {
    const { env } = environment();
    const token = await signSession(env, ordinary, permissionsFor(ordinary.id));
    expect((await resolve(env, token))?.principal.email).toBe(ordinary.email);
  });
});

legacyOnly('stopping impersonation always succeeds', () => {
  const restoreState = () => {
    direct.set(manager.id, ['tasks.view', 'tasks.personal', 'tasks.comment', 'tasks.manage']);
    users.set(manager.id, manager);
  };
  afterEach(restoreState);

  async function stop() {
    const { env, writes } = environment();
    const token = await signSession(env, ordinary, permissionsFor(ordinary.id), manager);
    const response = await app.request(
      `${ORIGIN}/api/admin/impersonation/stop`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${CSRF}`,
          Origin: ORIGIN,
          'X-CSRF-Token': CSRF,
        },
      },
      env,
    );
    const cookie = response.headers.get('set-cookie') ?? '';
    return { response, cookie, writes };
  }
  const cleared = (cookie: string) =>
    new RegExp(
      `${SESSION_COOKIE}=;|${SESSION_COOKIE}=[^;]*;.*(Max-Age=0|Expires=Thu, 01 Jan 1970)`,
      'i',
    ).test(cookie);

  it('restores the actor session when the actor is still authorized', async () => {
    const { response, cookie, writes } = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(cookie).toContain(`${SESSION_COOKIE}=`);
    expect(cleared(cookie)).toBe(false);
    expect(writes.some((sql) => sql.includes('audit_events'))).toBe(true);
  });

  it.each([
    ['demoted', () => direct.set(manager.id, ['tasks.view', 'tasks.personal'])],
    ['disabled', () => users.set(manager.id, { ...manager, status: 'disabled' })],
    ['deleted', () => users.delete(manager.id)],
  ])('ends the session without restoring it when the actor is %s', async (_name, change) => {
    change();
    const { response, cookie, writes } = await stop();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, restored: false });
    expect(cleared(cookie)).toBe(true);
    expect(cookie).not.toMatch(new RegExp(`${SESSION_COOKIE}=ey`));
    expect(writes.some((sql) => sql.includes('audit_events'))).toBe(true);
  });
});

legacyOnly('agent API credential scope', () => {
  const gateway = 'g'.repeat(40);
  const credentials = (scope: 'read' | 'read_write') =>
    JSON.stringify({
      version: 1,
      credentials: [
        {
          clientId: 'scope-test',
          name: 'Scope test',
          role: 'Agent',
          runtime: 'test',
          scope,
          token: 't'.repeat(40),
        },
      ],
    });
  const call = (scope: 'read' | 'read_write', method: string, path: string) => {
    const { env } = environment();
    return app.request(
      `${ORIGIN}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          [tenantProfile.mcp.gatewayHeader]: gateway,
          Authorization: `Bearer ${'t'.repeat(40)}`,
        },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ body: 'x' }) }),
      },
      {
        ...env,
        TASKS_MCP_GATEWAY_SECRET: gateway,
        TASKS_MCP_CREDENTIALS_JSON: credentials(scope),
      },
    );
  };

  it('rejects direct HTTP writes from a read-only credential before touching data', async () => {
    for (const [method, path] of [
      ['POST', '/api/agent/v1/tasks'],
      ['PATCH', '/api/agent/v1/tasks/TASK-1'],
      ['POST', '/api/agent/v1/tasks/TASK-1/comments'],
    ] as const) {
      const response = await call('read', method, path);
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'credential_read_only' });
    }
  });

  it('does not apply the read-only rejection to reads or read-write credentials', async () => {
    // Reads and read-write writes continue past the scope gate; the stub database
    // then reports the agent principal as unavailable (503), which proves they were not 403.
    const read = await call('read', 'GET', '/api/agent/v1/tasks');
    expect(read.status).not.toBe(403);
    const write = await call('read_write', 'POST', '/api/agent/v1/tasks');
    expect(write.status).not.toBe(403);
  });
});
