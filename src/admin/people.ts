import { resolveRuntimeFeatures } from '../../shared/runtime-features';
import { tenantProfile } from '../../shared/tenant-profile';
import { PLATFORM_ADMIN_PERMISSION, userHasPermission } from '../auth/permissions';
import type { Env } from '../env';
import type { SqlStatement } from '../platform/ports';
import { isHostedEmail } from '../runtime/identity-config';
import { auditStatement, requireTasksSession } from '../tasks/api';
import {
  type AppContext,
  activePlatformAdminCount,
  allPermissionKeys,
  BASELINE_PERMISSIONS,
  dropBaselineGrantsStatement,
  grantablePermissions,
  isForeignKeyViolation,
  isUniqueViolation,
  lastPlatformAdminGuard,
  listRoles,
  MANAGE_PERMISSION,
  missingPermissions,
  permissionSources,
  type RoleRecord,
  resolveRoles,
  roleClosure,
  ruleViolationResponse,
} from './rbac';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
export const MAX_BULK_USERS = 100;
export const MAX_BULK_INVITES = 200;

function disabled(context: AppContext) {
  return tenantProfile.tasks.userAdministration ? null : context.json({ error: 'not_found' }, 404);
}

async function readBody(context: AppContext): Promise<Record<string, unknown> | null> {
  try {
    const body = await context.req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function pageSize(raw: string | undefined) {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_PAGE;
  return Math.min(parsed, MAX_PAGE);
}

function encodeCursor(value: unknown) {
  // UTF-8 first: btoa alone throws on any character above U+00FF (an email containing "ł").
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(raw: string | undefined): unknown {
  if (!raw) return null;
  try {
    const padded = raw.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

type DirectoryRow = {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  name: string;
  photo_url: string | null;
  google_subject: string | null;
  status: string;
  last_seen_at: string | null;
  created_at: string;
  principal_type: string;
};

export type DirectoryFilters = {
  status?: string | undefined;
  role?: string | undefined;
  query?: string | undefined;
  cursor?: string | null;
  limit: number;
};

/** Builds the paged directory SQL. Exported so tests can inspect the query plan. */
export function directoryQuery(filters: DirectoryFilters) {
  const conditions: string[] = [];
  const binds: unknown[] = [];
  if (filters.status) {
    conditions.push('u.status = ?');
    binds.push(filters.status);
  }
  if (filters.role) {
    conditions.push(
      'EXISTS (SELECT 1 FROM user_roles fr WHERE fr.user_id = u.id AND fr.role_key = ?)',
    );
    binds.push(filters.role);
  }
  if (filters.query) {
    const like = `%${escapeLike(filters.query)}%`;
    conditions.push(
      `(u.email LIKE ? ESCAPE '\\' OR (u.first_name || ' ' || u.last_name) LIKE ? ESCAPE '\\')`,
    );
    binds.push(like, like);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageWhere = filters.cursor ? `${where ? `${where} AND` : 'WHERE'} u.email > ?` : where;
  return {
    pageSql: `SELECT u.id, u.email, u.first_name, u.last_name, u.photo_url, u.google_subject,
         u.status, u.last_seen_at, u.created_at, u.principal_type,
         COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name
       FROM users u ${pageWhere} ORDER BY u.email LIMIT ?`,
    pageBinds: [...binds, ...(filters.cursor ? [filters.cursor] : []), filters.limit + 1],
    countSql: `SELECT COUNT(*) AS n FROM users u ${where}`,
    countBinds: binds,
  };
}

/**
 * GET /api/admin/directory?q=&status=&role=&limit=&cursor=
 *
 * Server-side search and filters with keyset pagination on the unique email index, so the
 * browser never receives more than one page and the database never sorts the table. `q` matches
 * name or email as a substring; `status` is active|disabled; `role` is a role key.
 */
export async function listDirectory(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, MANAGE_PERMISSION);
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const status = context.req.query('status');
  if (status && status !== 'active' && status !== 'disabled') {
    return context.json({ error: 'invalid_status' }, 400);
  }
  const cursor = decodeCursor(context.req.query('cursor'));
  if (cursor === undefined || (cursor !== null && typeof cursor !== 'string')) {
    return context.json({ error: 'invalid_cursor' }, 400);
  }
  const role = context.req.query('role')?.trim();
  const query = context.req.query('q')?.trim().slice(0, 120);
  const limit = pageSize(context.req.query('limit'));

  const built = directoryQuery({ status, role, query, cursor, limit });
  const [rows, total] = await Promise.all([
    context.env.DB.prepare(built.pageSql)
      .bind(...built.pageBinds)
      .all<DirectoryRow>(),
    context.env.DB.prepare(built.countSql)
      .bind(...built.countBinds)
      .first<{ n: number }>(),
  ]);
  const hasMore = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const ids = JSON.stringify(page.map((row) => row.id));
  const [roleRows, flagRows] = page.length
    ? await Promise.all([
        context.env.DB.prepare(
          `SELECT user_id, role_key FROM user_roles
           WHERE user_id IN (SELECT value FROM json_each(?)) ORDER BY role_key`,
        )
          .bind(ids)
          .all<{ user_id: number; role_key: string }>(),
        context.env.DB.prepare(
          `SELECT user_id, permission_key FROM effective_user_permissions
           WHERE user_id IN (SELECT value FROM json_each(?))
             AND permission_key IN ('platform.admin', 'tasks.manage')`,
        )
          .bind(ids)
          .all<{ user_id: number; permission_key: string }>(),
      ])
    : [{ results: [] }, { results: [] }];
  const rolesByUser = new Map<number, string[]>();
  for (const row of roleRows.results) {
    rolesByUser.set(row.user_id, [...(rolesByUser.get(row.user_id) ?? []), row.role_key]);
  }
  const flags = new Map<number, Set<string>>();
  for (const row of flagRows.results) {
    flags.set(row.user_id, (flags.get(row.user_id) ?? new Set()).add(row.permission_key));
  }
  const last = page.at(-1);
  return context.json({
    users: page.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      name: user.name,
      photoUrl: user.photo_url,
      hasSignedIn: Boolean(user.google_subject),
      status: user.status,
      principalType: user.principal_type,
      lastSeenAt: user.last_seen_at,
      createdAt: user.created_at,
      roles: rolesByUser.get(user.id) ?? [],
      isPlatformAdmin: flags.get(user.id)?.has(PLATFORM_ADMIN_PERMISSION) ?? false,
      isManager: flags.get(user.id)?.has(MANAGE_PERMISSION) ?? false,
    })),
    total: total?.n ?? 0,
    nextCursor: hasMore && last ? encodeCursor(last.email) : null,
  });
}

/** GET /api/admin/users/:userId: roles, grants, provenance and project memberships. */
export async function getAdminUserDetail(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, MANAGE_PERMISSION);
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const userId = Number(context.req.param('userId'));
  if (!Number.isInteger(userId) || userId < 1) return context.json({ error: 'invalid_user' }, 400);
  const user = await context.env.DB.prepare(
    `SELECT id, email, first_name, last_name, photo_url, google_subject, status, last_seen_at,
       created_at, principal_type,
       COALESCE(NULLIF(TRIM(first_name || ' ' || last_name), ''), email) AS name
     FROM users WHERE id = ?`,
  )
    .bind(userId)
    .first<DirectoryRow>();
  if (!user) return context.json({ error: 'not_found' }, 404);
  const [directRows, assigned, roleGrantRows, memberships, catalog, all] = await Promise.all([
    context.env.DB.prepare(
      'SELECT permission_key FROM user_permissions WHERE user_id = ? ORDER BY permission_key',
    )
      .bind(userId)
      .all<{ permission_key: string }>(),
    context.env.DB.prepare(
      `SELECT ur.role_key, r.label, ur.granted_at,
         ur.granted_by, COALESCE(NULLIF(TRIM(g.first_name || ' ' || g.last_name), ''), g.email) AS granted_by_name
       FROM user_roles ur JOIN roles r ON r.key = ur.role_key
       LEFT JOIN users g ON g.id = ur.granted_by
       WHERE ur.user_id = ? ORDER BY r.label COLLATE NOCASE`,
    )
      .bind(userId)
      .all<{
        role_key: string;
        label: string;
        granted_at: string;
        granted_by: number | null;
        granted_by_name: string | null;
      }>(),
    context.env.DB.prepare(
      `SELECT rp.role_key, rp.permission_key FROM role_permissions rp
       WHERE rp.role_key IN (SELECT role_key FROM user_roles WHERE user_id = ?)`,
    )
      .bind(userId)
      .all<{ role_key: string; permission_key: string }>(),
    context.env.DB.prepare(
      `SELECT p.project_key, p.name, pm.role
       FROM project_members pm JOIN projects p ON p.id = pm.project_id
       WHERE pm.user_id = ? AND p.archived_at IS NULL AND p.project_type = 'shared'
       ORDER BY p.name`,
    )
      .bind(userId)
      .all<{ project_key: string; name: string; role: string }>(),
    context.env.DB.prepare('SELECT key, label, description FROM permissions').all<{
      key: string;
      label: string;
      description: string;
    }>(),
    allPermissionKeys(context.env),
  ]);
  const roleLabels = new Map(assigned.results.map((row) => [row.role_key, row.label]));
  const grantsByRole = new Map<string, string[]>();
  for (const row of roleGrantRows.results) {
    grantsByRole.set(row.role_key, [...(grantsByRole.get(row.role_key) ?? []), row.permission_key]);
  }
  const direct = directRows.results.map((row) => row.permission_key);
  const sources = permissionSources({
    direct,
    roles: [...grantsByRole.entries()].map(([key, permissions]) => ({
      key,
      label: roleLabels.get(key) ?? key,
      permissions,
    })),
    all,
  });
  const catalogByKey = new Map(catalog.results.map((row) => [row.key, row]));
  const effective = [...sources.keys()].sort().map((key) => ({
    key,
    label: catalogByKey.get(key)?.label ?? key,
    sources: sources.get(key) ?? [],
  }));
  return context.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      name: user.name,
      photoUrl: user.photo_url,
      hasSignedIn: Boolean(user.google_subject),
      status: user.status,
      principalType: user.principal_type,
      // Recorded when the person signs in; null until they first do.
      lastSeenAt: user.last_seen_at,
      createdAt: user.created_at,
    },
    roles: assigned.results.map((row) => ({
      key: row.role_key,
      label: row.label,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by ? { id: row.granted_by, name: row.granted_by_name } : null,
    })),
    directPermissions: direct.filter(
      // Hide the administrator expansion copies; they are not independent grants.
      (key) => !direct.includes(PLATFORM_ADMIN_PERMISSION) || key === PLATFORM_ADMIN_PERMISSION,
    ),
    effectivePermissions: effective,
    isPlatformAdmin: sources.has(PLATFORM_ADMIN_PERMISSION),
    projects: memberships.results.map((row) => ({
      key: row.project_key,
      name: row.name,
      role: row.role,
    })),
  });
}

