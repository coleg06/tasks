import type { TaskPrincipal } from '../../shared/task-domain';
import { tenantProfile } from '../../shared/tenant-profile';
import type { TaskIdentity } from '../app-env';
import { impersonationStillAuthorized } from '../auth/impersonation';
import { effectivePermissionKeys } from '../auth/permissions';
import { verifySession } from '../auth/session';
import type { IdentityProvider, ResolvedIdentity } from '../core/contracts';
import type { Env } from '../env';

export type SessionIdentityEvidence =
  | {
      readonly kind: 'browser';
      readonly token: string;
      readonly permission: string;
    }
  | {
      readonly kind: 'trusted';
      readonly identity: TaskIdentity;
      readonly permission: string;
    };

export type SessionResolvedIdentity = ResolvedIdentity & {
  /** Compatibility value consumed by handlers during the service extraction. */
  readonly taskIdentity: TaskIdentity;
};

function principalFor(user: { id: number; email: string }): TaskPrincipal {
  const email = user.email.trim();
  return {
    reference: `user:${user.id}`,
    kind: email.toLowerCase() === tenantProfile.agent.email.toLowerCase() ? 'agent' : 'human',
    name: email,
    email,
  };
}

function auditPrincipalFor(identity: TaskIdentity): TaskPrincipal | undefined {
  if (identity.auditUserId === identity.user.id) return undefined;
  const actorEmail = identity.session.act?.email;
  return {
    reference: `user:${identity.auditUserId}`,
    kind: 'human',
    name: actorEmail ?? `User ${identity.auditUserId}`,
    ...(actorEmail ? { email: actorEmail } : {}),
  };
}

function permissionAllows(permissions: readonly string[], requested: string) {
  return (
    permissions.includes(requested) ||
    (requested === 'tasks.view' && permissions.includes('tasks.personal'))
  );
}

/** Signed-session-cookie and trusted-context identity adapter backed by the SQL permission tables. */
export class SessionIdentityProvider implements IdentityProvider<SessionIdentityEvidence> {
  constructor(private readonly env: Env) {}

  async resolve(evidence: SessionIdentityEvidence): Promise<SessionResolvedIdentity | null> {
    if (evidence.kind === 'trusted') {
      return this.resolveAuthorized(evidence.identity, evidence.permission);
    }

    // Browser cookies are untrusted evidence. Invalid, expired, disabled, or temporarily
    // unverifiable sessions retain the historic null result instead of surfacing internals.
    try {
      const session = await verifySession(this.env, evidence.token);
      const user = await this.env.DB.prepare('SELECT id, email, status FROM users WHERE id = ?')
        .bind(Number(session.sub))
        .first<{ id: number; email: string; status: string }>();
      if (user?.status !== 'active') return null;
      if (!(await impersonationStillAuthorized(this.env, session, user.id))) return null;
      const actorId = session.act ? Number(session.act.sub) : user.id;
      const taskIdentity: TaskIdentity = {
        session,
        user,
        auditUserId: Number.isInteger(actorId) && actorId > 0 ? actorId : user.id,
      };
      return await this.resolveAuthorized(taskIdentity, evidence.permission);
    } catch {
      return null;
    }
  }

  private async resolveAuthorized(identity: TaskIdentity, permission: string) {
    // Session claims are presentation hints only. Authorization, including the
    // platform.admin expansion, always comes from the current D1 permission rows.
    const permissions = await effectivePermissionKeys(this.env, identity.user.id);
    if (!permissionAllows(permissions, permission)) return null;
    const delegatedBy = auditPrincipalFor(identity);
    return {
      principal: principalFor(identity.user),
      permissions,
      ...(delegatedBy ? { delegatedBy } : {}),
      taskIdentity: identity,
    } satisfies SessionResolvedIdentity;
  }
}
