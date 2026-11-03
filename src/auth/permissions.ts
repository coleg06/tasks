import type { Env } from '../env';

export const PLATFORM_ADMIN_PERMISSION = 'platform.admin';

export async function effectivePermissionKeys(env: Env, userId: number) {
  const rows = await env.DB.prepare(
    `SELECT p.key AS permission_key
     FROM permissions p
     WHERE EXISTS (
       SELECT 1 FROM user_permissions direct
       WHERE direct.user_id = ? AND direct.permission_key = p.key
     ) OR EXISTS (
       SELECT 1 FROM user_permissions platform
       WHERE platform.user_id = ? AND platform.permission_key = 'platform.admin'
     )
     ORDER BY p.key`,
  )
    .bind(userId, userId)
    .all<{ permission_key: string }>();
  return rows.results.map((row) => row.permission_key);
}

export async function userHasPermission(env: Env, userId: number, permission: string) {
  const row = await env.DB.prepare(
    `SELECT 1 AS allowed FROM user_permissions
     WHERE user_id = ? AND permission_key IN (?, 'platform.admin') LIMIT 1`,
  )
    .bind(userId, permission)
    .first<{ allowed: number }>();
  return Boolean(row?.allowed);
}
