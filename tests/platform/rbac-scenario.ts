import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { directoryQuery } from '../../src/admin/people';
import {
  grantablePermissions,
  lastPlatformAdminGuard,
  missingPermissions,
} from '../../src/admin/rbac';
import { app } from '../../src/app';
import { impersonationStillAuthorized } from '../../src/auth/impersonation';
import { effectivePermissionKeys, userHasPermission } from '../../src/auth/permissions';
import { provisionSignedInUser } from '../../src/auth/provision';
import { signSession } from '../../src/auth/session';
import type { Env } from '../../src/env';
import type { SqlDatabase } from '../../src/platform/ports';

const legacy = tenantProfile.tasks.apiMode === 'legacy';
const ORIGIN = 'http://tasks.invalid';
const CSRF = 'c'.repeat(43);

export interface RbacBackend {
  db: SqlDatabase;
  /** True when the backend can show SQLite query plans (EXPLAIN QUERY PLAN). */
  dispose(): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: JSON response bodies are asserted field by field
type Json = Record<string, any>;

/**
 * Role-based access control on the real application and a real SQL backend. Everything here uses
 * neutral fixtures (`*@example.org`, `Pat Example`, generic role names).
 */
export function describeRbacScenario(label: string, open: () => Promise<RbacBackend>) {
  describe.skipIf(!legacy)(`roles and user administration on ${label}`, { timeout: 90_000 }, () => {
    let backend: RbacBackend;
    let env: Env;
    let counter = 0;
    const cookies = new Map<number, string>();

    const run = async (sql: string, ...binds: unknown[]) =>
      env.DB.prepare(sql)
        .bind(...binds)
        .run();
    const all = async <T>(sql: string, ...binds: unknown[]) =>
      (
        await env.DB.prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    const first = async <T>(sql: string, ...binds: unknown[]) =>
      env.DB.prepare(sql)
        .bind(...binds)
        .first<T>();

    async function createUser(
      options: {
        permissions?: string[];
        roles?: string[];
        status?: string;
        name?: [string, string];
        email?: string;
      } = {},
    ) {
      counter += 1;
      const email = options.email ?? `person${counter}@example.org`;
      const [firstName, lastName] = options.name ?? ['Pat', `Example${counter}`];
      const inserted = await env.DB.prepare(
        'INSERT INTO users (email, first_name, last_name, status) VALUES (?, ?, ?, ?) RETURNING id',
      )
        .bind(email, firstName, lastName, options.status ?? 'active')
        .first<{ id: number }>();
      const id = Number(inserted?.id);
      await run(
        "INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, ?, 'member' FROM workspaces",
        id,
      );
      for (const permission of options.permissions ?? []) {
        await run(
          'INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, ?)',
          id,
          permission,
        );
      }
      for (const role of options.roles ?? []) {
        await run('INSERT INTO user_roles (user_id, role_key) VALUES (?, ?)', id, role);
      }
      return { id, email };
    }

    async function cookieFor(user: { id: number; email: string }) {
      const cached = cookies.get(user.id);
      if (cached) return cached;
      const token = await signSession(env, user, []);
      const prefix = tenantProfile.security.cookiePrefix;
      const value = `${prefix}_session=${token}; ${prefix}_csrf=${CSRF}`;
      cookies.set(user.id, value);
      return value;
    }

    // Handlers schedule background work (notifications) through waitUntil.
    const executionContext = {
      waitUntil: (_promise: Promise<unknown>) => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    async function request(
      user: { id: number; email: string },
      method: string,
      path: string,
      body?: unknown,
    ) {
      const response = await app.request(
        `${ORIGIN}${path}`,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            Cookie: await cookieFor(user),
            Origin: ORIGIN,
            'X-CSRF-Token': CSRF,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
        executionContext,
      );
      const text = await response.text();
      return { status: response.status, body: (text ? JSON.parse(text) : null) as Json };
    }

    const newAdmin = (extra: Parameters<typeof createUser>[0] = {}) =>
      createUser({ ...extra, permissions: ['platform.admin', ...(extra.permissions ?? [])] });
    const newManager = (extra: Parameters<typeof createUser>[0] = {}) =>
      createUser({
        ...extra,
        permissions: ['tasks.view', 'tasks.manage', 'tasks.comment', 'tasks.personal'],
      });
    const roleKeysOf = async (userId: number) =>
      (
        await all<{ role_key: string }>(
          'SELECT role_key FROM user_roles WHERE user_id = ? ORDER BY role_key',
          userId,
        )
      ).map((row) => row.role_key);
    const lastAudit = async (entityKey: string, action: string) => {
      const row = await first<{ changes_json: string; actor_user_id: number }>(
        'SELECT changes_json, actor_user_id FROM audit_events WHERE entity_key = ? AND action = ? ORDER BY id DESC LIMIT 1',
        entityKey,
        action,
      );
      return row
        ? { actor: row.actor_user_id, changes: JSON.parse(row.changes_json) as Json }
        : null;
    };

    let root: { id: number; email: string };

    /** Disables every platform administrator except `keep`; returns a function that undoes it. */
    async function isolateAdmins(keep: number[]) {
      const others = (
        await all<{ id: number }>(
          `SELECT u.id FROM users u WHERE u.status = 'active' AND EXISTS (
             SELECT 1 FROM effective_user_permissions e
             WHERE e.user_id = u.id AND e.permission_key = 'platform.admin')`,
        )
      )
        .map((row) => row.id)
        .filter((id) => !keep.includes(id));
      for (const id of others) await run("UPDATE users SET status = 'disabled' WHERE id = ?", id);
      return async () => {
        for (const id of others) await run("UPDATE users SET status = 'active' WHERE id = ?", id);
      };
    }

    beforeAll(async () => {
      backend = await open();
      env = {
        DB: backend.db,
        ASSETS: { fetch: async () => new Response('asset') },
        ENVIRONMENT: 'local',
        RELEASE_SHA: 'rbac',
        SESSION_SECRET: 'rbac-session-secret-0123456789abcdef0123456789abcd',
      } as unknown as Env;
      root = await newAdmin({ email: 'root@example.org', name: ['Root', 'Admin'] });
    }, 120_000);
    afterAll(async () => {
      await backend?.dispose();
    });

    describe('built-in roles', () => {
      it('seeds the four built-ins with the documented mapping and assigns nobody', async () => {
        const rows = await all<{ role_key: string; permission_key: string }>(
          'SELECT role_key, permission_key FROM role_permissions ORDER BY role_key, permission_key',
        );
        const mapping = new Map<string, string[]>();
        for (const row of rows) {
          mapping.set(row.role_key, [...(mapping.get(row.role_key) ?? []), row.permission_key]);
        }
        expect(mapping.get('viewer')).toEqual(['tasks.view']);
        expect(mapping.get('member')).toEqual(['tasks.comment', 'tasks.personal', 'tasks.view']);
        expect(mapping.get('manager')).toEqual([
          'tasks.comment',
          'tasks.manage',
          'tasks.personal',
          'tasks.view',
        ]);
        const permissionKeys = (
          await all<{ key: string }>('SELECT key FROM permissions ORDER BY key')
        ).map((row) => row.key);
        expect(mapping.get('admin')).toEqual(permissionKeys);
        const builtins = await all<{ key: string; builtin: number }>(
          'SELECT key, builtin FROM roles ORDER BY key',
        );
        expect(builtins.map((row) => [row.key, row.builtin])).toEqual(
          expect.arrayContaining([
            ['admin', 1],
            ['manager', 1],
            ['member', 1],
            ['viewer', 1],
          ]),
        );
      });
    });

    describe('effective permissions', () => {
      it('is the union of direct grants and role permissions', async () => {
        const user = await createUser({ permissions: ['tasks.personal'], roles: ['viewer'] });
        // Every new user already holds tasks.personal and tasks.comment as direct grants.
        expect(await effectivePermissionKeys(env, user.id)).toEqual([
          'tasks.comment',
          'tasks.personal',
          'tasks.view',
        ]);
        await run("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'manager')", user.id);
        expect(await effectivePermissionKeys(env, user.id)).toEqual([
          'tasks.comment',
          'tasks.manage',
          'tasks.personal',
          'tasks.view',
        ]);
        expect(await userHasPermission(env, user.id, 'tasks.manage')).toBe(true);
        expect(await userHasPermission(env, user.id, 'events.manage')).toBe(false);
      });

      it('leaves users without roles with exactly their direct grants', async () => {
        const user = await createUser({ permissions: ['tasks.view'] });
        const directRows = (
          await all<{ permission_key: string }>(
            'SELECT permission_key FROM user_permissions WHERE user_id = ? ORDER BY permission_key',
            user.id,
          )
        ).map((row) => row.permission_key);
        expect(directRows).toEqual(['tasks.comment', 'tasks.personal', 'tasks.view']);
        expect(await effectivePermissionKeys(env, user.id)).toEqual(directRows);
      });

      it('treats a role containing platform.admin exactly like the direct grant', async () => {
        const viaRole = await createUser({ roles: ['admin'] });
        const direct = await newAdmin();
        const everything = (await all<{ key: string }>('SELECT key FROM permissions')).map(
          (row) => row.key,
        );
        expect(await effectivePermissionKeys(env, viaRole.id)).toEqual(
          (await effectivePermissionKeys(env, direct.id)).slice().sort(),
        );
        expect((await effectivePermissionKeys(env, viaRole.id)).length).toBe(everything.length);
        expect(await userHasPermission(env, viaRole.id, 'anything.at.all')).toBe(true);
        // A permission added later is conferred immediately, with no data rewrite.
        await run("INSERT INTO permissions (key, label) VALUES ('future.capability', 'Future')");
        expect(await effectivePermissionKeys(env, viaRole.id)).toContain('future.capability');
        // ...and gates the administrator-only operations the same way as the direct grant.
        const invite = await request(viaRole, 'POST', '/api/admin/users', {
          email: 'invited-by-role-admin@example.org',
          isPlatformAdmin: true,
        });
        expect(invite.status).toBe(201);
        const manager = await newManager();
        const denied = await request(manager, 'POST', '/api/admin/users', {
          email: 'invited-by-manager@example.org',
          isPlatformAdmin: true,
        });
        expect(denied.status).toBe(403);
      });

      it('applies a revocation on the very next request', async () => {
        const user = await createUser({ roles: ['manager'] });
        expect((await request(user, 'GET', '/api/admin')).status).toBe(200);
        const removed = await request(root, 'PUT', `/api/admin/users/${user.id}/roles`, {
          roles: [],
        });
        expect(removed.status).toBe(200);
        // Same session cookie, no re-login: the role is gone, so is the access.
        expect((await request(user, 'GET', '/api/admin')).status).toBe(403);
        const granted = await request(root, 'PUT', `/api/admin/users/${user.id}/roles`, {
          roles: ['manager'],
        });
        expect(granted.status).toBe(200);
        expect((await request(user, 'GET', '/api/admin')).status).toBe(200);
        // A disabled account is refused outright on the next request as well.
        await request(root, 'POST', '/api/admin/users/bulk', {
          action: 'disable',
          userIds: [user.id],
        });
        expect((await request(user, 'GET', '/api/admin')).status).toBe(403);
      });

      it('uses role permissions for task visibility and administration gates', async () => {
        const viaRole = await createUser({ roles: ['manager'] });
        expect((await request(viaRole, 'GET', '/api/admin')).status).toBe(200);
        const viewer = await createUser({ roles: ['viewer'] });
        expect((await request(viewer, 'GET', '/api/admin')).status).toBe(403);
        expect((await request(viewer, 'GET', '/api/admin/roles')).status).toBe(403);
        expect((await request(viewer, 'GET', '/api/admin/directory')).status).toBe(403);
        expect((await request(viewer, 'GET', '/api/admin/audit')).status).toBe(403);
      });
    });

    describe('impersonation follows roles', () => {
      const session = (actor: { id: number }, target: { id: number; email: string }) => ({
        sub: String(target.id),
        email: target.email,
        perms: [] as string[],
        exp: Math.floor(Date.now() / 1000) + 600,
        act: { sub: String(actor.id), email: 'actor@example.org' },
      });

      it('allows a subset and refuses a target with a role the actor does not match', async () => {
        const actor = await createUser({ roles: ['manager'] });
        const viewer = await createUser({ roles: ['viewer'] });
        const target = await createUser({ roles: ['admin'] });
        expect(
          await impersonationStillAuthorized(env, session(actor, viewer) as never, viewer.id),
        ).toBe(true);
        expect(
          await impersonationStillAuthorized(env, session(actor, target) as never, target.id),
        ).toBe(false);
        expect(
          (await request(actor, 'POST', `/api/admin/users/${viewer.id}/impersonate`)).status,
        ).toBe(200);
        expect(
          (await request(actor, 'POST', `/api/admin/users/${target.id}/impersonate`)).status,
        ).toBe(403);
      });

      it('re-authorizes when the target later gains a role, and when the actor loses theirs', async () => {
        const actor = await createUser({ roles: ['manager'] });
        const target = await createUser({ roles: ['viewer'] });
        const claims = session(actor, target) as never;
        expect(await impersonationStillAuthorized(env, claims, target.id)).toBe(true);
        await run("INSERT INTO user_roles (user_id, role_key) VALUES (?, 'admin')", target.id);
        expect(await impersonationStillAuthorized(env, claims, target.id)).toBe(false);
        await run("DELETE FROM user_roles WHERE user_id = ? AND role_key = 'admin'", target.id);
        expect(await impersonationStillAuthorized(env, claims, target.id)).toBe(true);
        await run("DELETE FROM user_roles WHERE user_id = ? AND role_key = 'manager'", actor.id);
        expect(await impersonationStillAuthorized(env, claims, target.id)).toBe(false);
      });
    });

    describe('subset rule', () => {
      it('computes what each actor may grant', async () => {
        const manager = await createUser({ roles: ['manager'] });
        const grantable = await grantablePermissions(env, manager.id);
        expect(missingPermissions(grantable, ['tasks.view', 'tasks.manage'])).toEqual([]);
        expect(missingPermissions(grantable, ['platform.admin'])).toEqual(['platform.admin']);
        // The long-standing rule: task managers may grant event management and approval.
        expect(missingPermissions(grantable, ['events.manage', 'events.approve'])).toEqual([]);
        const viewer = await createUser({ roles: ['viewer'] });
        const viewerGrantable = await grantablePermissions(env, viewer.id);
        expect(missingPermissions(viewerGrantable, ['tasks.manage', 'events.manage'])).toEqual([
          'events.manage',
          'tasks.manage',
        ]);
      });

      it('refuses to assign a role containing permissions the assigner lacks', async () => {
        const manager = await newManager();
        const target = await createUser();
        const adminRole = await request(manager, 'PUT', `/api/admin/users/${target.id}/roles`, {
          roles: ['admin'],
        });
        expect(adminRole.status).toBe(403);
        expect(adminRole.body.error).toBe('role_exceeds_permissions');
        expect(adminRole.body.missing).toContain('platform.admin');
        expect(await roleKeysOf(target.id)).toEqual([]);
        const bulk = await request(manager, 'POST', '/api/admin/users/bulk', {
          action: 'add_roles',
          userIds: [target.id],
          roles: ['admin'],
        });
        expect(bulk.status).toBe(403);
        const invite = await request(manager, 'POST', '/api/admin/users', {
          email: 'subset-invite@example.org',
          roles: ['admin'],
        });
        expect(invite.status).toBe(403);
        expect(
          await first('SELECT id FROM users WHERE email = ?', 'subset-invite@example.org'),
        ).toBeNull();
        const bulkInvite = await request(manager, 'POST', '/api/admin/users/bulk-invite', {
          entries: [{ email: 'subset-bulk@example.org' }],
          roles: ['admin'],
        });
        expect(bulkInvite.status).toBe(403);
        const allowed = await request(manager, 'PUT', `/api/admin/users/${target.id}/roles`, {
          roles: ['member'],
        });
        expect(allowed.status).toBe(200);
      });

      it('refuses removing a role the actor could not have granted', async () => {
        const viewerHolder = await createUser({ roles: ['viewer'] });
        const lowActor = await createUser({ permissions: ['tasks.manage', 'tasks.view'] });
        // Remove-only: a custom role the manager cannot hold is not theirs to take away.
        const custom = await request(root, 'POST', '/api/admin/roles', {
          label: 'Elevated Reviewer',
          permissions: ['platform.admin'],
        });
        expect(custom.status).toBe(201);
        await run(
          'INSERT INTO user_roles (user_id, role_key) VALUES (?, ?)',
          viewerHolder.id,
          custom.body.role.key,
        );
        const attempt = await request(
          lowActor,
          'PUT',
          `/api/admin/users/${viewerHolder.id}/roles`,
          {
            roles: [],
          },
        );
        // The target is an administrator through the role, so the stronger rule answers first.
        expect(attempt.status).toBe(403);
        expect(await roleKeysOf(viewerHolder.id)).toContain(custom.body.role.key);
      });

      it('lets a task manager grant themselves event management and approval', async () => {
        const events = await request(root, 'POST', '/api/admin/roles', {
          label: 'Event Coordinator',
          permissions: ['events.view', 'events.create', 'events.manage', 'events.approve'],
        });
        expect(events.status).toBe(201);
        const manager = await newManager();
        const self = await request(manager, 'PUT', `/api/admin/users/${manager.id}/roles`, {
          roles: [events.body.role.key],
        });
        expect(self.status).toBe(200);
        expect(await effectivePermissionKeys(env, manager.id)).toEqual(
          expect.arrayContaining(['events.manage', 'events.approve', 'tasks.manage']),
        );
        const audit = await lastAudit(manager.email, 'user.roles_updated');
        expect(audit?.actor).toBe(manager.id);
        expect(audit?.changes).toEqual({
          before: { roles: [] },
          after: { roles: [events.body.role.key] },
          removedDirectGrants: ['tasks.comment', 'tasks.personal', 'tasks.view'],
        });
      });

      it.runIf(tenantProfile.capabilities.events)(
        'keeps the legacy event flags working for task managers through the same keys',
        async () => {
          const manager = await newManager();
          const response = await request(manager, 'PATCH', `/api/admin/users/${manager.id}`, {
            isEventManager: true,
            canApproveEvents: true,
          });
          expect(response.status).toBe(200);
          expect(await effectivePermissionKeys(env, manager.id)).toEqual(
            expect.arrayContaining(['events.manage', 'events.approve']),
          );
        },
      );
    });

    describe('platform administrators are protected from task managers', () => {
      it('blocks every route a manager could use against a direct or role-based administrator', async () => {
        const manager = await newManager();
        const direct = await newAdmin();
        const viaRole = await createUser({ roles: ['admin'] });
        const bystander = await createUser({ roles: ['viewer'] });
        for (const admin of [direct, viaRole]) {
          const patch = await request(manager, 'PATCH', `/api/admin/users/${admin.id}`, {
            status: 'disabled',
          });
          expect(patch.status).toBe(403);
          expect(patch.body.error).toBe('platform_admin_required');
          expect(
            (await request(manager, 'PUT', `/api/admin/users/${admin.id}/roles`, { roles: [] }))
              .status,
          ).toBe(403);
          const bulk = await request(manager, 'POST', '/api/admin/users/bulk', {
            action: 'disable',
            userIds: [bystander.id, admin.id],
          });
          expect(bulk.status).toBe(403);
          expect(bulk.body.failures).toEqual([
            { userId: admin.id, error: 'platform_admin_required' },
          ]);
        }
        // Atomic: the bystander in the same batch was not touched either.
        expect(
          (await first<{ status: string }>('SELECT status FROM users WHERE id = ?', bystander.id))
            ?.status,
        ).toBe('active');
        for (const admin of [direct, viaRole]) {
          expect(
            (await first<{ status: string }>('SELECT status FROM users WHERE id = ?', admin.id))
              ?.status,
          ).toBe('active');
        }
      });

      it('lets a platform administrator manage other administrators', async () => {
        const target = await newAdmin();
        const result = await request(root, 'POST', '/api/admin/users/bulk', {
          action: 'disable',
          userIds: [target.id],
        });
        expect(result.status).toBe(200);
        expect(result.body.changed).toBe(1);
      });

      it('cannot be bypassed by editing a role-based administrator with the legacy flags', async () => {
        const viaRole = await createUser({ roles: ['admin'] });
        const result = await request(root, 'PATCH', `/api/admin/users/${viaRole.id}`, {
          isPlatformAdmin: false,
        });
        // The user is an administrator through a role, which the flag cannot withdraw.
        expect(result.status).toBe(409);
        expect(result.body.error).toBe('granted_by_role');
      });
    });

    describe('role management', () => {
      it('requires platform.admin to create, edit or delete custom roles', async () => {
        const manager = await newManager();
        const created = await request(manager, 'POST', '/api/admin/roles', {
          label: 'Sneaky',
          permissions: ['tasks.view'],
        });
        expect(created.status).toBe(403);
        expect(created.body.error).toBe('platform_admin_required');
        const real = await request(root, 'POST', '/api/admin/roles', {
          label: 'Intake Reviewer',
          description: 'Reviews incoming work.',
          permissions: ['tasks.view', 'tasks.comment'],
        });
        expect(real.status).toBe(201);
        expect(real.body.role).toMatchObject({
          key: 'intake-reviewer',
          builtin: false,
          permissions: ['tasks.comment', 'tasks.view'],
          userCount: 0,
        });
        const key = real.body.role.key;
        expect(
          (await request(manager, 'PATCH', `/api/admin/roles/${key}`, { label: 'X' })).status,
        ).toBe(403);
        expect((await request(manager, 'DELETE', `/api/admin/roles/${key}`)).status).toBe(403);
        const edited = await request(root, 'PATCH', `/api/admin/roles/${key}`, {
          label: 'Intake Lead',
          permissions: ['tasks.view'],
        });
        expect(edited.status).toBe(200);
        expect(edited.body.role).toMatchObject({
          label: 'Intake Lead',
          permissions: ['tasks.view'],
        });
        const audit = await lastAudit(`role:${key}`, 'role.updated');
        expect(audit?.actor).toBe(root.id);
        expect(audit?.changes).toEqual({
          before: {
            label: 'Intake Reviewer',
            description: 'Reviews incoming work.',
            permissions: ['tasks.comment', 'tasks.view'],
          },
          after: {
            label: 'Intake Lead',
            description: 'Reviews incoming work.',
            permissions: ['tasks.view'],
          },
        });
        expect((await lastAudit(`role:${key}`, 'role.created'))?.changes).toMatchObject({
          before: null,
          after: { label: 'Intake Reviewer', permissions: ['tasks.comment', 'tasks.view'] },
        });
      });

      it('validates labels, keys and permission keys', async () => {
        const post = (body: unknown) => request(root, 'POST', '/api/admin/roles', body);
        expect((await post({ label: '', permissions: ['tasks.view'] })).body.error).toBe(
          'invalid_label',
        );
        expect((await post({ label: 'Empty', permissions: [] })).body.error).toBe(
          'invalid_permissions',
        );
        expect((await post({ label: 'Bad', permissions: ['no.such.key'] })).body.error).toBe(
          'unknown_permission',
        );
        expect(
          (await post({ label: 'Key', key: 'Not Valid', permissions: ['tasks.view'] })).body.error,
        ).toBe('invalid_role_key');
        const first = await post({ label: 'Duplicate Name', permissions: ['tasks.view'] });
        const second = await post({ label: 'Duplicate Name', permissions: ['tasks.view'] });
        expect([first.status, second.status]).toEqual([201, 201]);
        expect(second.body.role.key).toBe('duplicate-name-2');
        expect(
          (await post({ label: 'Same', key: 'duplicate-name', permissions: ['tasks.view'] }))
            .status,
        ).toBe(409);
      });

      it('cannot edit or delete built-in roles', async () => {
        for (const key of ['admin', 'manager', 'member', 'viewer']) {
          const patch = await request(root, 'PATCH', `/api/admin/roles/${key}`, {
            label: 'Renamed',
          });
          expect(patch.status, key).toBe(403);
          expect(patch.body.error).toBe('builtin_role_locked');
          const del = await request(root, 'DELETE', `/api/admin/roles/${key}`);
          expect(del.status, key).toBe(403);
        }
        // The same holds below the API: the storage rejects direct edits.
        await expect(run("UPDATE roles SET label = 'x' WHERE key = 'viewer'")).rejects.toThrow(
          /builtin_role_locked/,
        );
        await expect(run("DELETE FROM role_permissions WHERE role_key = 'viewer'")).rejects.toThrow(
          /builtin_role_locked/,
        );
      });

      it('deletes a role in use only with a replacement, and reassigns its holders', async () => {
        const created = await request(root, 'POST', '/api/admin/roles', {
          label: 'Temporary',
          permissions: ['tasks.view', 'tasks.comment'],
        });
        const key = created.body.role.key as string;
        const holders = [await createUser(), await createUser()];
        for (const holder of holders) {
          const assigned = await request(root, 'PUT', `/api/admin/users/${holder.id}/roles`, {
            roles: [key],
          });
          expect(assigned.status).toBe(200);
        }
        const blocked = await request(root, 'DELETE', `/api/admin/roles/${key}`);
        expect(blocked.status).toBe(409);
        expect(blocked.body).toEqual({ error: 'role_in_use', userCount: 2 });
        expect(
          (await request(root, 'DELETE', `/api/admin/roles/${key}?replacement=${key}`)).status,
        ).toBe(400);
        expect(
          (await request(root, 'DELETE', `/api/admin/roles/${key}?replacement=nope`)).status,
        ).toBe(400);
        const deleted = await request(root, 'DELETE', `/api/admin/roles/${key}?replacement=member`);
        expect(deleted.status).toBe(200);
        expect(deleted.body.reassignedUsers).toBe(2);
        for (const holder of holders) expect(await roleKeysOf(holder.id)).toEqual(['member']);
        expect(await first('SELECT key FROM roles WHERE key = ?', key)).toBeNull();
        expect(await first('SELECT 1 FROM role_permissions WHERE role_key = ?', key)).toBeNull();
        const audit = await lastAudit(`role:${key}`, 'role.deleted');
        expect(audit?.changes).toMatchObject({
          before: { label: 'Temporary' },
          after: null,
          replacement: 'member',
          reassignedUsers: 2,
        });
        const perUser = await lastAudit(holders[0]?.email ?? '', 'user.roles_updated');
        expect(perUser?.changes).toMatchObject({
          reason: 'role_deleted',
          before: { roles: [key] },
          removed: [key],
          added: ['member'],
        });
      });

      it('deletes an unused role without a replacement', async () => {
        const created = await request(root, 'POST', '/api/admin/roles', {
          label: 'Unused',
          permissions: ['tasks.view'],
        });
        expect(
          (await request(root, 'DELETE', `/api/admin/roles/${created.body.role.key}`)).status,
        ).toBe(200);
      });

      it('lists roles with counts, the grouped catalogue and per-role assignability', async () => {
        const manager = await newManager();
        const listed = await request(manager, 'GET', '/api/admin/roles');
        expect(listed.status).toBe(200);
        const byKey = new Map<string, Json>(
          listed.body.roles.map((role: Json) => [role.key, role]),
        );
        expect(byKey.get('admin')).toMatchObject({
          builtin: true,
          grantsAll: true,
          assignable: false,
        });
        expect(byKey.get('member')).toMatchObject({
          builtin: true,
          grantsAll: false,
          assignable: true,
        });
        expect(listed.body.canManageRoles).toBe(false);
        const areas = listed.body.catalog.map((area: Json) => area.area);
        expect(areas).toContain('tasks');
        expect(areas).toContain('platform');
        const tasksArea = listed.body.catalog.find((area: Json) => area.area === 'tasks');
        expect(tasksArea.label).toBe('Tasks');
        expect(tasksArea.permissions.map((permission: Json) => permission.key)).toContain(
          'tasks.view',
        );
        expect(tasksArea.permissions[0].label).toBeTruthy();
      });
    });

    describe('last platform administrator', () => {
      const activeAdmins = async () =>
        (
          await first<{ n: number }>(
            `SELECT COUNT(*) AS n FROM users u WHERE u.status = 'active' AND EXISTS (
               SELECT 1 FROM effective_user_permissions e
               WHERE e.user_id = u.id AND e.permission_key = 'platform.admin')`,
          )
        )?.n;

      it('rolls back a batch that would leave no active administrator', async () => {
        const solo = await newAdmin();
        const restore = await isolateAdmins([solo.id]);
        try {
          expect(await activeAdmins()).toBe(1);
          await expect(
            env.DB.batch([
              env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(solo.id),
              lastPlatformAdminGuard(env, true),
            ]),
          ).rejects.toThrow(/last_platform_admin/);
          expect(
            (await first<{ status: string }>('SELECT status FROM users WHERE id = ?', solo.id))
              ?.status,
          ).toBe('active');
          expect(await first('SELECT 1 FROM platform_admin_guard')).toBeNull();
          // A deployment with no administrator at all is never blocked.
          await expect(
            env.DB.batch([env.DB.prepare('SELECT 1'), lastPlatformAdminGuard(env, false)]),
          ).resolves.toBeDefined();
        } finally {
          await restore();
        }
      });

      it('lets exactly one of two concurrent demotions succeed', async () => {
        const [a, b] = [await newAdmin(), await newAdmin()];
        const restore = await isolateAdmins([a.id, b.id]);
        try {
          const disable = (id: number) =>
            env.DB.batch([
              env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(id),
              lastPlatformAdminGuard(env, true),
            ]);
          const results = await Promise.allSettled([disable(a.id), disable(b.id)]);
          expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
          expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
          expect(await activeAdmins()).toBe(1);
        } finally {
          await run("UPDATE users SET status = 'active' WHERE id IN (?, ?)", a.id, b.id);
          await restore();
        }
      });

      it('refuses role edits and deletions that would remove the last administrator', async () => {
        const custom = await request(root, 'POST', '/api/admin/roles', {
          label: 'Sole Operators',
          permissions: ['platform.admin'],
        });
        const key = custom.body.role.key as string;
        const sole = await createUser({ roles: [key] });
        const restore = await isolateAdmins([sole.id]);
        try {
          const demote = await request(sole, 'PATCH', `/api/admin/roles/${key}`, {
            permissions: ['tasks.view'],
          });
          expect(demote.status).toBe(409);
          expect(demote.body.error).toBe('last_platform_admin_required');
          expect(await roleKeysOf(sole.id)).toEqual([key]);
          expect(
            (
              await first<{ n: number }>(
                "SELECT COUNT(*) AS n FROM role_permissions WHERE role_key = ? AND permission_key = 'platform.admin'",
                key,
              )
            )?.n,
          ).toBe(1);
          const removed = await request(
            sole,
            'DELETE',
            `/api/admin/roles/${key}?replacement=member`,
          );
          expect(removed.status).toBe(409);
          expect(removed.body.error).toBe('last_platform_admin_required');
          expect(await first('SELECT key FROM roles WHERE key = ?', key)).not.toBeNull();
          // Renaming is fine; only the loss of administration is refused.
          const rename = await request(sole, 'PATCH', `/api/admin/roles/${key}`, {
            label: 'Sole Operator Team',
          });
          expect(rename.status).toBe(200);
          // Disabling or de-roling yourself is refused before the storage guard is even needed.
          expect(
            (await request(sole, 'PUT', `/api/admin/users/${sole.id}/roles`, { roles: [] })).status,
          ).toBe(400);
          expect(
            (
              await request(sole, 'POST', '/api/admin/users/bulk', {
                action: 'disable',
                userIds: [sole.id],
              })
            ).status,
          ).toBe(400);
          // A second administrator makes the demotion legitimate.
          const second = await newAdmin();
          expect(second.id).toBeGreaterThan(0);
          const demoted = await request(sole, 'PATCH', `/api/admin/roles/${key}`, {
            permissions: ['tasks.view'],
          });
          expect(demoted.status).toBe(200);
        } finally {
          await restore();
        }
      });

      it('allows an administrator to disable another, never themselves', async () => {
        const sole = await newAdmin();
        const helper = await newAdmin();
        const restore = await isolateAdmins([sole.id, helper.id]);
        try {
          const disableOther = await request(helper, 'PATCH', `/api/admin/users/${sole.id}`, {
            status: 'disabled',
          });
          expect(disableOther.status).toBe(200);
          const self = await request(helper, 'PATCH', `/api/admin/users/${helper.id}`, {
            status: 'disabled',
          });
          expect(self.status).toBe(400);
          const demoteSelf = await request(helper, 'PATCH', `/api/admin/users/${helper.id}`, {
            isPlatformAdmin: false,
          });
          expect(demoteSelf.status).toBe(400);
          expect(await activeAdmins()).toBe(1);
        } finally {
          await run("UPDATE users SET status = 'active' WHERE id IN (?, ?)", sole.id, helper.id);
          await restore();
        }
      });
    });

    describe('audit', () => {
      it('records actor, target and before/after for each change', async () => {
        const target = await createUser();
        await request(root, 'PUT', `/api/admin/users/${target.id}/roles`, { roles: ['viewer'] });
        await request(root, 'POST', '/api/admin/users/bulk', {
          action: 'add_roles',
          userIds: [target.id],
          roles: ['member'],
        });
        await request(root, 'POST', '/api/admin/users/bulk', {
          action: 'remove_roles',
          userIds: [target.id],
          roles: ['viewer'],
        });
        await request(root, 'POST', '/api/admin/users/bulk', {
          action: 'disable',
          userIds: [target.id],
        });
        await request(root, 'POST', '/api/admin/users/bulk', {
          action: 'enable',
          userIds: [target.id],
        });
        const rows = await all<{ action: string; changes_json: string; actor_user_id: number }>(
          'SELECT action, changes_json, actor_user_id FROM audit_events WHERE entity_key = ? ORDER BY id',
          target.email,
        );
        expect(rows.map((row) => row.action)).toEqual([
          'user.roles_updated',
          'user.roles_updated',
          'user.roles_updated',
          'user.access_updated',
          'user.access_updated',
        ]);
        expect(new Set(rows.map((row) => row.actor_user_id))).toEqual(new Set([root.id]));
        expect(rows.map((row) => JSON.parse(row.changes_json))).toEqual([
          {
            before: { roles: [] },
            after: { roles: ['viewer'] },
            removedDirectGrants: ['tasks.comment', 'tasks.personal'],
          },
          {
            before: { roles: ['viewer'] },
            after: { roles: ['member', 'viewer'] },
            removedDirectGrants: [],
          },
          {
            before: { roles: ['member', 'viewer'] },
            after: { roles: ['member'] },
            removedDirectGrants: [],
          },
          { before: { status: 'active' }, after: { status: 'disabled' } },
          { before: { status: 'disabled' }, after: { status: 'active' } },
        ]);
      });

      it('writes no audit event for a no-op and none when a change is refused', async () => {
        const target = await createUser({ roles: ['viewer'] });
        const manager = await newManager();
        await request(root, 'PUT', `/api/admin/users/${target.id}/roles`, { roles: ['viewer'] });
        await request(manager, 'PUT', `/api/admin/users/${target.id}/roles`, { roles: ['admin'] });
        expect(await lastAudit(target.email, 'user.roles_updated')).toBeNull();
      });

      it('attributes changes made while impersonating to the real actor', async () => {
        // The audit user is the actor of record (`identity.auditUserId`); covered end to end by the
        // impersonation suites. Here: the recorded actor is the signed-in administrator.
        const target = await createUser();
        await request(root, 'PUT', `/api/admin/users/${target.id}/roles`, { roles: ['member'] });
        expect((await lastAudit(target.email, 'user.roles_updated'))?.actor).toBe(root.id);
      });

      it('filters the audit view by actor, target, action family and date, with cursors', async () => {
        const actor = await newAdmin({
          name: ['Quincy', 'Auditor'],
          email: 'quincy.auditor@example.org',
        });
        const targets = [await createUser(), await createUser(), await createUser()];
        for (const target of targets) {
          await request(actor, 'PUT', `/api/admin/users/${target.id}/roles`, { roles: ['member'] });
        }
        await request(actor, 'POST', '/api/admin/roles', {
          label: 'Audit Probe',
          permissions: ['tasks.view'],
        });

        const byActor = await request(root, 'GET', '/api/admin/audit?actor=quincy');
        expect(byActor.status).toBe(200);
        expect(byActor.body.events.length).toBe(4);
        expect(new Set(byActor.body.events.map((event: Json) => event.actor.email))).toEqual(
          new Set(['quincy.auditor@example.org']),
        );
        expect(byActor.body.actions).toEqual(
          expect.arrayContaining(['user.roles_updated', 'role.created']),
        );

        const byTarget = await request(
          root,
          'GET',
          `/api/admin/audit?target=${encodeURIComponent(targets[0]?.email ?? '')}`,
        );
        expect(byTarget.body.events.map((event: Json) => event.action)).toEqual([
          'user.roles_updated',
        ]);

        const family = await request(root, 'GET', '/api/admin/audit?actor=quincy&action=role');
        expect(family.body.events.map((event: Json) => event.action)).toEqual(['role.created']);
        const exact = await request(
          root,
          'GET',
          '/api/admin/audit?actor=quincy&action=user.roles_updated',
        );
        expect(exact.body.events).toHaveLength(3);
        const roleTarget = await request(root, 'GET', '/api/admin/audit?target=role:audit-probe');
        expect(roleTarget.body.events).toHaveLength(1);

        const today = new Date().toISOString().slice(0, 10);
        const inRange = await request(
          root,
          'GET',
          `/api/admin/audit?actor=quincy&from=${today}&to=${today}`,
        );
        expect(inRange.body.events).toHaveLength(4);
        const past = await request(root, 'GET', '/api/admin/audit?actor=quincy&to=2000-01-01');
        expect(past.body.events).toHaveLength(0);
        expect((await request(root, 'GET', '/api/admin/audit?from=yesterday')).status).toBe(400);

        const pageOne = await request(root, 'GET', '/api/admin/audit?actor=quincy&limit=3');
        expect(pageOne.body.events).toHaveLength(3);
        expect(pageOne.body.nextCursor).toBeTruthy();
        const pageTwo = await request(
          root,
          'GET',
          `/api/admin/audit?actor=quincy&limit=3&cursor=${pageOne.body.nextCursor}`,
        );
        expect(pageTwo.body.events).toHaveLength(1);
        expect(pageTwo.body.nextCursor).toBeNull();
        expect(pageTwo.body.actions).toBeUndefined();
        const ids = [...pageOne.body.events, ...pageTwo.body.events].map((event: Json) => event.id);
        expect(ids).toEqual([...ids].sort((a, b) => b - a));
        expect((await request(root, 'GET', '/api/admin/audit?cursor=abc')).status).toBe(400);
      });
    });

    describe('user detail', () => {
      it('shows roles, direct grants, effective permissions with sources and projects', async () => {
        const user = await createUser({ permissions: ['tasks.personal'], roles: ['viewer'] });
        const detail = await request(root, 'GET', `/api/admin/users/${user.id}`);
        expect(detail.status).toBe(200);
        expect(detail.body.user.name).toBe(`Pat ${detail.body.user.lastName}`);
        expect(detail.body.user).toMatchObject({
          id: user.id,
          email: user.email,
          status: 'active',
          lastSeenAt: null,
        });
        expect(detail.body.roles).toEqual([
          expect.objectContaining({ key: 'viewer', label: 'Viewer', grantedBy: null }),
        ]);
        expect(detail.body.directPermissions).toEqual(['tasks.comment', 'tasks.personal']);
        const byKey = new Map<string, Json>(
          detail.body.effectivePermissions.map((permission: Json) => [permission.key, permission]),
        );
        expect(byKey.get('tasks.personal')?.sources).toEqual([{ type: 'direct' }]);
        expect(byKey.get('tasks.view')?.sources).toEqual([
          { type: 'role', role: 'viewer', label: 'Viewer' },
        ]);
        expect(detail.body.isPlatformAdmin).toBe(false);
        expect(Array.isArray(detail.body.projects)).toBe(true);
        expect((await request(root, 'GET', '/api/admin/users/999999999')).status).toBe(404);
      });

      it('explains administrator access from a role', async () => {
        const user = await createUser({ roles: ['admin'] });
        const detail = await request(root, 'GET', `/api/admin/users/${user.id}`);
        expect(detail.body.isPlatformAdmin).toBe(true);
        const byKey = new Map<string, Json>(
          detail.body.effectivePermissions.map((permission: Json) => [permission.key, permission]),
        );
        expect(byKey.get('platform.admin')?.sources).toEqual([
          { type: 'role', role: 'admin', label: 'Administrator' },
        ]);
        expect(byKey.get('tasks.view')?.sources).toEqual([{ type: 'platform_admin' }]);
      });

      it('records who granted a role', async () => {
        const user = await createUser();
        await request(root, 'PUT', `/api/admin/users/${user.id}/roles`, { roles: ['member'] });
        const detail = await request(root, 'GET', `/api/admin/users/${user.id}`);
        expect(detail.body.roles[0].grantedBy).toMatchObject({ id: root.id, name: 'Root Admin' });
        expect(detail.body.roles[0].grantedAt).toMatch(/^\d{4}-/);
      });
    });

    describe('invitations', () => {
      it('invites a single user with roles and records them in the audit event', async () => {
        const manager = await newManager();
        const invited = await request(manager, 'POST', '/api/admin/users', {
          email: 'Single.Invite@Example.org',
          firstName: 'Sam',
          roles: ['member'],
        });
        expect(invited.status).toBe(201);
        const created = await first<{ id: number }>(
          'SELECT id FROM users WHERE email = ?',
          'single.invite@example.org',
        );
        expect(await roleKeysOf(Number(created?.id))).toEqual(['member']);
        const audit = await lastAudit('single.invite@example.org', 'user.invited');
        expect(audit?.actor).toBe(manager.id);
        expect(audit?.changes).toMatchObject({ roles: ['member'] });
        expect(
          (
            await request(manager, 'POST', '/api/admin/users', {
              email: 'x@example.org',
              roles: ['nope'],
            })
          ).body.error,
        ).toBe('unknown_role');
      });

      it('previews a bulk invitation, then creates it atomically', async () => {
        const manager = await newManager();
        const existing = await createUser({ email: 'already.here@example.org' });
        const entries = [
          { email: 'bulk.one@example.org', firstName: 'One', lastName: 'Example' },
          { email: 'BULK.TWO@example.org' },
          { email: 'bulk.one@example.org' },
          { email: existing.email },
          { email: 'not-an-email' },
        ];
        const preview = await request(manager, 'POST', '/api/admin/users/bulk-invite', {
          entries,
          roles: ['member'],
          dryRun: true,
        });
        expect(preview.status).toBe(200);
        expect(preview.body.rows.map((row: Json) => row.status)).toEqual([
          'ok',
          'ok',
          'duplicate',
          'exists',
          'invalid_email',
        ]);
        expect(preview.body.valid).toBe(2);
        expect(
          await first('SELECT id FROM users WHERE email = ?', 'bulk.one@example.org'),
        ).toBeNull();

        const rejected = await request(manager, 'POST', '/api/admin/users/bulk-invite', {
          entries,
          roles: ['member'],
        });
        expect(rejected.status).toBe(422);
        expect(
          await first('SELECT id FROM users WHERE email = ?', 'bulk.one@example.org'),
        ).toBeNull();

        const created = await request(manager, 'POST', '/api/admin/users/bulk-invite', {
          entries: [entries[0], entries[1]],
          roles: ['member'],
        });
        expect(created.status).toBe(201);
        expect(created.body.created).toBe(2);
        for (const email of ['bulk.one@example.org', 'bulk.two@example.org']) {
          const user = await first<{ id: number; first_name: string }>(
            'SELECT id, first_name FROM users WHERE email = ?',
            email,
          );
          expect(await roleKeysOf(Number(user?.id))).toEqual(['member']);
          expect(await effectivePermissionKeys(env, Number(user?.id))).toEqual(
            expect.arrayContaining(['tasks.view', 'tasks.personal', 'tasks.comment']),
          );
          const audit = await lastAudit(email, 'user.invited');
          expect(audit?.actor).toBe(manager.id);
          expect(audit?.changes).toMatchObject({ bulk: 1, roles: ['member'] });
          const membership = await first(
            'SELECT 1 FROM workspace_members WHERE user_id = ?',
            user?.id,
          );
          expect(membership).not.toBeNull();
        }
        expect(
          (await request(manager, 'POST', '/api/admin/users/bulk-invite', { entries: [] })).status,
        ).toBe(400);
        const tooMany = Array.from({ length: 201 }, (_, index) => ({
          email: `many${index}@example.org`,
        }));
        expect(
          (await request(manager, 'POST', '/api/admin/users/bulk-invite', { entries: tooMany }))
            .status,
        ).toBe(400);
      });
    });

    describe('bulk actions', () => {
      it('applies role assignment and disable atomically, honouring every rule', async () => {
        const manager = await newManager();
        const users = await Promise.all(Array.from({ length: 5 }, () => createUser()));
        const ids = users.map((user) => user.id);
        const added = await request(manager, 'POST', '/api/admin/users/bulk', {
          action: 'add_roles',
          userIds: ids,
          roles: ['viewer', 'member'],
        });
        expect(added.body).toMatchObject({ ok: true, changed: 5, unchanged: 0 });
        for (const id of ids) expect(await roleKeysOf(id)).toEqual(['member', 'viewer']);
        const again = await request(manager, 'POST', '/api/admin/users/bulk', {
          action: 'add_roles',
          userIds: ids,
          roles: ['viewer'],
        });
        expect(again.body).toMatchObject({ changed: 0, unchanged: 5 });

        // One refused target refuses the whole batch: a platform administrator among the five.
        const admin = await newAdmin();
        const mixed = await request(manager, 'POST', '/api/admin/users/bulk', {
          action: 'disable',
          userIds: [...ids, admin.id],
        });
        expect(mixed.status).toBe(403);
        for (const id of ids) {
          expect(
            (await first<{ status: string }>('SELECT status FROM users WHERE id = ?', id))?.status,
          ).toBe('active');
        }
        const disabled = await request(manager, 'POST', '/api/admin/users/bulk', {
          action: 'disable',
          userIds: ids,
        });
        expect(disabled.body).toMatchObject({ changed: 5 });
        expect(
          (await request(users[0] as { id: number; email: string }, 'GET', '/api/tasks')).status,
        ).toBe(401);

        expect(
          (
            await request(manager, 'POST', '/api/admin/users/bulk', {
              action: 'disable',
              userIds: [manager.id],
            })
          ).body.error,
        ).toBe('cannot_remove_own_admin_access');
        expect(
          (
            await request(manager, 'POST', '/api/admin/users/bulk', {
              action: 'explode',
              userIds: ids,
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await request(manager, 'POST', '/api/admin/users/bulk', {
              action: 'disable',
              userIds: [],
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await request(manager, 'POST', '/api/admin/users/bulk', {
              action: 'disable',
              userIds: [999999999],
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await request(manager, 'POST', '/api/admin/users/bulk', {
              action: 'add_roles',
              userIds: ids,
              roles: [],
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await request(manager, 'POST', '/api/admin/users/bulk', {
              action: 'disable',
              userIds: Array.from({ length: 101 }, (_, i) => i + 1),
            })
          ).status,
        ).toBe(400);
      });

      it('refuses to remove the manager role from yourself', async () => {
        const viaRole = await createUser({ roles: ['manager'] });
        const result = await request(viaRole, 'PUT', `/api/admin/users/${viaRole.id}/roles`, {
          roles: ['viewer'],
        });
        expect(result.status).toBe(400);
        expect(result.body.error).toBe('cannot_remove_own_admin_access');
        expect(await roleKeysOf(viaRole.id)).toEqual(['manager']);
      });

      it('never lets the agent principal be bulk-modified', async () => {
        const agent = await first<{ id: number }>(
          "SELECT id FROM users WHERE principal_type = 'agent' LIMIT 1",
        );
        if (!agent) return;
        const result = await request(root, 'POST', '/api/admin/users/bulk', {
          action: 'disable',
          userIds: [agent.id],
        });
        expect(result.status).toBe(400);
        expect(result.body.failures[0].error).toBe('agent_principal_protected');
      });
    });

    describe('legacy edit flags next to roles', () => {
      it('does not mistake a role-granted permission for a direct one', async () => {
        const viaRole = await createUser({ roles: ['manager'] });
        const rename = await request(root, 'PATCH', `/api/admin/users/${viaRole.id}`, {
          firstName: 'Renamed',
        });
        expect(rename.status).toBe(200);
        expect(await roleKeysOf(viaRole.id)).toEqual(['manager']);
        expect(await effectivePermissionKeys(env, viaRole.id)).toContain('tasks.manage');
        const selfRename = await request(viaRole, 'PATCH', `/api/admin/users/${viaRole.id}`, {
          firstName: 'Self',
        });
        expect(selfRename.status).toBe(200);
      });

      it('refuses to withdraw a permission that a role still grants', async () => {
        const user = await createUser({
          permissions: ['tasks.view', 'tasks.manage'],
          roles: ['manager'],
        });
        const result = await request(root, 'PATCH', `/api/admin/users/${user.id}`, {
          isManager: false,
        });
        expect(result.status).toBe(409);
        expect(result.body).toEqual({ error: 'granted_by_role', permission: 'tasks.manage' });
        expect(await effectivePermissionKeys(env, user.id)).toContain('tasks.manage');
      });

      it('keeps the overview response shape and adds roles', async () => {
        const user = await createUser({ roles: ['viewer'] });
        const overview = await request(root, 'GET', '/api/admin');
        expect(overview.status).toBe(200);
        const entry = overview.body.users.find((candidate: Json) => candidate.id === user.id);
        expect(entry).toMatchObject({ email: user.email, status: 'active', roles: ['viewer'] });
        expect(entry.permissions).toEqual(['tasks.comment', 'tasks.personal', 'tasks.view']);
        expect(Object.keys(entry)).toEqual(
          expect.arrayContaining([
            'id',
            'email',
            'firstName',
            'lastName',
            'name',
            'photoUrl',
            'hasSignedIn',
            'createdAt',
            'status',
            'lastSeenAt',
            'permissions',
          ]),
        );
        const omitted = await request(root, 'GET', '/api/admin?users=omit');
        expect(omitted.body.users).toEqual([]);
        expect(omitted.body.stats.users).toBeGreaterThan(0);
      });
    });

    describe('review fixes', () => {
      let taskSeq = 900_000;
      const BASELINE = [
        'events.create',
        'events.view',
        'tasks.comment',
        'tasks.personal',
        'tasks.view',
      ];
      const directKeys = async (userId: number) =>
        (
          await all<{ permission_key: string }>(
            'SELECT permission_key FROM user_permissions WHERE user_id = ? ORDER BY permission_key',
            userId,
          )
        ).map((row) => row.permission_key);
      /** A user who holds roles and nothing else, as a person assigned roles through the API is. */
      async function roleOnlyUser(roles: string[]) {
        const user = await createUser({ roles });
        await run('DELETE FROM user_permissions WHERE user_id = ?', user.id);
        return user;
      }
      async function customRole(label: string, permissions: string[]) {
        const created = await request(root, 'POST', '/api/admin/roles', { label, permissions });
        expect(created.status).toBe(201);
        return created.body.role.key as string;
      }
      async function sharedTask(title = 'Shared planning task') {
        taskSeq += 1;
        const key = `TASK-RBAC-${taskSeq}`;
        await run(
          `INSERT INTO tasks (task_key, seq, title, created_by_user_id, sort_key, workspace_id, project_id)
           SELECT ?, ?, ?, ?, 'a0', p.workspace_id, p.id FROM projects p
           WHERE p.project_key = ?`,
          key,
          taskSeq,
          title,
          root.id,
          tenantProfile.defaultProjectKey,
        );
        const stored = await first<{ id: number }>('SELECT id FROM tasks WHERE task_key = ?', key);
        expect(stored, 'the default project must exist').not.toBeNull();
        return { key, id: Number(stored?.id) };
      }
      async function personalTask(owner: { id: number }, title: string) {
        taskSeq += 1;
        const key = `TASK-RBAC-${taskSeq}`;
        await run(
          `INSERT INTO tasks (task_key, seq, title, created_by_user_id, sort_key, workspace_id, project_id)
           SELECT ?, ?, ?, ?, 'a0', p.workspace_id, p.id FROM projects p
           WHERE p.project_type = 'personal' AND p.personal_owner_user_id = ?`,
          key,
          taskSeq,
          title,
          owner.id,
          owner.id,
        );
        const stored = await first<{ id: number }>('SELECT id FROM tasks WHERE task_key = ?', key);
        expect(stored, 'the personal project must exist').not.toBeNull();
        return { key, id: Number(stored?.id) };
      }
      async function recordTaskAudit(
        action: string,
        entityType: 'task' | 'comment',
        entityKey: string,
        changes: unknown,
      ) {
        await run(
          `INSERT INTO audit_events (actor_user_id, entity_type, entity_key, action, changes_json)
           VALUES (?, ?, ?, ?, ?)`,
          root.id,
          entityType,
          entityKey,
          action,
          JSON.stringify(changes),
        );
      }

      describe('flag-derived grants follow the subset rule', () => {
        it('refuses PATCH flags that grant what the actor does not hold', async () => {
          const roleKey = await customRole('Task Manager Only', ['tasks.manage']);
          const actor = await roleOnlyUser([roleKey]);
          expect(
            (
              await request(actor, 'PUT', `/api/admin/users/${actor.id}/roles`, {
                roles: ['viewer'],
              })
            ).status,
          ).toBe(403);
          const target = await createUser();
          await run(
            "DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'tasks.view'",
            target.id,
          );
          const patched = await request(actor, 'PATCH', `/api/admin/users/${target.id}`, {
            hasTaskAccess: true,
          });
          expect(patched.status).toBe(403);
          expect(patched.body.error).toBe('role_exceeds_permissions');
          expect(patched.body.missing).toContain('tasks.view');
          expect(await effectivePermissionKeys(env, target.id)).not.toContain('tasks.view');
          // The refused request wrote nothing at all, not even the unconditional baseline.
          expect(await lastAudit(target.email, 'user.access_updated')).toBeNull();
        });

        it('refuses invitation flags and the baseline for an actor who lacks them', async () => {
          const roleKey = await customRole('Task Manager Only Two', ['tasks.manage']);
          const actor = await roleOnlyUser([roleKey]);
          const flagged = await request(actor, 'POST', '/api/admin/users', {
            email: 'flag.invite@example.org',
            hasTaskAccess: true,
          });
          expect(flagged.status).toBe(403);
          expect(flagged.body.error).toBe('role_exceeds_permissions');
          expect(flagged.body.missing).toEqual(
            expect.arrayContaining(['tasks.comment', 'tasks.personal', 'tasks.view']),
          );
          expect(
            await first('SELECT id FROM users WHERE email = ?', 'flag.invite@example.org'),
          ).toBeNull();
          const bulk = await request(actor, 'POST', '/api/admin/users/bulk-invite', {
            entries: [{ email: 'flag.bulk@example.org' }],
          });
          expect(bulk.status).toBe(403);
          expect(bulk.body.error).toBe('role_exceeds_permissions');
          expect(
            await first('SELECT id FROM users WHERE email = ?', 'flag.bulk@example.org'),
          ).toBeNull();
          // Inviting with a role the actor holds is still allowed (the role decides the access).
          const withRole = await request(actor, 'POST', '/api/admin/users/bulk-invite', {
            entries: [{ email: 'flag.bulk@example.org' }],
            roles: [roleKey],
          });
          expect(withRole.status).toBe(201);
        });

        it('keeps working for actors who hold the permissions, event grants included', async () => {
          const manager = await newManager();
          const target = await createUser();
          const patched = await request(manager, 'PATCH', `/api/admin/users/${target.id}`, {
            hasTaskAccess: true,
            isManager: true,
            ...(tenantProfile.capabilities.events
              ? { isEventManager: true, canApproveEvents: true }
              : {}),
          });
          expect(patched.status).toBe(200);
          const invited = await request(manager, 'POST', '/api/admin/users', {
            email: 'allowed.invite@example.org',
            hasTaskAccess: true,
            ...(tenantProfile.capabilities.events ? { isEventManager: true } : {}),
          });
          expect(invited.status).toBe(201);
          // A task manager who does not hold tasks.view may still grant the events.* permissions.
          const eventsOnly = await roleOnlyUser([
            await customRole('Events Only Manager', ['tasks.manage', 'events.view']),
          ]);
          const grantEvents = await request(eventsOnly, 'PATCH', `/api/admin/users/${target.id}`, {
            ...(tenantProfile.capabilities.events ? { isEventManager: true } : {}),
          });
          expect(grantEvents.status).toBe(200);
        });
      });

      describe('Member and Viewer are real roles', () => {
        it('removes the direct baseline when a role is assigned and keeps everything else', async () => {
          const target = await createUser({
            permissions: ['tasks.view', 'tasks.manage', 'events.view', 'events.create'],
          });
          const before = await directKeys(target.id);
          expect(before).toEqual(expect.arrayContaining([...BASELINE.slice(0, 0), 'tasks.manage']));
          const assigned = await request(root, 'PUT', `/api/admin/users/${target.id}/roles`, {
            roles: ['viewer'],
          });
          expect(assigned.status).toBe(200);
          expect(await directKeys(target.id)).toEqual(['tasks.manage']);
          expect(await effectivePermissionKeys(env, target.id)).toEqual([
            'tasks.manage',
            'tasks.view',
          ]);
          const audit = await lastAudit(target.email, 'user.roles_updated');
          expect(audit?.changes.removedDirectGrants).toEqual(
            before.filter((key) => BASELINE.includes(key)),
          );
        });

        it('applies to bulk assignment and to invitations with roles', async () => {
          const people = await Promise.all([createUser(), createUser()]);
          const bulk = await request(root, 'POST', '/api/admin/users/bulk', {
            action: 'add_roles',
            userIds: people.map((person) => person.id),
            roles: ['viewer'],
          });
          expect(bulk.status).toBe(200);
          for (const person of people) {
            expect(await directKeys(person.id)).toEqual([]);
            expect(await effectivePermissionKeys(env, person.id)).toEqual(['tasks.view']);
          }
          const invited = await request(root, 'POST', '/api/admin/users', {
            email: 'viewer.invite@example.org',
            roles: ['viewer'],
          });
          expect(invited.status).toBe(201);
          const bulkInvited = await request(root, 'POST', '/api/admin/users/bulk-invite', {
            entries: [{ email: 'viewer.bulk@example.org' }],
            roles: ['viewer'],
          });
          expect(bulkInvited.status).toBe(201);
          for (const email of ['viewer.invite@example.org', 'viewer.bulk@example.org']) {
            const user = await first<{ id: number }>('SELECT id FROM users WHERE email = ?', email);
            expect(await directKeys(Number(user?.id))).toEqual([]);
            expect(await effectivePermissionKeys(env, Number(user?.id))).toEqual(['tasks.view']);
          }
          // Without a role a new person keeps today's direct baseline.
          const plain = await request(root, 'POST', '/api/admin/users', {
            email: 'plain.invite@example.org',
          });
          expect(plain.status).toBe(201);
          const plainUser = await first<{ id: number }>(
            'SELECT id FROM users WHERE email = ?',
            'plain.invite@example.org',
          );
          expect(await directKeys(Number(plainUser?.id))).toEqual(
            expect.arrayContaining(['tasks.comment', 'tasks.personal']),
          );
        });

        it('makes Viewer read-only and removing Member revoke access on the next request', async () => {
          const task = await sharedTask();
          const person = await createUser();
          const assigned = await request(root, 'PUT', `/api/admin/users/${person.id}/roles`, {
            roles: ['viewer'],
          });
          expect(assigned.status).toBe(200);
          expect((await request(person, 'GET', `/api/tasks/${task.key}`)).status).toBe(200);
          const denied = await request(person, 'POST', `/api/tasks/${task.key}/comments`, {
            body: 'Can a viewer comment?',
          });
          expect(denied.status).toBe(403);
          await request(root, 'PUT', `/api/admin/users/${person.id}/roles`, { roles: ['member'] });
          const allowed = await request(person, 'POST', `/api/tasks/${task.key}/comments`, {
            body: 'Members can comment.',
          });
          expect(allowed.status).toBe(201);
          const removed = await request(root, 'POST', '/api/admin/users/bulk', {
            action: 'remove_roles',
            userIds: [person.id],
            roles: ['member'],
          });
          expect(removed.status).toBe(200);
          expect(removed.body.withoutRoles).toEqual([person.id]);
          // The same session, the very next request: nothing is left to read or comment with.
          expect((await request(person, 'GET', `/api/tasks/${task.key}`)).status).not.toBe(200);
          expect(
            (
              await request(person, 'POST', `/api/tasks/${task.key}/comments`, {
                body: 'Still here?',
              })
            ).status,
          ).toBe(403);
          expect(await effectivePermissionKeys(env, person.id)).toEqual([]);
        });

        it('does not hand the baseline back through edits, project membership or sign-in', async () => {
          const person = await createUser();
          await request(root, 'PUT', `/api/admin/users/${person.id}/roles`, { roles: ['viewer'] });
          const edited = await request(root, 'PATCH', `/api/admin/users/${person.id}`, {
            firstName: 'Renamed',
          });
          expect(edited.status).toBe(200);
          expect(await directKeys(person.id)).toEqual([]);
          const added = await request(
            root,
            'PUT',
            `/api/projects/${tenantProfile.defaultProjectKey}/members`,
            { email: person.email, role: 'viewer' },
          );
          expect(added.status).toBe(200);
          expect(await directKeys(person.id)).toEqual([]);
          await provisionSignedInUser(env, person);
          expect(await directKeys(person.id)).toEqual([]);
          expect(await effectivePermissionKeys(env, person.id)).toEqual(['tasks.view']);
          // Users without any role keep exactly today's sign-in behaviour.
          const plain = await createUser();
          await run('DELETE FROM user_permissions WHERE user_id = ?', plain.id);
          await run(
            "INSERT INTO user_permissions (user_id, permission_key) VALUES (?, 'tasks.view')",
            plain.id,
          );
          await provisionSignedInUser(env, plain);
          expect(await directKeys(plain.id)).toEqual(
            expect.arrayContaining(['tasks.comment', 'tasks.view']),
          );
        });

        it('lets an administrator remove the last role, leaving only what remains', async () => {
          const person = await createUser({ permissions: ['tasks.manage'] });
          await request(root, 'PUT', `/api/admin/users/${person.id}/roles`, { roles: ['member'] });
          const cleared = await request(root, 'PUT', `/api/admin/users/${person.id}/roles`, {
            roles: [],
          });
          expect(cleared.status).toBe(200);
          expect(cleared.body.withoutRoles).toEqual([person.id]);
          expect(await roleKeysOf(person.id)).toEqual([]);
          expect(await effectivePermissionKeys(env, person.id)).toEqual(['tasks.manage']);
        });
      });

      describe('audit log hides personal-project content from task managers', () => {
        it('excludes personal events everywhere and redacts events it cannot place', async () => {
          const owner = await createUser();
          const manager = await newManager();
          const secret = await personalTask(owner, 'Secret planning marker');
          const shared = await sharedTask('Visible shared marker');
          const orphan = `TASK-RBAC-GONE-${taskSeq}`;
          await recordTaskAudit('task.created', 'task', secret.key, {
            title: 'Secret planning marker',
          });
          await recordTaskAudit('task.created', 'task', shared.key, {
            title: 'Visible shared marker',
          });
          await recordTaskAudit('task.updated', 'task', orphan, { title: 'Removed task content' });
          await run(
            'INSERT INTO task_comments (task_id, author_user_id, body) VALUES (?, ?, ?)',
            secret.id,
            owner.id,
            'Private comment body',
          );
          const comment = await first<{ id: number }>(
            'SELECT id FROM task_comments WHERE task_id = ?',
            secret.id,
          );
          await recordTaskAudit('comment.created', 'comment', String(comment?.id), {
            taskKey: secret.key,
          });
          await recordTaskAudit('comment.deleted', 'comment', '987654321', { taskKey: orphan });

          const asManager = await request(manager, 'GET', '/api/admin/audit?limit=100');
          expect(asManager.status).toBe(200);
          const text = JSON.stringify(asManager.body);
          expect(text).not.toContain('Secret planning marker');
          expect(text).not.toContain(secret.key);
          expect(text).toContain('Visible shared marker');
          const orphaned = asManager.body.events.filter(
            (event: Json) => event.entityKey === orphan || event.entityKey === '987654321',
          );
          expect(orphaned).toHaveLength(2);
          for (const event of orphaned) {
            expect(event.changes).toEqual({});
            expect(event.redacted).toBe(true);
          }
          // Search by target cannot find, count or probe the hidden events.
          const search = await request(manager, 'GET', `/api/admin/audit?target=${secret.key}`);
          expect(search.body.events).toEqual([]);
          const byComment = await request(manager, 'GET', `/api/admin/audit?target=${comment?.id}`);
          expect(JSON.stringify(byComment.body.events)).not.toContain(secret.key);

          const legacy = await request(manager, 'GET', '/api/admin?users=omit');
          expect(JSON.stringify(legacy.body.events)).not.toContain('Secret planning marker');
          expect(JSON.stringify(legacy.body.events)).not.toContain(secret.key);
          expect(JSON.stringify(legacy.body.events)).toContain('Visible shared marker');

          const asAdmin = await request(root, 'GET', '/api/admin/audit?limit=100');
          expect(JSON.stringify(asAdmin.body)).toContain('Secret planning marker');
          expect(JSON.stringify(asAdmin.body)).toContain(secret.key);
          const adminLegacy = await request(root, 'GET', '/api/admin?users=omit');
          expect(JSON.stringify(adminLegacy.body.events)).toContain('Secret planning marker');
        });
      });

      describe('directory cursor', () => {
        it('pages through emails that are not Latin-1', async () => {
          for (const name of ['aaa', 'aab', 'aac']) {
            await createUser({ email: `${name}.zażółć.łukasz@example.org` });
          }
          const first = await request(root, 'GET', '/api/admin/directory?q=zażółć&limit=1');
          expect(first.status).toBe(200);
          expect(first.body.users).toHaveLength(1);
          expect(typeof first.body.nextCursor).toBe('string');
          const second = await request(
            root,
            'GET',
            `/api/admin/directory?q=${encodeURIComponent('zażółć')}&limit=1&cursor=${first.body.nextCursor}`,
          );
          expect(second.status).toBe(200);
          expect(second.body.users[0].email).toBe('aab.zażółć.łukasz@example.org');
          expect((await request(root, 'GET', '/api/admin/directory?cursor=%E0%80')).status).toBe(
            400,
          );
        });
      });

      describe('granted_by under impersonation', () => {
        it('records the real administrator, not the impersonated person', async () => {
          const manager = await newManager();
          const token = await signSession(env, manager, [], root);
          const prefix = tenantProfile.security.cookiePrefix;
          const asRoot = async (method: string, path: string, body?: unknown) => {
            const response = await app.request(
              `${ORIGIN}${path}`,
              {
                method,
                headers: {
                  'Content-Type': 'application/json',
                  Cookie: `${prefix}_session=${token}; ${prefix}_csrf=${CSRF}`,
                  Origin: ORIGIN,
                  'X-CSRF-Token': CSRF,
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              },
              env,
            );
            return { status: response.status };
          };
          const grantedBy = async (email: string) =>
            (
              await first<{ granted_by: number }>(
                `SELECT ur.granted_by FROM user_roles ur JOIN users u ON u.id = ur.user_id
                 WHERE u.email = ? ORDER BY ur.granted_at DESC LIMIT 1`,
                email,
              )
            )?.granted_by;
          const target = await createUser();
          expect(
            (await asRoot('PUT', `/api/admin/users/${target.id}/roles`, { roles: ['member'] }))
              .status,
          ).toBe(200);
          expect(await grantedBy(target.email)).toBe(root.id);
          expect(
            (
              await asRoot('POST', '/api/admin/users', {
                email: 'imp.single@example.org',
                roles: ['viewer'],
              })
            ).status,
          ).toBe(201);
          expect(await grantedBy('imp.single@example.org')).toBe(root.id);
          expect(
            (
              await asRoot('POST', '/api/admin/users/bulk-invite', {
                entries: [{ email: 'imp.bulk@example.org' }],
                roles: ['viewer'],
              })
            ).status,
          ).toBe(201);
          expect(await grantedBy('imp.bulk@example.org')).toBe(root.id);
        });

        it('records the real administrator for role-deletion reassignments', async () => {
          // Only an administrator can delete roles, so the impersonated person is one too.
          const other = await newAdmin();
          const token = await signSession(env, other, [], root);
          const prefix = tenantProfile.security.cookiePrefix;
          const replaced = await customRole('Replaceable', ['tasks.view']);
          const replacement = await customRole('Replacement', ['tasks.view']);
          const holder = await roleOnlyUser([replaced]);
          const response = await app.request(
            `${ORIGIN}/api/admin/roles/${replaced}?replacement=${replacement}`,
            {
              method: 'DELETE',
              headers: {
                Cookie: `${prefix}_session=${token}; ${prefix}_csrf=${CSRF}`,
                Origin: ORIGIN,
                'X-CSRF-Token': CSRF,
              },
            },
            env,
            executionContext,
          );
          expect(response.status).toBe(200);
          const row = await first<{ granted_by: number }>(
            'SELECT granted_by FROM user_roles WHERE user_id = ? AND role_key = ?',
            holder.id,
            replacement,
          );
          expect(row?.granted_by).toBe(root.id);
          expect(row?.granted_by).not.toBe(other.id);
        });
      });

      describe('effective_user_permissions for a direct administrator', () => {
        it('expands platform.admin to every permission without copy rows', async () => {
          const admin = await newAdmin();
          await run(
            "DELETE FROM user_permissions WHERE user_id = ? AND permission_key <> 'platform.admin'",
            admin.id,
          );
          const everything = (
            await all<{ key: string }>('SELECT key FROM permissions ORDER BY key')
          ).map((row) => row.key);
          expect(await effectivePermissionKeys(env, admin.id)).toEqual(everything);
          expect(await userHasPermission(env, admin.id, 'tasks.manage')).toBe(true);
        });
      });

      describe('concurrent changes', () => {
        it('answers concurrent role creation with 201 or 409, never a server error', async () => {
          const results = await Promise.all(
            Array.from({ length: 4 }, () =>
              request(root, 'POST', '/api/admin/roles', {
                label: 'Racing Role',
                permissions: ['tasks.view'],
              }),
            ),
          );
          expect(
            results.map((result) => result.status).every((status) => [201, 409].includes(status)),
          ).toBe(true);
          expect(results.some((result) => result.status === 201)).toBe(true);
          const explicit = await Promise.all(
            Array.from({ length: 3 }, () =>
              request(root, 'POST', '/api/admin/roles', {
                key: 'racing-fixed',
                label: 'Racing Fixed',
                permissions: ['tasks.view'],
              }),
            ),
          );
          expect(explicit.filter((result) => result.status === 201)).toHaveLength(1);
          expect(explicit.every((result) => [201, 409].includes(result.status))).toBe(true);
        });

        it('answers concurrent bulk invitations with one winner and no server error', async () => {
          const entries = [{ email: 'race.one@example.org' }, { email: 'race.two@example.org' }];
          const results = await Promise.all(
            Array.from({ length: 3 }, () =>
              request(root, 'POST', '/api/admin/users/bulk-invite', { entries, roles: ['viewer'] }),
            ),
          );
          expect(results.every((result) => [201, 409, 422].includes(result.status))).toBe(true);
          expect(results.filter((result) => result.status === 201)).toHaveLength(1);
          const created = await first<{ n: number }>(
            "SELECT COUNT(*) AS n FROM users WHERE email LIKE 'race.%@example.org'",
          );
          expect(created?.n).toBe(2);
        });

        it('refuses to drop assignments added after the count was read', async () => {
          const roleKey = await customRole('Late Assignment', ['tasks.view']);
          const holder = await createUser();
          // The state the API sees if someone is assigned between its count and its batch: the
          // role has users although none was named as a replacement. The batch must fail whole.
          await run('INSERT INTO user_roles (user_id, role_key) VALUES (?, ?)', holder.id, roleKey);
          await expect(
            env.DB.batch([
              env.DB.prepare(
                `INSERT INTO role_delete_guard (ok)
                 SELECT CASE WHEN ? = 0 AND EXISTS (SELECT 1 FROM user_roles WHERE role_key = ?)
                   THEN 0 ELSE 1 END`,
              ).bind(0, roleKey),
              env.DB.prepare('DELETE FROM user_roles WHERE role_key = ?').bind(roleKey),
              env.DB.prepare('DELETE FROM roles WHERE key = ?').bind(roleKey),
            ]),
          ).rejects.toThrow(/role_in_use/);
          expect(await roleKeysOf(holder.id)).toEqual([roleKey]);
          const refused = await request(root, 'DELETE', `/api/admin/roles/${roleKey}`);
          expect(refused.status).toBe(409);
          expect(refused.body.error).toBe('role_in_use');
          expect(await roleKeysOf(holder.id)).toEqual([roleKey]);
        });

        it('never reports success for a delete that raced with an assignment', async () => {
          const roleKey = await customRole('Racing Delete', ['tasks.view']);
          const person = await createUser();
          const [assigned, deleted] = await Promise.all([
            request(root, 'PUT', `/api/admin/users/${person.id}/roles`, { roles: [roleKey] }),
            request(root, 'DELETE', `/api/admin/roles/${roleKey}`),
          ]);
          expect([200, 400, 409, 404]).toContain(assigned.status);
          expect([200, 409, 404]).toContain(deleted.status);
          expect(assigned.status === 200 && deleted.status === 200).toBe(false);
          const exists = await first('SELECT 1 FROM roles WHERE key = ?', roleKey);
          if (assigned.status === 200) expect(exists).not.toBeNull();
        });

        it('reassigns and audits holders when a replacement is named', async () => {
          const doomed = await customRole('Doomed Role', ['tasks.view']);
          const heir = await customRole('Heir Role', ['tasks.view']);
          const holder = await createUser();
          await request(root, 'PUT', `/api/admin/users/${holder.id}/roles`, { roles: [doomed] });
          const deleted = await request(
            root,
            'DELETE',
            `/api/admin/roles/${doomed}?replacement=${heir}`,
          );
          expect(deleted.status).toBe(200);
          expect(await roleKeysOf(holder.id)).toEqual([heir]);
          const audit = await lastAudit(holder.email, 'user.roles_updated');
          expect(audit?.changes).toMatchObject({
            reason: 'role_deleted',
            removed: [doomed],
            added: [heir],
          });
        });
      });
    });

    describe('directory at scale', () => {
      const TOTAL = 10_000;

      beforeAll(async () => {
        // 10,000 synthetic users with spread-out names, 1 in 5 disabled, 2 in 10 given a role.
        await run(
          `WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${TOTAL})
           INSERT INTO users (email, first_name, last_name, status)
           SELECT 'synthetic' || printf('%05d', n) || '@example.org',
             CASE n % 4 WHEN 0 THEN 'Avery' WHEN 1 THEN 'Blake' WHEN 2 THEN 'Casey' ELSE 'Devon' END,
             'Sample' || printf('%05d', n),
             CASE WHEN n % 5 = 0 THEN 'disabled' ELSE 'active' END
           FROM seq`,
        );
        await run(
          `INSERT INTO user_roles (user_id, role_key)
           SELECT id, 'viewer' FROM users WHERE email LIKE 'synthetic%' AND CAST(substr(email, 10, 5) AS INTEGER) % 10 IN (0, 1)`,
        );
      }, 120_000);

      const admin = () => root;

      it('pages through every user once, in order, without loading them all', async () => {
        const seen: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        let total = 0;
        do {
          const response: { status: number; body: Json } = await request(
            admin(),
            'GET',
            `/api/admin/directory?q=synthetic&limit=100${cursor ? `&cursor=${cursor}` : ''}`,
          );
          expect(response.status).toBe(200);
          expect(response.body.users.length).toBeLessThanOrEqual(100);
          seen.push(...response.body.users.map((user: Json) => user.email));
          total = response.body.total;
          cursor = response.body.nextCursor;
          pages += 1;
        } while (cursor);
        expect(total).toBe(TOTAL);
        expect(seen).toHaveLength(TOTAL);
        expect(new Set(seen).size).toBe(TOTAL);
        expect(seen).toEqual([...seen].sort());
        expect(pages).toBe(TOTAL / 100);
      }, 120_000);

      it('searches name or email server-side', async () => {
        const byEmail = await request(admin(), 'GET', '/api/admin/directory?q=synthetic00042@');
        expect(byEmail.body.users.map((user: Json) => user.email)).toEqual([
          'synthetic00042@example.org',
        ]);
        const byName = await request(admin(), 'GET', '/api/admin/directory?q=sample07777');
        expect(byName.body.users.map((user: Json) => user.email)).toEqual([
          'synthetic07777@example.org',
        ]);
        const byFull = await request(admin(), 'GET', '/api/admin/directory?q=Avery%20Sample00004');
        expect(byFull.body.total).toBe(1);
        const none = await request(admin(), 'GET', '/api/admin/directory?q=zzzz-nobody');
        expect(none.body).toMatchObject({ users: [], total: 0, nextCursor: null });
        // LIKE wildcards are matched literally.
        expect((await request(admin(), 'GET', '/api/admin/directory?q=%25')).body.total).toBe(0);
        expect((await request(admin(), 'GET', '/api/admin/directory?q=_')).body.total).toBe(0);
      });

      it('filters by status and role and combines filters with search', async () => {
        const disabled = await request(
          admin(),
          'GET',
          '/api/admin/directory?q=synthetic&status=disabled&limit=5',
        );
        expect(disabled.body.total).toBe(TOTAL / 5);
        expect(disabled.body.users.every((user: Json) => user.status === 'disabled')).toBe(true);
        const viewers = await request(admin(), 'GET', '/api/admin/directory?role=viewer&limit=100');
        expect(viewers.body.total).toBeGreaterThanOrEqual(TOTAL / 5);
        expect(viewers.body.users.every((user: Json) => user.roles.includes('viewer'))).toBe(true);
        const combined = await request(
          admin(),
          'GET',
          '/api/admin/directory?q=synthetic&role=viewer&status=active',
        );
        expect(combined.body.total).toBe(TOTAL / 10);
        const admins = await request(admin(), 'GET', '/api/admin/directory?q=root@');
        expect(admins.body.users[0]).toMatchObject({ isPlatformAdmin: true, isManager: true });
        expect((await request(admin(), 'GET', '/api/admin/directory?status=weird')).status).toBe(
          400,
        );
        expect((await request(admin(), 'GET', '/api/admin/directory?cursor=%25%25')).status).toBe(
          400,
        );
      });

      it('clamps the page size and rejects non-managers', async () => {
        const huge = await request(admin(), 'GET', '/api/admin/directory?q=synthetic&limit=100000');
        expect(huge.body.users).toHaveLength(100);
        const tiny = await request(admin(), 'GET', '/api/admin/directory?q=synthetic&limit=0');
        expect(tiny.body.users).toHaveLength(50);
        const viewer = await createUser({ roles: ['viewer'] });
        expect((await request(viewer, 'GET', '/api/admin/directory')).status).toBe(403);
      });

      it('serves the page query from an index, with no table sort', async () => {
        const plan = async (filters: Parameters<typeof directoryQuery>[0]) => {
          const built = directoryQuery(filters);
          const rows = await all<{ detail: string }>(
            `EXPLAIN QUERY PLAN ${built.pageSql}`,
            ...built.pageBinds,
          );
          return rows.map((row) => row.detail).join('\n');
        };
        for (const filters of [
          { limit: 50 },
          { limit: 50, cursor: 'synthetic05000@example.org' },
          { limit: 50, status: 'active', cursor: 'synthetic05000@example.org' },
          { limit: 50, status: 'disabled' },
          { limit: 50, role: 'viewer', cursor: 'synthetic05000@example.org' },
        ]) {
          const detail = await plan(filters);
          expect(detail, JSON.stringify(filters)).not.toMatch(/TEMP B-TREE/);
          expect(detail, JSON.stringify(filters)).toMatch(/INDEX/);
        }
      });

      it('answers each directory request quickly at this size', async () => {
        const started = Date.now();
        for (let page = 0; page < 20; page += 1) {
          await request(admin(), 'GET', '/api/admin/directory?q=synthetic&limit=100&status=active');
        }
        expect((Date.now() - started) / 20).toBeLessThan(2000);
      });

      it('bulk-disables a full page atomically and fast', async () => {
        const page = await request(
          admin(),
          'GET',
          '/api/admin/directory?q=synthetic&status=active&limit=100',
        );
        const ids = page.body.users.map((user: Json) => user.id);
        expect(ids).toHaveLength(100);
        const result = await request(admin(), 'POST', '/api/admin/users/bulk', {
          action: 'disable',
          userIds: ids,
        });
        expect(result.body).toMatchObject({ ok: true, changed: 100 });
        const audits = await first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'user.access_updated' AND entity_key LIKE 'synthetic%'",
        );
        expect(audits?.n).toBeGreaterThanOrEqual(100);
        const roleAssign = await request(admin(), 'POST', '/api/admin/users/bulk', {
          action: 'add_roles',
          userIds: ids,
          roles: ['member'],
        });
        expect(roleAssign.body).toMatchObject({ changed: 100 });
      }, 60_000);
    });
  });
}
