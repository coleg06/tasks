import type { Context } from 'hono';
import type { TaskAppEnv } from '../app-env';
import { effectivePermissionKeys, PLATFORM_ADMIN_PERMISSION } from '../auth/permissions';
import type { Env } from '../env';
import type { SqlStatement } from '../platform/ports';

export type AppContext = Context<TaskAppEnv>;

export const MANAGE_PERMISSION = 'tasks.manage';

/**
 * Permissions a `tasks.manage` holder may hand out (to anyone, themselves included) even though
 * they do not hold them. This is the long-standing rule that task managers can grant event
 * management and event approval; it is applied to role assignment so roles do not close it. Every
 * other permission follows the strict subset rule: nobody grants what they do not hold.
 */
export const MANAGER_DELEGABLE_PERMISSIONS: readonly string[] = [
  'events.view',
  'events.create',
  'events.manage',
  'events.approve',
];

/**
 * Permissions every ordinary user receives as a direct grant when they have no role (the creation
 * trigger, sign-in provisioning and administrator edits all add them). Once a user holds any role
 * these are decided by the roles alone: assigning a role removes the user's direct grants of them
 * (`dropBaselineGrantsStatement`) and nothing adds them back while a role is held. Task, event and
 * platform management (`tasks.manage`, `events.manage`, `events.approve`, `platform.admin`) are never
 * part of the baseline and are never touched by role assignment.
 */
export const BASELINE_PERMISSIONS: readonly string[] = [
  'tasks.view',
  'tasks.comment',
  'tasks.personal',
  'events.view',
  'events.create',
];

const AREA_LABELS: Record<string, string> = {
  tasks: 'Tasks',
  events: 'Events',
  platform: 'Platform',
};

export type PermissionInfo = { key: string; label: string; description: string };
export type PermissionArea = { area: string; label: string; permissions: PermissionInfo[] };
export type RoleRecord = {
  key: string;
  label: string;
  description: string;
  builtin: boolean;
  permissions: string[];
  /** True when the role contains platform.admin and therefore every permission. */
  grantsAll: boolean;
  userCount: number;
};

export async function listPermissions(env: Env, includeEvents = true): Promise<PermissionInfo[]> {
  const rows = await env.DB.prepare(
    'SELECT key, label, description FROM permissions ORDER BY key',
  ).all<PermissionInfo>();
  return rows.results.filter((row) => includeEvents || !row.key.startsWith('events.'));
}

export function groupPermissions(permissions: PermissionInfo[]): PermissionArea[] {
  const order = ['tasks', 'events', 'platform'];
  const groups = new Map<string, PermissionInfo[]>();
  for (const permission of permissions) {
    const area = permission.key.split('.')[0] ?? 'other';
    groups.set(area, [...(groups.get(area) ?? []), permission]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    })
    .map(([area, items]) => ({
      area,
      label: AREA_LABELS[area] ?? area.charAt(0).toUpperCase() + area.slice(1),
      permissions: items,
    }));
}

export async function listRoles(env: Env): Promise<RoleRecord[]> {
  const [roles, grants, counts] = await Promise.all([
    env.DB.prepare(
      'SELECT key, label, description, builtin FROM roles ORDER BY builtin DESC, label COLLATE NOCASE',
    ).all<{ key: string; label: string; description: string; builtin: number }>(),
    env.DB.prepare(
      'SELECT role_key, permission_key FROM role_permissions ORDER BY role_key, permission_key',
    ).all<{ role_key: string; permission_key: string }>(),
    env.DB.prepare('SELECT role_key, COUNT(*) AS n FROM user_roles GROUP BY role_key').all<{
      role_key: string;
      n: number;
    }>(),
  ]);
  const byRole = new Map<string, string[]>();
  for (const grant of grants.results) {
    byRole.set(grant.role_key, [...(byRole.get(grant.role_key) ?? []), grant.permission_key]);
  }
  const userCounts = new Map(counts.results.map((row) => [row.role_key, row.n]));
  return roles.results.map((role) => {
    const permissions = byRole.get(role.key) ?? [];
    return {
      key: role.key,
      label: role.label,
      description: role.description,
      builtin: role.builtin === 1,
      permissions,
      grantsAll: permissions.includes(PLATFORM_ADMIN_PERMISSION),
      userCount: userCounts.get(role.key) ?? 0,
    };
  });
}

/** Every permission a role confers: a role holding platform.admin confers all of them. */
export function roleClosure(role: Pick<RoleRecord, 'permissions' | 'grantsAll'>, all: string[]) {
  return role.grantsAll ? all : role.permissions;
}

/**
 * What `actorId` may hand out: their own effective permissions plus, for task managers, the
 * delegable event permissions. Computed from current database state.
 */
export async function grantablePermissions(env: Env, actorId: number) {
  const held = new Set(await effectivePermissionKeys(env, actorId));
  if (held.has(MANAGE_PERMISSION) || held.has(PLATFORM_ADMIN_PERMISSION)) {
    for (const key of MANAGER_DELEGABLE_PERMISSIONS) held.add(key);
  }
  return held;
}

export function missingPermissions(grantable: Set<string>, needed: Iterable<string>) {
  return [...new Set(needed)].filter((key) => !grantable.has(key)).sort();
}

export async function isEffectivePlatformAdmin(env: Env, userId: number) {
  const row = await env.DB.prepare(
    `SELECT 1 AS yes FROM effective_user_permissions
     WHERE user_id = ? AND permission_key = 'platform.admin' LIMIT 1`,
  )
    .bind(userId)
    .first<{ yes: number }>();
  return Boolean(row?.yes);
}

