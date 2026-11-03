import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import type { TaskIdentity } from '../src/app-env';
import { signSession } from '../src/auth/session';
import type { Env } from '../src/env';
import { requireTasksSession } from '../src/identity/context';
import { SessionIdentityProvider } from '../src/identity/session';
import { requireTasksSession as compatibilityRequireTasksSession } from '../src/tasks/api';

type User = { id: number; email: string; status: string };

function identityEnv(input: {
  user: User;
  directPermissions: readonly string[];
  availablePermissions?: readonly string[];
  failPermissions?: boolean;
  actor?: { user: User; directPermissions: readonly string[] };
}) {
  const availablePermissions = input.availablePermissions ?? [
    'platform.admin',
    'tasks.comment',
    'tasks.manage',
    'tasks.personal',
    'tasks.view',
  ];
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
        return statement;
      },
      async first() {
        if (sql.includes('FROM users WHERE id = ?')) {
          if (input.actor && Number(values[0]) === input.actor.user.id) return input.actor.user;
          return Number(values[0]) === input.user.id ? input.user : null;
        }
        throw new Error(`Unexpected identity first query: ${sql}`);
      },
      async all() {
        if (!sql.includes('FROM permissions p')) {
          throw new Error(`Unexpected identity all query: ${sql}`);
        }
        if (input.failPermissions) throw new Error('Permission database unavailable.');
        const direct =
          input.actor && Number(values[0]) === input.actor.user.id
            ? input.actor.directPermissions
            : input.directPermissions;
        const expanded = direct.includes('platform.admin') ? availablePermissions : direct;
        return {
          results: availablePermissions
            .filter((permission) => expanded.includes(permission))
            .sort()
            .map((permission_key) => ({ permission_key })),
        };
      },
    };
    return statement;
  };
  return {
    DB: { prepare },
    SESSION_SECRET: 'session-identity-characterization-secret',
  } as unknown as Env;
}

describe('Session identity provider', () => {
  it('authorizes browser sessions from fresh D1 permissions instead of JWT claims', async () => {
    const user = { id: 7, email: 'person@example.org', status: 'active' };
    const env = identityEnv({ user, directPermissions: ['tasks.personal'] });
    const token = await signSession(env, user, ['tasks.manage']);
    const provider = new SessionIdentityProvider(env);

    const taskView = await provider.resolve({ kind: 'browser', token, permission: 'tasks.view' });
    expect(taskView?.permissions).toEqual(['tasks.personal']);
    expect(taskView?.taskIdentity.user).toEqual(user);

    const comment = await provider.resolve({
      kind: 'browser',
      token,
      permission: 'tasks.comment',
    });
    expect(comment).toBeNull();
  });

  it('expands a fresh platform administrator grant for authorization', async () => {
    const user = { id: 8, email: 'admin@example.org', status: 'active' };
    const env = identityEnv({ user, directPermissions: ['platform.admin'] });
    const token = await signSession(env, user, []);

    const resolved = await new SessionIdentityProvider(env).resolve({
      kind: 'browser',
      token,
      permission: 'tasks.manage',
    });
    expect(resolved?.permissions).toContain('tasks.manage');
    expect(resolved?.permissions).toContain('platform.admin');
  });

  it('keeps the impersonated user effective while attributing audit to the actor', async () => {
    const user = { id: 9, email: 'subject@example.org', status: 'active' };
    const actor = { id: 99, email: 'actor@example.org' };
    const env = identityEnv({
      user,
      directPermissions: ['tasks.view'],
      actor: {
        user: { ...actor, status: 'active' },
        directPermissions: ['tasks.view', 'tasks.manage'],
      },
    });
    const token = await signSession(env, user, ['stale.permission'], actor);

    const resolved = await new SessionIdentityProvider(env).resolve({
      kind: 'browser',
      token,
      permission: 'tasks.view',
    });
    expect(resolved?.principal).toMatchObject({
      reference: 'user:9',
      email: user.email,
    });
    expect(resolved?.delegatedBy).toMatchObject({
      reference: 'user:99',
      email: actor.email,
    });
    expect(resolved?.taskIdentity.auditUserId).toBe(actor.id);
    expect(resolved?.taskIdentity.user.id).toBe(user.id);
  });

  it('maps the trusted Agent to an agent principal using fresh permissions', async () => {
    const user = { id: 10, email: tenantProfile.agent.email, status: 'active' };
    const env = identityEnv({ user, directPermissions: ['tasks.view'] });
    const taskIdentity = {
      session: {
        sub: String(user.id),
        email: user.email,
        perms: [],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      user,
      auditUserId: user.id,
    } satisfies TaskIdentity;

    const resolved = await new SessionIdentityProvider(env).resolve({
      kind: 'trusted',
      identity: taskIdentity,
      permission: 'tasks.view',
    });
    expect(resolved?.principal.kind).toBe('agent');
    expect(resolved?.permissions).toEqual(['tasks.view']);
    expect(resolved?.taskIdentity).toBe(taskIdentity);
  });

  it('keeps trusted failures visible but browser evidence private', async () => {
    const user = { id: 11, email: tenantProfile.agent.email, status: 'active' };
    const env = identityEnv({
      user,
      directPermissions: ['tasks.view'],
      failPermissions: true,
    });
    const provider = new SessionIdentityProvider(env);
    const taskIdentity = {
      session: {
        sub: String(user.id),
        email: user.email,
        perms: ['tasks.view'],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      user,
      auditUserId: user.id,
    } satisfies TaskIdentity;

    await expect(
      provider.resolve({ kind: 'trusted', identity: taskIdentity, permission: 'tasks.view' }),
    ).rejects.toThrow('Permission database unavailable');

    const token = await signSession(env, user, ['tasks.view']);
    await expect(
      provider.resolve({ kind: 'browser', token, permission: 'tasks.view' }),
    ).resolves.toBeNull();
  });

  it('retains the task API compatibility export during extraction', () => {
    expect(compatibilityRequireTasksSession).toBe(requireTasksSession);
  });
});
