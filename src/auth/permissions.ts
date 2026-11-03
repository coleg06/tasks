import type { Env } from '../env';

export const PLATFORM_ADMIN_PERMISSION = 'platform.admin';

/**
 * Effective permissions are the union of a user's direct grants (`user_permissions`) and the
 * permissions of every role they hold (`user_roles` -> `role_permissions`), with `platform.admin`
 * - however it is held - expanding to every permission. The union lives in the
 * `effective_user_permissions` view (migration 0020), which every SQL permission check reads, so
 * sessions, per-request re-authorization and impersonation all see the same answer.
 */
export async function effectivePermissionKeys(env: Env, userId: number) {
  const rows = await env.DB.prepare(
    `SELECT p.key AS permission_key
     FROM permissions p
     WHERE EXISTS (
       SELECT 1 FROM effective_user_permissions e
       WHERE e.user_id = ? AND e.permission_key = p.key
     )
     ORDER BY p.key`,
  )
    .bind(userId)
    .all<{ permission_key: string }>();
  return rows.results.map((row) => row.permission_key);
}

export async function userHasPermission(env: Env, userId: number, permission: string) {
  const row = await env.DB.prepare(
    `SELECT 1 AS allowed FROM effective_user_permissions
     WHERE user_id = ? AND permission_key IN (?, 'platform.admin') LIMIT 1`,
  )
    .bind(userId, permission)
    .first<{ allowed: number }>();
  return Boolean(row?.allowed);
}