/** Active users who are platform administrators, by any route (direct grant or role). */
export async function activePlatformAdminCount(env: Env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM users u
     WHERE u.status = 'active' AND EXISTS (
       SELECT 1 FROM effective_user_permissions e
       WHERE e.user_id = u.id AND e.permission_key = 'platform.admin'
     )`,
  ).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Final statement of any batch that can shrink the administrator set. If an active platform
 * administrator existed before the batch (`hadAdmin`) but none remains after its earlier
 * statements, the guard's CHECK fails and the whole batch rolls back (migration 0020).
 */
export function lastPlatformAdminGuard(env: Env, hadAdmin: boolean): SqlStatement {
  return env.DB.prepare(
    `INSERT INTO platform_admin_guard (expected)
     SELECT CASE WHEN ? = 1 AND NOT EXISTS (
       SELECT 1 FROM users u
       JOIN effective_user_permissions e
         ON e.user_id = u.id AND e.permission_key = 'platform.admin'
       WHERE u.status = 'active'
     ) THEN 0 ELSE 1 END`,
  ).bind(hadAdmin ? 1 : 0);
}

export function isLastAdminViolation(error: unknown) {
  return error instanceof Error && error.message.includes('last_platform_admin');
}

export function isBuiltinRoleViolation(error: unknown) {
  return error instanceof Error && error.message.includes('builtin_role_locked');
}

/** Maps the storage-level rule violations to their API responses; rethrows anything else. */
export function ruleViolationResponse(context: AppContext, error: unknown) {
  if (isLastAdminViolation(error)) {
    return context.json({ error: 'last_platform_admin_required' }, 409);
  }
  if (isBuiltinRoleViolation(error)) return context.json({ error: 'builtin_role_locked' }, 403);
  throw error;
}

/** Validates a client-supplied list of role keys against existing roles. */
export async function resolveRoles(
  env: Env,
  value: unknown,
): Promise<{ ok: true; roles: RoleRecord[] } | { ok: false; error: string }> {
  if (!Array.isArray(value) || value.length > 32 || value.some((key) => typeof key !== 'string')) {
    return { ok: false, error: 'invalid_roles' };
  }
  const keys = [...new Set(value as string[])];
  if (keys.length === 0) return { ok: true, roles: [] };
  const known = new Map((await listRoles(env)).map((role) => [role.key, role]));
  const unknown = keys.filter((key) => !known.has(key));
  if (unknown.length) return { ok: false, error: 'unknown_role' };
  return { ok: true, roles: keys.map((key) => known.get(key) as RoleRecord) };
}

export async function allPermissionKeys(env: Env) {
  return (await listPermissions(env)).map((permission) => permission.key);
}

/** Direct, role and platform-admin provenance for every permission a user holds. */
export type PermissionSource =
  | { type: 'direct' }
  | { type: 'role'; role: string; label: string }
  | { type: 'platform_admin' };

export function permissionSources(input: {
  direct: string[];
  roles: Array<{ key: string; label: string; permissions: string[] }>;
  all: string[];
}) {
  const sources = new Map<string, PermissionSource[]>();
  const add = (key: string, source: PermissionSource) =>
    sources.set(key, [...(sources.get(key) ?? []), source]);
  const holdsAdminDirectly = input.direct.includes(PLATFORM_ADMIN_PERMISSION);
  const holdsAdminViaRole = input.roles.some((role) =>
    role.permissions.includes(PLATFORM_ADMIN_PERMISSION),
  );
  for (const key of input.direct) {
    // The platform.admin trigger copies every permission into direct grants; those copies are
    // the administrator expansion, not independent grants.
    if (holdsAdminDirectly && key !== PLATFORM_ADMIN_PERMISSION) continue;
    add(key, { type: 'direct' });
  }
  for (const role of input.roles) {
    const containsAdmin = role.permissions.includes(PLATFORM_ADMIN_PERMISSION);
    for (const key of role.permissions) {
      // A role holding platform.admin confers the rest through the administrator expansion.
      if (containsAdmin && key !== PLATFORM_ADMIN_PERMISSION) continue;
      add(key, { type: 'role', role: role.key, label: role.label });
    }
  }
  if (holdsAdminDirectly || holdsAdminViaRole) {
    for (const key of input.all) {
      if (key !== PLATFORM_ADMIN_PERMISSION) add(key, { type: 'platform_admin' });
    }
  }
  return sources;
}

/**
 * Removes the direct baseline grants of every user in `userIdsJson` (a JSON array of ids). Run in
 * the same batch as the role assignment, after the audit statement that records what is removed.
 */
export function dropBaselineGrantsStatement(env: Env, userIdsJson: string): SqlStatement {
  return env.DB.prepare(
    `DELETE FROM user_permissions
     WHERE user_id IN (SELECT value FROM json_each(?))
       AND permission_key IN (SELECT value FROM json_each(?))`,
  ).bind(userIdsJson, JSON.stringify(BASELINE_PERMISSIONS));
}

/** True when the user holds at least one role (so roles, not direct grants, decide the baseline). */
export async function userHoldsAnyRole(env: Env, userId: number) {
  const row = await env.DB.prepare('SELECT 1 AS yes FROM user_roles WHERE user_id = ? LIMIT 1')
    .bind(userId)
    .first<{ yes: number }>();
  return Boolean(row?.yes);
}

/** A UNIQUE / PRIMARY KEY violation raised by SQLite or D1. */
export function isUniqueViolation(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed|PRIMARY KEY/i.test(error.message);
}

/** A FOREIGN KEY violation (for example a role deleted between validation and the write). */
export function isForeignKeyViolation(error: unknown) {
  return error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message);
}

/** Raised inside a batch when a concurrent change invalidated a precondition checked earlier. */
export function isRoleInUseViolation(error: unknown) {
  return error instanceof Error && error.message.includes('role_in_use');
}
