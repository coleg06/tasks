import { resolveRuntimeFeatures } from '../../shared/runtime-features';
import { tenantProfile } from '../../shared/tenant-profile';
import { PLATFORM_ADMIN_PERMISSION, userHasPermission } from '../auth/permissions';
import type { SqlStatement } from '../platform/ports';
import { auditStatement, requireTasksSession } from '../tasks/api';
import {
  type AppContext,
  activePlatformAdminCount,
  allPermissionKeys,
  grantablePermissions,
  groupPermissions,
  isForeignKeyViolation,
  isRoleInUseViolation,
  isUniqueViolation,
  lastPlatformAdminGuard,
  listPermissions,
  listRoles,
  missingPermissions,
  type RoleRecord,
  roleClosure,
  ruleViolationResponse,
} from './rbac';

const ROLE_KEY = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 300;

function disabled(context: AppContext) {
  return tenantProfile.tasks.userAdministration ? null : context.json({ error: 'not_found' }, 404);
}

function slugify(label: string) {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
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

function roleSnapshot(role: Pick<RoleRecord, 'label' | 'description' | 'permissions'>) {
  return { label: role.label, description: role.description, permissions: [...role.permissions] };
}

/** GET /api/admin/roles: every role plus the permission catalogue grouped by area. */
export async function listAdminRoles(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const eventsEnabled = resolveRuntimeFeatures(context.env.FEATURE_MODULES).events;
  const [roles, permissions, grantable, canManage, all] = await Promise.all([
    listRoles(context.env),
    listPermissions(context.env, eventsEnabled),
    grantablePermissions(context.env, identity.user.id),
    userHasPermission(context.env, identity.user.id, PLATFORM_ADMIN_PERMISSION),
    allPermissionKeys(context.env),
  ]);
  return context.json({
    roles: roles.map((role) => ({
      ...role,
      // Whether the signed-in administrator may assign this role (the subset rule).
      assignable: missingPermissions(grantable, roleClosure(role, all)).length === 0,
    })),
    catalog: groupPermissions(permissions),
    canManageRoles: canManage,
  });
}

type RoleInput = {
  label: string;
  description: string;
  permissions: string[];
  key?: string;
};

async function parseRoleInput(
  context: AppContext,
  body: Record<string, unknown>,
  partial: boolean,
): Promise<{ input: Partial<RoleInput> } | { response: Response }> {
  const bad = (error: string) => ({ response: context.json({ error }, 400) });
  const input: Partial<RoleInput> = {};
  if (body.label !== undefined || !partial) {
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > MAX_LABEL) return bad('invalid_label');
    input.label = label;
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION) {
      return bad('invalid_description');
    }
    input.description = body.description.trim();
  }
  if (body.permissions !== undefined || !partial) {
    if (
      !Array.isArray(body.permissions) ||
      body.permissions.length > 64 ||
      body.permissions.some((key) => typeof key !== 'string')
    ) {
      return bad('invalid_permissions');
    }
    const permissions = [...new Set(body.permissions as string[])].sort();
    if (permissions.length === 0) return bad('invalid_permissions');
    const known = new Set(await allPermissionKeys(context.env));
    if (permissions.some((key) => !known.has(key))) return bad('unknown_permission');
    input.permissions = permissions;
  }
  if (body.key !== undefined) {
    if (typeof body.key !== 'string' || !ROLE_KEY.test(body.key)) return bad('invalid_role_key');
    input.key = body.key;
  }
  return { input };
}

