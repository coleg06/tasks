import type { MiddlewareHandler } from 'hono';
import { tenantProfile } from '../../shared/tenant-profile';
import type { TaskAppEnv } from '../app-env';
import { effectivePermissionKeys } from '../auth/permissions';
import { provisionSignedInUser } from '../auth/provision';
import { logApplicationError } from '../logging';
import { isHostedEmail, mayCreateUserOnSignIn } from '../runtime/identity-config';
import { trustedUpstreamSettings, usesEnvTrustedUpstream } from './auth-mode';

/** Routes that carry their own credentials; proxy headers never establish identity there. */
const OWN_AUTHENTICATION_PREFIXES = ['/api/mobile/v1/', '/api/agent/v1/', '/api/integrations/'];

function plainHeader(value: string | undefined, maximum: number) {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > maximum) return null;
  for (const character of trimmed) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return null;
  }
  return trimmed;
}

const provisionedByDatabase = new WeakMap<object, Map<number, number>>();
const PROVISION_TTL_MS = 5 * 60_000;

/**
 * Establishes the request's identity from the reverse proxy's authenticated-email header, using
 * the same `taskIdentity` context seam as the other browser-less credentials. The selected mode
 * fails closed: unusable configuration answers 503, and a request without the header simply has
 * no identity (handlers answer 401). Session cookies are never consulted in this mode.
 */
export const trustedUpstreamIdentity: MiddlewareHandler<TaskAppEnv> = async (context, next) => {
  if (!usesEnvTrustedUpstream(context.env)) return next();
  if (OWN_AUTHENTICATION_PREFIXES.some((prefix) => context.req.path.startsWith(prefix))) {
    return next();
  }
  const settings = trustedUpstreamSettings(context.env);
  if (!settings) return context.json({ error: 'trusted_upstream_not_configured' }, 503);
  const email = plainHeader(context.req.header(settings.emailHeader), 254)?.toLowerCase();
  if (!email || !isHostedEmail(context.env, email)) return next();
  try {
    const name = settings.nameHeader
      ? plainHeader(context.req.header(settings.nameHeader), 160)
      : null;
    const [firstName = '', ...rest] = (name ?? '').split(/\s+/).filter(Boolean);
    const lastName = rest.join(' ');
    // The agent principal is a service identity; it never signs in as a person.
    if (email.toLowerCase() === tenantProfile.agent.email.toLowerCase()) {
      return context.json({ error: 'access_denied' }, 403);
    }
    let user = await context.env.DB.prepare(
      'SELECT id, email, status FROM users WHERE email = ? COLLATE NOCASE',
    )
      .bind(email)
      .first<{ id: number; email: string; status: string }>();
    if (!user) {
      // Fail closed: an unknown address is created only under the same rule as Google sign-in.
      if (!mayCreateUserOnSignIn(context.env, email)) {
        return context.json({ error: 'access_denied' }, 403);
      }
      await context.env.DB.prepare(
        `INSERT OR IGNORE INTO users (email, first_name, last_name, last_seen_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))`,
      )
        .bind(email, firstName, lastName)
        .run();
      user = await context.env.DB.prepare(
        'SELECT id, email, status FROM users WHERE email = ? COLLATE NOCASE',
      )
        .bind(email)
        .first<{ id: number; email: string; status: string }>();
    }
    if (user?.status !== 'active') return next();
    const now = Date.now();
    const provisioned = provisionedByDatabase.get(context.env.DB) ?? new Map<number, number>();
    provisionedByDatabase.set(context.env.DB, provisioned);
    if ((provisioned.get(user.id) ?? 0) < now) {
      await provisionSignedInUser(context.env, user);
      provisioned.set(user.id, now + PROVISION_TTL_MS);
    }
    context.set('taskIdentity', {
      session: {
        sub: String(user.id),
        email: user.email,
        perms: await effectivePermissionKeys(context.env, user.id),
        exp: Math.floor(now / 1000) + 300,
      },
      user,
      auditUserId: user.id,
    });
  } catch (error) {
    await logApplicationError(
      'trusted_upstream.identity_failed',
      error,
      context.env,
      context.get('requestId'),
    );
    return context.json({ error: 'identity_unavailable' }, 503);
  }
  return next();
};
