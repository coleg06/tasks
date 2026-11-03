import type { Env } from '../env';
import { effectivePermissionKeys } from './permissions';
import type { SessionClaims } from './session';

/**
 * A session carrying `act` is an impersonation. It is re-authorized on every request against
 * current database state, not just at issuance: the actor must still exist, be active and hold
 * `tasks.manage`, and the target's current effective permissions must be a subset of the actor's
 * current ones. Anything else fails closed. Sessions without `act` return true.
 */
export async function impersonationStillAuthorized(
  env: Env,
  session: SessionClaims,
  targetUserId: number,
): Promise<boolean> {
  if (!session.act) return true;
  const actorId = Number(session.act.sub);
  if (!Number.isInteger(actorId) || actorId < 1 || actorId === targetUserId) return false;
  const actor = await env.DB.prepare('SELECT id, status FROM users WHERE id = ?')
    .bind(actorId)
    .first<{ id: number; status: string }>();
  if (actor?.status !== 'active') return false;
  const actorPermissions = await effectivePermissionKeys(env, actorId);
  if (!actorPermissions.includes('tasks.manage')) return false;
  const granted = new Set(actorPermissions);
  const targetPermissions = await effectivePermissionKeys(env, targetUserId);
  return targetPermissions.every((permission) => granted.has(permission));
}
