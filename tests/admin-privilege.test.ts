import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { withBrowserSessionStore } from './support/browser-session-store';
import { testOrigins } from './support/origins';

const legacyApi = tenantProfile.tasks.apiMode === 'legacy';

import { app } from '../src/app';
import { SESSION_COOKIE, safeReturnTo, signSession } from '../src/auth/session';
import type { Env } from '../src/env';
import { matchingTenantConfigurationRow } from './tenant-configuration-fixture';

type FakeUser = { id: number; email: string; status: string; permissions: string[] };

const ALL = ['platform.admin', 'tasks.comment', 'tasks.manage', 'tasks.personal', 'tasks.view'];

function fakeEnv(users: FakeUser[]) {
  const writes: string[] = [];
  const updateBinds: unknown[][] = [];
  const byId = (id: unknown) => users.find((user) => user.id === Number(id));
  const expand = (user?: FakeUser) =>
    !user ? [] : user.permissions.includes('platform.admin') ? ALL : user.permissions;
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      get sql() {
        return sql;
      },
      get values() {
        return values;
      },
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first() {
        if (sql.includes('FROM tenant_configuration')) return matchingTenantConfigurationRow;
        if (sql.includes('FROM users WHERE id = ?')) {
          const user = byId(values[0]);
          return user ? { id: user.id, email: user.email, status: user.status } : null;
        }
        if (sql.includes('FROM users u WHERE u.id = ?')) {
          const user = byId(values[0]);
          if (!user) return null;
          return {
            id: user.id,
            email: user.email,
            first_name: 'First',
            last_name: 'Last',
            google_subject: 'subject',
            status: user.status,
            is_manager: Number(user.permissions.includes('tasks.manage')),
            is_event_manager: 0,
            can_approve_events: 0,
            has_task_access: Number(user.permissions.includes('tasks.view')),
            is_platform_admin: Number(user.permissions.includes('platform.admin')),
          };
        }
        if (
          sql.includes('FROM effective_user_permissions') &&
          sql.includes("IN (?, 'platform.admin')")
        ) {
          const user = byId(values[0]);
          return user?.permissions.some((p) => p === values[1] || p === 'platform.admin')
            ? { allowed: 1 }
            : null;
        }
        if (sql.includes('SELECT id FROM users WHERE email')) return null;
        return null;
      },
      async all() {
        if (sql.includes('FROM permissions p')) {
          return { results: expand(byId(values[0])).map((permission_key) => ({ permission_key })) };
        }
        return { results: [] };
      },
      async run() {
        writes.push(sql);
        if (sql.startsWith('UPDATE users SET')) updateBinds.push(values);
        return { success: true, meta: {} };
      },
    };
    return statement;
  };
  const DB = {
    prepare,
    batch: async (statements: Array<{ sql?: string; values?: unknown[] }>) => {
      writes.push('batch');
      for (const statement of statements) {
        if (statement.sql?.startsWith('UPDATE users SET') && statement.values) {
          updateBinds.push(statement.values);
        }
      }
      return statements.map(() => ({ success: true }));
    },
  };
  const env = {
    ASSETS: { fetch: async () => new Response('asset') },
    DB,
    ENVIRONMENT: 'dev',
    SESSION_SECRET: 'admin-privilege-test-secret-value',
  } as unknown as Env;
  withBrowserSessionStore(env);
  return { env, writes, updateBinds };
}

const CSRF_COOKIE = `${tenantProfile.security.cookiePrefix}_csrf`;
const CSRF = 'c'.repeat(40);