function permissionStatements(
  context: AppContext,
  roleKey: string,
  permissions: string[],
  replace: boolean,
) {
  const statements: SqlStatement[] = [];
  if (replace) {
    statements.push(
      context.env.DB.prepare(
        `DELETE FROM role_permissions WHERE role_key = ?
           AND permission_key NOT IN (SELECT value FROM json_each(?))`,
      ).bind(roleKey, JSON.stringify(permissions)),
    );
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO role_permissions (role_key, permission_key)
       SELECT ?, value FROM json_each(?)`,
    ).bind(roleKey, JSON.stringify(permissions)),
  );
  return statements;
}

/** POST /api/admin/roles (platform administrators only). */
export async function createAdminRole(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  if (!(await userHasPermission(context.env, identity.user.id, PLATFORM_ADMIN_PERMISSION))) {
    return context.json({ error: 'platform_admin_required' }, 403);
  }
  const body = await readBody(context);
  if (!body) return context.json({ error: 'invalid_body' }, 400);
  const parsed = await parseRoleInput(context, body, false);
  if ('response' in parsed) return parsed.response;
  const { label, permissions } = parsed.input as RoleInput;
  const description = parsed.input.description ?? '';
  const [grantable, all] = await Promise.all([
    grantablePermissions(context.env, identity.user.id),
    allPermissionKeys(context.env),
  ]);
  const needed = permissions.includes(PLATFORM_ADMIN_PERMISSION) ? all : permissions;
  const missing = missingPermissions(grantable, needed);
  if (missing.length) return context.json({ error: 'role_exceeds_permissions', missing }, 403);
  const existing = new Set((await listRoles(context.env)).map((role) => role.key));
  let key = parsed.input.key ?? (slugify(label) || 'role');
  if (parsed.input.key && existing.has(key)) return context.json({ error: 'role_exists' }, 409);
  if (!ROLE_KEY.test(key)) key = `role-${key}`.slice(0, 64);
  if (!parsed.input.key) {
    const base = key;
    for (let n = 2; existing.has(key); n += 1) key = `${base}-${n}`.slice(0, 64);
  }
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        'INSERT INTO roles (key, label, description, builtin) VALUES (?, ?, ?, 0)',
      ).bind(key, label, description),
      ...permissionStatements(context, key, permissions, false),
      auditStatement(context, identity.auditUserId, 'system', `role:${key}`, 'role.created', {
        before: null,
        after: roleSnapshot({ label, description, permissions }),
      }),
    ]);
  } catch (error) {
    // Two administrators creating the same role key at once: the loser gets a conflict, and the
    // batch (a transaction) leaves no partial role or audit row behind.
    if (isUniqueViolation(error)) return context.json({ error: 'role_exists' }, 409);
    throw error;
  }
  const role = (await listRoles(context.env)).find((candidate) => candidate.key === key);
  return context.json({ role }, 201);
}

/** PATCH /api/admin/roles/:key (platform administrators only; built-ins are fixed). */
export async function updateAdminRole(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  if (!(await userHasPermission(context.env, identity.user.id, PLATFORM_ADMIN_PERMISSION))) {
    return context.json({ error: 'platform_admin_required' }, 403);
  }
  const key = context.req.param('roleKey') ?? '';
  const [roles, all] = await Promise.all([listRoles(context.env), allPermissionKeys(context.env)]);
  const role = roles.find((candidate) => candidate.key === key);
  if (!role) return context.json({ error: 'not_found' }, 404);
  if (role.builtin) return context.json({ error: 'builtin_role_locked' }, 403);
  const body = await readBody(context);
  if (!body) return context.json({ error: 'invalid_body' }, 400);
  const parsed = await parseRoleInput(context, body, true);
  if ('response' in parsed) return parsed.response;
  const next = {
    label: parsed.input.label ?? role.label,
    description: parsed.input.description ?? role.description,
    permissions: parsed.input.permissions ?? role.permissions,
  };
  // The editor must hold everything the role will contain and everything it contained.
  const grantable = await grantablePermissions(context.env, identity.user.id);
  const touched = [
    ...roleClosure(role, all),
    ...(next.permissions.includes(PLATFORM_ADMIN_PERMISSION) ? all : next.permissions),
  ];
  const missing = missingPermissions(grantable, touched);
  if (missing.length) return context.json({ error: 'role_exceeds_permissions', missing }, 403);
  const hadAdmin = (await activePlatformAdminCount(context.env)) > 0;
  try {
    await context.env.DB.batch([
      context.env.DB.prepare(
        `UPDATE roles SET label = ?, description = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE key = ?`,
      ).bind(next.label, next.description, key),
      ...permissionStatements(context, key, next.permissions, true),
      auditStatement(context, identity.auditUserId, 'system', `role:${key}`, 'role.updated', {
        before: roleSnapshot(role),
        after: roleSnapshot(next),
      }),
      lastPlatformAdminGuard(context.env, hadAdmin),
    ]);
  } catch (error) {
    return ruleViolationResponse(context, error);
  }
  const updated = (await listRoles(context.env)).find((candidate) => candidate.key === key);
  return context.json({ role: updated });
}

/**
 * DELETE /api/admin/roles/:key?replacement=:otherKey (platform administrators only). A role that
 * is still assigned can only be deleted by naming a replacement, which its holders receive.
 */
export async function deleteAdminRole(context: AppContext) {
  const gate = disabled(context);
  if (gate) return gate;
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  if (!(await userHasPermission(context.env, identity.user.id, PLATFORM_ADMIN_PERMISSION))) {
    return context.json({ error: 'platform_admin_required' }, 403);
  }
  const key = context.req.param('roleKey') ?? '';
  const [roles, all] = await Promise.all([listRoles(context.env), allPermissionKeys(context.env)]);
  const role = roles.find((candidate) => candidate.key === key);
  if (!role) return context.json({ error: 'not_found' }, 404);
  if (role.builtin) return context.json({ error: 'builtin_role_locked' }, 403);
  const replacementKey = context.req.query('replacement') ?? '';
  let replacement = replacementKey
    ? roles.find((candidate) => candidate.key === replacementKey)
    : undefined;
  if (role.userCount > 0) {
    if (!replacementKey) {
      return context.json({ error: 'role_in_use', userCount: role.userCount }, 409);
    }
    if (!replacement || replacement.key === key) {
      return context.json({ error: 'invalid_replacement' }, 400);
    }
  } else if (replacement?.key === key) {
    replacement = undefined;
  }
  if (replacement) {
    // Also applies when nobody holds the role yet: assignments added before the batch runs are
    // reassigned to the replacement, so the actor must be allowed to hand it out.
    const missing = missingPermissions(await grantablePermissions(context.env, identity.user.id), [
      ...roleClosure(replacement, all),
      ...roleClosure(role, all),
    ]);
    if (missing.length) return context.json({ error: 'role_exceeds_permissions', missing }, 403);
  }
  const hadAdmin = (await activePlatformAdminCount(context.env)) > 0;
  const requestId = context.get('requestId') ?? crypto.randomUUID();
  // The count above can be stale by the time the batch runs. Without a replacement the batch must
  // fail (409) if anyone holds the role by then, instead of silently dropping their assignments.
  // With a replacement, the audit and reassignment statements read the assignments at batch time,
  // so assignments added after the count are reassigned and audited too.
  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO role_delete_guard (ok)
       SELECT CASE WHEN ? = 0 AND EXISTS (SELECT 1 FROM user_roles WHERE role_key = ?)
         THEN 0 ELSE 1 END`,
    ).bind(replacement ? 1 : 0, key),
  ];
  if (replacement) {
    statements.push(
      // One audit event per affected user, written before their assignments change.
      context.env.DB.prepare(
        `INSERT INTO audit_events (
           actor_user_id, entity_type, entity_key, action, changes_json, request_id
         ) SELECT ?, 'user', u.email, 'user.roles_updated',
           json_object(
             'reason', 'role_deleted',
             'before', json_object('roles', json((
               SELECT json_group_array(role_key) FROM user_roles WHERE user_id = u.id))),
             'removed', json_array(?), 'added', json_array(?)),
           ?
         FROM user_roles ur JOIN users u ON u.id = ur.user_id WHERE ur.role_key = ?`,
      ).bind(identity.auditUserId, key, replacement.key, requestId, key),
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role_key, granted_by)
         SELECT user_id, ?, ? FROM user_roles WHERE role_key = ?`,
      ).bind(replacement.key, identity.auditUserId, key),
    );
  }
  statements.push(
    context.env.DB.prepare('DELETE FROM user_roles WHERE role_key = ?').bind(key),
    context.env.DB.prepare('DELETE FROM role_permissions WHERE role_key = ?').bind(key),
    context.env.DB.prepare('DELETE FROM roles WHERE key = ?').bind(key),
    auditStatement(context, identity.auditUserId, 'system', `role:${key}`, 'role.deleted', {
      before: roleSnapshot(role),
      after: null,
      replacement: replacement?.key ?? null,
      reassignedUsers: role.userCount,
    }),
    lastPlatformAdminGuard(context.env, hadAdmin),
  );
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    if (isRoleInUseViolation(error)) return context.json({ error: 'role_in_use' }, 409);
    // The replacement role was deleted concurrently.
    if (isForeignKeyViolation(error)) return context.json({ error: 'invalid_replacement' }, 409);
    return ruleViolationResponse(context, error);
  }
  return context.json({ ok: true, reassignedUsers: role.userCount });
}