type Target = { id: number; email: string; status: string; principal_type: string };

async function loadTargets(env: Env, ids: number[]) {
  const rows = await env.DB.prepare(
    `SELECT id, email, status, principal_type FROM users
     WHERE id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<Target>();
  return rows.results;
}

async function adminTargetIds(env: Env, ids: number[]) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT user_id FROM effective_user_permissions
     WHERE permission_key = 'platform.admin' AND user_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ user_id: number }>();
  return new Set(rows.results.map((row) => row.user_id));
}

async function rolesByUser(env: Env, ids: number[]) {
  const rows = await env.DB.prepare(
    `SELECT user_id, role_key FROM user_roles
     WHERE user_id IN (SELECT value FROM json_each(?)) ORDER BY role_key`,
  )
    .bind(JSON.stringify(ids))
    .all<{ user_id: number; role_key: string }>();
  const map = new Map<number, string[]>();
  for (const row of rows.results) {
    map.set(row.user_id, [...(map.get(row.user_id) ?? []), row.role_key]);
  }
  return map;
}

/** Permissions the user would hold after the change, for the "do not lock yourself out" rule. */
function permissionsAfter(direct: string[], roles: RoleRecord[], all: string[]): Set<string> {
  const held = new Set(direct);
  for (const role of roles) for (const key of roleClosure(role, all)) held.add(key);
  if (held.has(PLATFORM_ADMIN_PERMISSION)) for (const key of all) held.add(key);
  return held;
}

type BulkAction = 'add_roles' | 'remove_roles' | 'set_roles' | 'disable' | 'enable';
const BULK_ACTIONS: readonly string[] = [
  'add_roles',
  'remove_roles',
  'set_roles',
  'disable',
  'enable',
];

/**
 * Applies one action to many users, or to one user (`PUT /api/admin/users/:id/roles`). Every
 * target is validated against every rule first; if any target violates one, nothing is written.
 * The writes then run as a single batch that ends with the last-administrator guard.
 */
async function applyUserChange(
  context: AppContext,
  identity: NonNullable<Awaited<ReturnType<typeof requireTasksSession>>>,
  action: BulkAction,
  userIds: number[],
  roleKeys: string[],
) {
  const [targets, roles, all, grantable, actorIsAdmin] = await Promise.all([
    loadTargets(context.env, userIds),
    listRoles(context.env),
    allPermissionKeys(context.env),
    grantablePermissions(context.env, identity.user.id),
    userHasPermission(context.env, identity.user.id, PLATFORM_ADMIN_PERMISSION),
  ]);
  const byId = new Map(targets.map((target) => [target.id, target]));
  const missingUsers = userIds.filter((id) => !byId.has(id));
  if (missingUsers.length) return context.json({ error: 'not_found', userIds: missingUsers }, 404);

  const roleByKey = new Map(roles.map((role) => [role.key, role]));
  const requested = roleKeys.map((key) => roleByKey.get(key));
  if (requested.some((role) => !role)) return context.json({ error: 'unknown_role' }, 400);
  const chosen = requested as RoleRecord[];
  const roleAction = action !== 'disable' && action !== 'enable';

  // Rule: nobody grants or removes a role containing permissions they do not hold.
  if (roleAction) {
    for (const role of chosen) {
      const missing = missingPermissions(grantable, roleClosure(role, all));
      if (missing.length) {
        return context.json({ error: 'role_exceeds_permissions', role: role.key, missing }, 403);
      }
    }
  }

  const [admins, before] = await Promise.all([
    adminTargetIds(context.env, userIds),
    rolesByUser(context.env, userIds),
  ]);
  const failures: Array<{ userId: number; error: string }> = [];
  for (const target of targets) {
    // Rule: task managers cannot modify platform administrators.
    if (admins.has(target.id) && !actorIsAdmin) {
      failures.push({ userId: target.id, error: 'platform_admin_required' });
    } else if (target.principal_type === 'agent') {
      failures.push({ userId: target.id, error: 'agent_principal_protected' });
    } else if (target.id === identity.user.id && action === 'disable') {
      failures.push({ userId: target.id, error: 'cannot_remove_own_admin_access' });
    }
  }
  const nextRoleKeys = new Map<number, string[]>();
  if (roleAction) {
    for (const target of targets) {
      const current = before.get(target.id) ?? [];
      const next =
        action === 'add_roles'
          ? [...new Set([...current, ...chosen.map((role) => role.key)])]
          : action === 'remove_roles'
            ? current.filter((key) => !chosen.some((role) => role.key === key))
            : chosen.map((role) => role.key);
      // set_roles / remove_roles also release roles the actor may not hold.
      const released = current.filter((key) => !next.includes(key));
      for (const key of released) {
        const role = roleByKey.get(key);
        if (role && missingPermissions(grantable, roleClosure(role, all)).length) {
          failures.push({ userId: target.id, error: 'role_exceeds_permissions' });
        }
      }
      nextRoleKeys.set(target.id, next.sort());
    }
    // Rule: never lock yourself out of administration.
    if (byId.has(identity.user.id)) {
      const direct = await context.env.DB.prepare(
        'SELECT permission_key FROM user_permissions WHERE user_id = ?',
      )
        .bind(identity.user.id)
        .all<{ permission_key: string }>();
      const after = permissionsAfter(
        direct.results.map((row) => row.permission_key),
        (nextRoleKeys.get(identity.user.id) ?? []).map((key) => roleByKey.get(key) as RoleRecord),
        all,
      );
      if (!after.has(MANAGE_PERMISSION) && !after.has(PLATFORM_ADMIN_PERMISSION)) {
        failures.push({ userId: identity.user.id, error: 'cannot_remove_own_admin_access' });
      }
    }
  }
  if (failures.length) {
    const status = failures.some((failure) => failure.error === 'platform_admin_required')
      ? 403
      : 400;
    return context.json({ error: failures[0]?.error, failures }, status);
  }

  const hadAdmin = (await activePlatformAdminCount(context.env)) > 0;
  const idsJson = JSON.stringify(userIds);
  const statements: SqlStatement[] = [];
  const auditAction = roleAction ? 'user.roles_updated' : 'user.access_updated';
  let changed = 0;
  if (roleAction) {
    const rolesJson = JSON.stringify(chosen.map((role) => role.key));
    if (action === 'add_roles' || action === 'set_roles') {
      statements.push(
        context.env.DB.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role_key, granted_by)
           SELECT u.value, r.value, ? FROM json_each(?) u CROSS JOIN json_each(?) r`,
        ).bind(identity.auditUserId, idsJson, rolesJson),
      );
    }
    if (action === 'remove_roles') {
      statements.push(
        context.env.DB.prepare(
          `DELETE FROM user_roles WHERE user_id IN (SELECT value FROM json_each(?))
             AND role_key IN (SELECT value FROM json_each(?))`,
        ).bind(idsJson, rolesJson),
      );
    }
    if (action === 'set_roles') {
      statements.push(
        context.env.DB.prepare(
          `DELETE FROM user_roles WHERE user_id IN (SELECT value FROM json_each(?))
             AND role_key NOT IN (SELECT value FROM json_each(?))`,
        ).bind(idsJson, rolesJson),
      );
    }
  } else {
    const next = action === 'disable' ? 'disabled' : 'active';
    statements.push(
      context.env.DB.prepare(
        `UPDATE users SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id IN (SELECT value FROM json_each(?)) AND status <> ?`,
      ).bind(next, idsJson, next),
    );
  }
  const withoutRoles: number[] = [];
  const baselineDropIds: number[] = [];
  const requestId = context.get('requestId') ?? crypto.randomUUID();
  for (const target of targets) {
    if (roleAction) {
      const beforeRoles = before.get(target.id) ?? [];
      const afterRoles = nextRoleKeys.get(target.id) ?? [];
      if (beforeRoles.join() === afterRoles.join()) continue;
      changed += 1;
      if (afterRoles.length === 0) withoutRoles.push(target.id);
      // From the moment a user holds a role, the roles alone decide the baseline permissions:
      // their direct grants of them are removed in this same batch (and audited below).
      const dropsBaseline = afterRoles.length > 0;
      if (dropsBaseline) baselineDropIds.push(target.id);
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO audit_events (
             actor_user_id, entity_type, entity_key, action, changes_json, request_id
           ) SELECT ?, 'user', ?, ?,
             json_object('before', json(?), 'after', json(?)${
               dropsBaseline
                 ? `, 'removedDirectGrants', json((
               SELECT json_group_array(permission_key) FROM (
                 SELECT permission_key FROM user_permissions
                 WHERE user_id = ? AND permission_key IN (SELECT value FROM json_each(?))
                 ORDER BY permission_key)))`
                 : ''
}),
             ?`,
        ).bind(
          identity.auditUserId,
          target.email,
          auditAction,
          JSON.stringify({ roles: beforeRoles }),
          JSON.stringify({ roles: afterRoles }),
          ...(dropsBaseline ? [target.id, JSON.stringify(BASELINE_PERMISSIONS)] : []),
          requestId,
        ),
      );
    } else {
      const next = action === 'disable' ? 'disabled' : 'active';
      if (target.status === next) continue;
      changed += 1;
      statements.push(
        auditStatement(context, identity.auditUserId, 'user', target.email, auditAction, {
          before: { status: target.status },
          after: { status: next },
        }),
      );
    }
  }
  if (baselineDropIds.length) {
    statements.push(dropBaselineGrantsStatement(context.env, JSON.stringify(baselineDropIds)));
  }
  statements.push(lastPlatformAdminGuard(context.env, hadAdmin));
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    // A role deleted between validation and the write.
    if (isForeignKeyViolation(error)) return context.json({ error: 'role_changed' }, 409);
    return ruleViolationResponse(context, error);
  }
  return context.json({
    ok: true,
    changed,
    unchanged: targets.length - changed,
    // Users whose last role was just removed: they keep only their remaining direct grants.
    withoutRoles,
  });
}

/** PUT /api/admin/users/:userId/roles with `{ roles: string[] }` replaces the user's roles. */
export async function setAdminUserRoles(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, MANAGE_PERMISSION);
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const userId = Number(context.req.param('userId'));
  if (!Number.isInteger(userId) || userId < 1) return context.json({ error: 'invalid_user' }, 400);
  const body = await readBody(context);
  if (!body) return context.json({ error: 'invalid_body' }, 400);
  const resolved = await resolveRoles(context.env, body.roles);
  if (!resolved.ok) return context.json({ error: resolved.error }, 400);
  return applyUserChange(
    context,
    identity,
    'set_roles',
    [userId],
    resolved.roles.map((role) => role.key),
  );
}

/** POST /api/admin/users/bulk with `{ action, userIds, roles? }`. */
export async function bulkAdminUsers(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, MANAGE_PERMISSION);
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const body = await readBody(context);
  if (!body) return context.json({ error: 'invalid_body' }, 400);
  const action = body.action;
  if (typeof action !== 'string' || !BULK_ACTIONS.includes(action)) {
    return context.json({ error: 'invalid_action' }, 400);
  }
  const ids = body.userIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_BULK_USERS ||
    ids.some((id) => !Number.isInteger(id) || id < 1)
  ) {
    return context.json({ error: 'invalid_users', max: MAX_BULK_USERS }, 400);
  }
  const roleAction = action !== 'disable' && action !== 'enable';
  let roleKeys: string[] = [];
  if (roleAction) {
    const resolved = await resolveRoles(context.env, body.roles);
    if (!resolved.ok) return context.json({ error: resolved.error }, 400);
    if (resolved.roles.length === 0 && action !== 'set_roles') {
      return context.json({ error: 'invalid_roles' }, 400);
    }
    roleKeys = resolved.roles.map((role) => role.key);
  }
  return applyUserChange(
    context,
    identity,
    action as BulkAction,
    [...new Set(ids as number[])],
    roleKeys,
  );
}

function bulkInviteBaseline(env: Env) {
  const baseline = ['tasks.personal', 'tasks.comment'];
  if (resolveRuntimeFeatures(env.FEATURE_MODULES).events)
    baseline.push('events.view', 'events.create');
  return baseline;
}

export type InviteRow = {
  index: number;
  email: string;
  firstName: string;
  lastName: string;
  status: 'ok' | 'invalid_email' | 'duplicate' | 'exists';
};

/**
 * POST /api/admin/users/bulk-invite with `{ entries: [{email, firstName?, lastName?}], roles?,
 * dryRun? }`. A dry run reports what each row would do. A real run is all-or-nothing: unless
 * every row is valid nothing is written (the caller sends only the valid rows).
 */
export async function bulkInviteAdminUsers(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, MANAGE_PERMISSION);
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const body = await readBody(context);
  if (!body) return context.json({ error: 'invalid_body' }, 400);
  const entries = body.entries;
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_BULK_INVITES) {
    return context.json({ error: 'invalid_entries', max: MAX_BULK_INVITES }, 400);
  }
  const resolved = await resolveRoles(context.env, body.roles ?? []);
  if (!resolved.ok) return context.json({ error: resolved.error }, 400);
  const [all, grantable] = await Promise.all([
    allPermissionKeys(context.env),
    grantablePermissions(context.env, identity.user.id),
  ]);
  for (const role of resolved.roles) {
    const missing = missingPermissions(grantable, roleClosure(role, all));
    if (missing.length) {
      return context.json({ error: 'role_exceeds_permissions', role: role.key, missing }, 403);
    }
  }
  // Without roles a new person gets the baseline as direct grants, so the inviter must be allowed
  // to hand those out (the same rule as roles). With roles, the roles decide the baseline and the
  // creation trigger's direct grants are removed in the same batch.
  const hasRoles = resolved.roles.length > 0;
  const baseline = hasRoles ? [] : bulkInviteBaseline(context.env);
  const missingBaseline = missingPermissions(grantable, baseline);
  if (missingBaseline.length) {
    return context.json({ error: 'role_exceeds_permissions', missing: missingBaseline }, 403);
  }
  const seen = new Set<string>();
  const rows: InviteRow[] = entries.map((entry, index) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
    const firstName =
      typeof record.firstName === 'string' ? record.firstName.trim().slice(0, 120) : '';
    const lastName =
      typeof record.lastName === 'string' ? record.lastName.trim().slice(0, 120) : '';
    let status: InviteRow['status'] = 'ok';
    if (!email || email.length > 254 || !isHostedEmail(context.env, email)) {
      status = 'invalid_email';
    } else if (seen.has(email)) {
      status = 'duplicate';
    }
    seen.add(email);
    return { index, email, firstName, lastName, status };
  });
  const candidates = rows.filter((row) => row.status === 'ok').map((row) => row.email);
  if (candidates.length) {
    const existing = await context.env.DB.prepare(
      'SELECT email FROM users WHERE email IN (SELECT value FROM json_each(?))',
    )
      .bind(JSON.stringify(candidates))
      .all<{ email: string }>();
    const taken = new Set(existing.results.map((row) => row.email.toLowerCase()));
    for (const row of rows) if (row.status === 'ok' && taken.has(row.email)) row.status = 'exists';
  }
  const valid = rows.filter((row) => row.status === 'ok');
  if (body.dryRun === true) return context.json({ rows, valid: valid.length });
  if (valid.length !== rows.length) {
    return context.json({ error: 'invalid_entries', rows, valid: valid.length }, 422);
  }
  const eventsEnabled = resolveRuntimeFeatures(context.env.FEATURE_MODULES).events;
  const emailsJson = JSON.stringify(valid.map((row) => row.email));
  const rolesJson = JSON.stringify(resolved.roles.map((role) => role.key));
  const requestId = context.get('requestId') ?? crypto.randomUUID();
  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO users (email, first_name, last_name)
       SELECT json_extract(value, '$.email'), json_extract(value, '$.firstName'),
         json_extract(value, '$.lastName')
       FROM json_each(?)`,
    ).bind(
      JSON.stringify(
        valid.map((row) => ({
          email: row.email,
          firstName: row.firstName,
          lastName: row.lastName,
        })),
      ),
    ),
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
       SELECT w.id, u.id, 'member' FROM workspaces w
       JOIN users u ON u.email IN (SELECT value FROM json_each(?))
       WHERE w.workspace_key = ?`,
    ).bind(emailsJson, tenantProfile.workspaceKey),
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
       SELECT u.id, k.value FROM users u JOIN json_each(?) k
       WHERE u.email IN (SELECT value FROM json_each(?))`,
    ).bind(JSON.stringify(baseline), emailsJson),
  ];
  if (resolved.roles.length) {
    statements.push(
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role_key, granted_by)
         SELECT u.id, r.value, ? FROM users u JOIN json_each(?) r
         WHERE u.email IN (SELECT value FROM json_each(?))`,
      ).bind(identity.auditUserId, rolesJson, emailsJson),
      // The creation trigger gave each new user the direct baseline grants; the roles replace them.
      context.env.DB.prepare(
        `DELETE FROM user_permissions
         WHERE user_id IN (SELECT id FROM users WHERE email IN (SELECT value FROM json_each(?)))
           AND permission_key IN (SELECT value FROM json_each(?))`,
      ).bind(emailsJson, JSON.stringify(BASELINE_PERMISSIONS)),
    );
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO audit_events (
         actor_user_id, entity_type, entity_key, action, changes_json, request_id
       ) SELECT ?, 'user', u.email, 'user.invited',
         json_object('firstName', u.first_name, 'lastName', u.last_name,
           'permissions', json(?), 'roles', json(?), 'bulk', 1),
         ?
       FROM users u WHERE u.email IN (SELECT value FROM json_each(?))`,
    ).bind(identity.auditUserId, JSON.stringify(baseline), rolesJson, requestId, emailsJson),
  );
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    // Someone else created one of these people (or deleted a chosen role) after the checks above;
    // the batch is a transaction, so nothing was written.
    if (isUniqueViolation(error)) return context.json({ error: 'user_exists' }, 409);
    if (isForeignKeyViolation(error)) return context.json({ error: 'role_changed' }, 409);
    throw error;
  }
  const created = await context.env.DB.prepare(
    'SELECT id, email FROM users WHERE email IN (SELECT value FROM json_each(?)) ORDER BY email',
  )
    .bind(emailsJson)
    .all<{ id: number; email: string }>();
  return context.json(
    {
      created: created.results.length,
      users: created.results,
      signInPath: eventsEnabled ? '/auth/login?returnTo=%2Fevents' : '/auth/login?returnTo=%2F',
    },
    201,
  );
}