async function browserHeaders(env: Env, user: FakeUser) {
  const token = await signSession(env, user, []);
  return {
    Cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${CSRF}`,
    Origin: `${testOrigins.development}`,
    'X-CSRF-Token': CSRF,
  };
}

const manager: FakeUser = {
  id: 1,
  email: 'manager@example.org',
  status: 'active',
  permissions: ['tasks.manage', 'tasks.view', 'tasks.comment', 'tasks.personal'],
};
const admin: FakeUser = {
  id: 2,
  email: 'admin@example.org',
  status: 'active',
  permissions: ['platform.admin'],
};
const peer: FakeUser = { ...manager, id: 3, email: 'peer@example.org' };

describe.runIf(legacyApi)('impersonation never raises privilege', () => {
  it('refuses a manager impersonating a platform administrator', async () => {
    const { env, writes } = fakeEnv([manager, admin]);
    const response = await app.request(
      `${testOrigins.development}/api/admin/users/2/impersonate`,
      { method: 'POST', headers: await browserHeaders(env, manager) },
      env,
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(writes).toEqual([]);
  });

  it('still allows equal-privilege and administrator impersonation', async () => {
    const equal = fakeEnv([manager, peer]);
    const sameLevel = await app.request(
      `${testOrigins.development}/api/admin/users/3/impersonate`,
      { method: 'POST', headers: await browserHeaders(equal.env, manager) },
      equal.env,
    );
    expect(sameLevel.status).toBe(200);
    const elevated = fakeEnv([manager, admin]);
    const asAdmin = await app.request(
      `${testOrigins.development}/api/admin/users/1/impersonate`,
      { method: 'POST', headers: await browserHeaders(elevated.env, admin) },
      elevated.env,
    );
    expect(asAdmin.status).toBe(200);
  });
});

describe.runIf(legacyApi)('manager edits of platform administrators', () => {
  const patch = (env: Env, userId: number, headers: Record<string, string>, body: unknown) =>
    app.request(
      `${testOrigins.development}/api/admin/users/${userId}`,
      {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env,
    );

  it('blocks a manager from disabling or editing a platform administrator', async () => {
    const { env, writes } = fakeEnv([manager, admin]);
    const cookie = await browserHeaders(env, manager);
    expect((await patch(env, 2, cookie, { status: 'disabled' })).status).toBe(403);
    expect((await patch(env, 2, cookie, { firstName: 'Changed' })).status).toBe(403);
    expect(writes).toEqual([]);
  });

  it('keeps the current status when status is omitted', async () => {
    const disabled: FakeUser = { ...peer, status: 'disabled' };
    const { env, updateBinds } = fakeEnv([manager, disabled]);
    const response = await patch(env, 3, await browserHeaders(env, manager), {
      firstName: 'Renamed',
    });
    expect(response.status).toBe(200);
    expect(updateBinds).toHaveLength(1);
    expect(updateBinds[0]?.[3]).toBe('disabled');
  });
});

describe('returnTo validation', () => {
  it('rejects backslashes, control characters and protocol-relative paths', () => {
    expect(safeReturnTo('/events?x=1')).toBe('/events?x=1');
    expect(safeReturnTo('/')).toBe('/');
    for (const bad of [
      '/\\evil.example',
      '//evil.example',
      '/a\\b',
      '/a\nb',
      '/a\tb',
      '/a\u007f',
      'https://evil.example',
      'evil',
    ]) {
      expect(safeReturnTo(bad), JSON.stringify(bad)).toBe('/');
    }
  });
});

describe.runIf(legacyApi)('agent API credential scope', () => {
  const gateway = 'gateway-test-value-that-is-at-least-32-characters';
  const token = 'client-test-value-that-is-at-least-32-characters';
  const credentialsEnv = (scope: 'read' | 'read_write') => ({
    ...fakeEnv([]).env,
    TASKS_MCP_GATEWAY_SECRET: gateway,
    TASKS_MCP_CREDENTIALS_JSON: JSON.stringify({
      version: 1,
      credentials: [
        {
          clientId: 'scope-test',
          name: 'Scope Test',
          role: 'Agent',
          runtime: 'codex',
          scope,
          token,
        },
      ],
    }),
  });
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Tasks-MCP-Gateway-Token': gateway,
  };

  it('rejects every non-GET request from a read-only credential', async () => {
    const env = credentialsEnv('read');
    const requests: [string, string][] = [
      ['POST', '/api/agent/v1/tasks'],
      ['PATCH', '/api/agent/v1/tasks/TASK-1'],
      ['POST', '/api/agent/v1/tasks/TASK-1/comments'],
      ['DELETE', '/api/agent/v1/tasks/TASK-1'],
    ];
    for (const [method, path] of requests) {
      const response = await app.request(
        `${testOrigins.development}${path}`,
        { method, headers, body: '{}' },
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({ error: 'credential_read_only' });
    }
  });

  it('does not block a read_write credential at the scope check', async () => {
    const response = await app.request(
      `${testOrigins.development}/api/agent/v1/tasks`,
      { method: 'POST', headers, body: '{}' },
      credentialsEnv('read_write'),
    );
    expect(response.status).not.toBe(403);
  });
});
