import { jwtVerify, SignJWT } from 'jose';
import { resolveRuntimeFeatures } from '../../shared/runtime-features';
import { tenantProfile } from '../../shared/tenant-profile';
import type { Env } from '../env';
import { effectivePermissionKeys } from './permissions';

export const SESSION_COOKIE = `${tenantProfile.security.cookiePrefix}_session`;
export const OAUTH_COOKIE = `${tenantProfile.security.cookiePrefix}_oauth`;
// A stateless older binary must never accept these cookies while ignoring revocation.
export const BROWSER_SESSION_AUDIENCE = `${tenantProfile.security.tokenIssuer}-browser-v2`;

export interface SessionClaims {
  sub: string;
  email: string;
  perms: string[];
  act?: { sub: string; email: string };
  exp: number;
  /** Present only on durable browser sessions; trusted identities have no JWT. */
  jti?: string;
  iat?: number;
  auth_time?: number;
  absolute_exp?: number;
  actor_session?: string;
}

export const MINIMUM_SESSION_SECRET_LENGTH = 32;

export function sessionSecretIsConfigured(secret: string | undefined): secret is string {
  return typeof secret === 'string' && secret.trim().length >= MINIMUM_SESSION_SECRET_LENGTH;
}

function key(secret: string | undefined) {
  // Enforce this at the crypto boundary too: Workers do not run Node's startup validation.
  if (!sessionSecretIsConfigured(secret)) {
    throw new Error('SESSION_SECRET must contain at least 32 non-padding characters');
  }
  return new TextEncoder().encode(secret);
}

/**
 * Accept only same-origin absolute paths. Browsers normalise a backslash (and
 * strip tabs/newlines) inside a Location value, so `/\\host` and `/\t/host`
 * would otherwise redirect off-site after sign-in.
 */
export function safeReturnTo(candidate: string | undefined) {
  if (!candidate || candidate.length > 2_048) return '/';
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return '/';
  for (const character of candidate) {
    const code = character.charCodeAt(0);
    if (character === '\\' || code <= 0x1f || code === 0x7f) return '/';
  }
  return candidate;
}

export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60;
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
export const IMPERSONATION_SECONDS = 12 * 60 * 60;
export const SESSION_RENEW_AFTER_SECONDS = 60 * 60;

export type BrowserSessionClaims = SessionClaims & {
  jti: string;
  iat: number;
  auth_time: number;
  absolute_exp: number;
};

type StoredSession = {
  id: string;
  user_id: number;
  authenticated_at: number;
  expires_at: number;
  absolute_expires_at: number;
  actor_session_id: string | null;
  revoked_at: number | null;
};

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function encodeSession(env: Env, claims: BrowserSessionClaims) {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(tenantProfile.security.tokenIssuer)
    .setAudience(BROWSER_SESSION_AUDIENCE)
    .sign(key(env.SESSION_SECRET));
}

/** Create a durable session only after authenticating the user, or authorizing impersonation. */
export async function signSession(
  env: Env,
  user: { id: number; email: string },
  permissions: string[],
  actor?: { id: number; email: string },
  actorSession?: SessionClaims,
) {
  key(env.SESSION_SECRET); // Fail at the crypto boundary, before any database work.
  const now = nowSeconds();
  let parent: StoredSession | undefined;
  if (actor) {
    if (!actorSession || actorSession.act || actorSession.sub !== String(actor.id)) {
      throw new Error('Impersonation requires the actor session.');
    }
    parent = await requireStoredSession(env, actorSession);
  }
  const authenticatedAt = parent?.authenticated_at ?? now;
  const absoluteExpiry = parent?.absolute_expires_at ?? now + SESSION_ABSOLUTE_SECONDS;
  const expiry = Math.min(
    now + (actor ? IMPERSONATION_SECONDS : SESSION_IDLE_SECONDS),
    actorSession?.exp ?? absoluteExpiry,
    parent?.expires_at ?? absoluteExpiry,
    absoluteExpiry,
  );
  const claims: BrowserSessionClaims = {
    sub: String(user.id),
    email: user.email,
    perms: permissions,
    jti: crypto.randomUUID(),
    iat: now,
    auth_time: authenticatedAt,
    absolute_exp: absoluteExpiry,
    exp: expiry,
    ...(actor && parent
      ? { act: { sub: String(actor.id), email: actor.email }, actor_session: parent.id }
      : {}),
  };
  const token = await encodeSession(env, claims);
  // A parent check in this INSERT closes the authorization/logout race during impersonation.
  const result = await env.DB.prepare(
    `INSERT INTO browser_sessions
       (id, user_id, authenticated_at, expires_at, absolute_expires_at, actor_session_id)
     SELECT ?, ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
     AND (? IS NULL OR EXISTS (
       SELECT 1 FROM browser_sessions WHERE id = ? AND revoked_at IS NULL
       AND expires_at > ? AND absolute_expires_at > ?
     ))`,
  )
    .bind(
      claims.jti,
      user.id,
      authenticatedAt,
      expiry,
      absoluteExpiry,
      parent?.id ?? null,
      user.id,
      parent?.id ?? null,
      parent?.id ?? null,
      now,
      now,
    )
    .run();
  if (!(result.meta.changes > 0)) throw new Error('Session creation rejected.');
  return token;
}

async function readSessionClaims(
  env: Env,
  token: string,
  logoutOnly = false,
): Promise<BrowserSessionClaims> {
  const { payload } = await jwtVerify(token, key(env.SESSION_SECRET), {
    algorithms: ['HS256'],
    audience: BROWSER_SESSION_AUDIENCE,
    issuer: tenantProfile.security.tokenIssuer,
    // Expired evidence may only revoke its own durable family, never authenticate or renew.
    clockTolerance: logoutOnly ? SESSION_ABSOLUTE_SECONDS : 0,
  });
  const now = nowSeconds();
  if (
    typeof payload.sub !== 'string' ||
    !/^[1-9]\d*$/.test(payload.sub) ||
    !Number.isSafeInteger(Number(payload.sub)) ||
    typeof payload.email !== 'string' ||
    !Array.isArray(payload.perms) ||
    !payload.perms.every((permission) => typeof permission === 'string') ||
    typeof payload.jti !== 'string' ||
    payload.jti.length < 16 ||
    !Number.isSafeInteger(payload.iat) ||
    !Number.isSafeInteger(payload.exp) ||
    !Number.isSafeInteger(payload.auth_time) ||
    !Number.isSafeInteger(payload.absolute_exp) ||
    Number(payload.auth_time) > Number(payload.iat) ||
    Number(payload.iat) > now ||
    Number(payload.exp) <= Number(payload.iat) ||
    Number(payload.exp) > Number(payload.absolute_exp) ||
    Number(payload.absolute_exp) > Number(payload.auth_time) + SESSION_ABSOLUTE_SECONDS ||
    (!logoutOnly && Number(payload.absolute_exp) <= now) ||
    (payload.act !== undefined &&
      (typeof payload.act !== 'object' ||
        payload.act === null ||
        typeof (payload.act as Record<string, unknown>).sub !== 'string' ||
        typeof (payload.act as Record<string, unknown>).email !== 'string' ||
        typeof payload.actor_session !== 'string')) ||
    (payload.act === undefined && payload.actor_session !== undefined)
  ) {
    // Legacy 12-hour cookies have no durable row/authentication bound: require fresh sign-in.
    throw new Error('Invalid session claims.');
  }
  return payload as unknown as BrowserSessionClaims;
}

/** JWT verification alone is never sufficient: every browser token needs its durable row. */
export async function verifySession(env: Env, token: string): Promise<BrowserSessionClaims> {
  const session = await readSessionClaims(env, token);
  await requireStoredSession(env, session);
  return session;
}

/** Expired signed evidence may revoke, but cannot restore an actor or obtain a new cookie. */
export async function revokeSessionToken(env: Env, token: string) {
  let session: BrowserSessionClaims;
  try {
    session = await readSessionClaims(env, token, true);
  } catch {
    // Invalid signatures/claims confer no access and cannot select a session to revoke.
    return;
  }
  // Storage errors must propagate: clearing only the browser cookie is not successful logout.
  const stored = await env.DB.prepare('SELECT * FROM browser_sessions WHERE id = ?')
    .bind(session.jti)
    .first<StoredSession>();
  if (
    !stored ||
    stored.user_id !== Number(session.sub) ||
    stored.authenticated_at !== session.auth_time ||
    stored.absolute_expires_at !== session.absolute_exp ||
    stored.actor_session_id !== (session.actor_session ?? null)
  )
    return;
  await revokeSession(env, session);
}

async function requireStoredSession(env: Env, session: SessionClaims): Promise<StoredSession> {
  const now = nowSeconds();
  if (!session.jti || !session.auth_time || !session.absolute_exp || session.exp <= now) {
    throw new Error('Invalid session.');
  }
  const stored = await env.DB.prepare('SELECT * FROM browser_sessions WHERE id = ?')
    .bind(session.jti)
    .first<StoredSession>();
  if (
    !stored ||
    stored.revoked_at !== null ||
    stored.expires_at <= now ||
    stored.absolute_expires_at <= now ||
    stored.user_id !== Number(session.sub) ||
    stored.authenticated_at !== session.auth_time ||
    stored.absolute_expires_at !== session.absolute_exp ||
    session.exp > stored.expires_at ||
    stored.actor_session_id !== (session.actor_session ?? null)
  ) {
    throw new Error('Session expired or revoked.');
  }
  if (stored.actor_session_id) {
    const actor = await env.DB.prepare('SELECT * FROM browser_sessions WHERE id = ?')
      .bind(stored.actor_session_id)
      .first<StoredSession>();
    if (
      !actor ||
      actor.revoked_at !== null ||
      actor.expires_at <= now ||
      actor.absolute_expires_at <= now ||
      actor.actor_session_id !== null ||
      actor.user_id !== Number(session.act?.sub) ||
      session.exp > actor.expires_at ||
      stored.authenticated_at !== actor.authenticated_at ||
      stored.absolute_expires_at !== actor.absolute_expires_at
    ) {
      throw new Error('Actor session expired or revoked.');
    }
  }
  return stored;
}

/** Renew only on successful browser activity, after rechecking the active user and authorization. */
export async function renewSession(env: Env, session: BrowserSessionClaims) {
  const now = nowSeconds();
  await requireStoredSession(env, session);
  // Impersonation is never renewed. Ordinary activity renews at most once an hour.
  if (session.act || session.exp - now > SESSION_IDLE_SECONDS - SESSION_RENEW_AFTER_SECONDS) {
    return null;
  }
  const user = await env.DB.prepare('SELECT id, email, status FROM users WHERE id = ?')
    .bind(Number(session.sub))
    .first<{ id: number; email: string; status: string }>();
  if (user?.status !== 'active' || user.email !== session.email)
    throw new Error('Session user unavailable.');
  const permissions = await effectivePermissionKeys(env, user.id);
  if (
    !permissions.includes('tasks.view') &&
    !permissions.includes('tasks.personal') &&
    !(resolveRuntimeFeatures(env.FEATURE_MODULES).events && permissions.includes('events.view'))
  ) {
    throw new Error('Session authorization revoked.');
  }
  const expiry = Math.min(now + SESSION_IDLE_SECONDS, session.absolute_exp);
  if (expiry <= session.exp) return null;
  const token = await encodeSession(env, { ...session, perms: permissions, iat: now, exp: expiry });
  // UPDATE only: a late refresh cannot resurrect a logout, and older requests cannot shorten it.
  const result = await env.DB.prepare(
    `UPDATE browser_sessions SET expires_at = MAX(expires_at, ?)
     WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND absolute_expires_at > ?
     AND EXISTS (SELECT 1 FROM users WHERE id = user_id AND status = 'active')`,
  )
    .bind(expiry, session.jti, now, now)
    .run();
  if (!(result.meta.changes > 0)) throw new Error('Session renewal rejected.');
  return { token, expiresAt: expiry };
}

/** Logout keeps a tombstone and revokes the actor's whole impersonation family. */
export async function revokeSession(env: Env, session: BrowserSessionClaims) {
  await env.DB.prepare(
    `UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, ?)
     WHERE id = ? OR actor_session_id = ?`,
  )
    .bind(nowSeconds(), session.actor_session ?? session.jti, session.actor_session ?? session.jti)
    .run();
}

/** Stop "view as" without extending the actor's existing idle or absolute deadlines. */
export async function restoreActorSession(
  env: Env,
  session: BrowserSessionClaims,
  actor: { id: number; email: string },
  permissions: string[],
) {
  await requireStoredSession(env, session);
  if (!session.act || session.act.sub !== String(actor.id) || !session.actor_session) {
    throw new Error('Invalid actor session.');
  }
  const stored = await env.DB.prepare('SELECT * FROM browser_sessions WHERE id = ?')
    .bind(session.actor_session)
    .first<StoredSession>();
  if (!stored) throw new Error('Actor session missing.');
  const claims: BrowserSessionClaims = {
    sub: String(actor.id),
    email: actor.email,
    perms: permissions,
    jti: stored.id,
    iat: nowSeconds(),
    auth_time: stored.authenticated_at,
    absolute_exp: stored.absolute_expires_at,
    exp: stored.expires_at,
  };
  const token = await encodeSession(env, claims);
  await env.DB.prepare(
    'UPDATE browser_sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?',
  )
    .bind(nowSeconds(), session.jti)
    .run();
  return { token, expiresAt: claims.exp };
}

export async function signOAuthState(
  env: Env,
  values: { state: string; verifier: string; returnTo: string },
) {
  return new SignJWT(values)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(tenantProfile.security.tokenIssuer)
    .setAudience(`${tenantProfile.security.tokenIssuer}-oauth`)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(key(env.SESSION_SECRET ?? ''));
}

export async function verifyOAuthState(env: Env, token: string) {
  const { payload } = await jwtVerify(token, key(env.SESSION_SECRET ?? ''), {
    algorithms: ['HS256'],
    audience: `${tenantProfile.security.tokenIssuer}-oauth`,
    issuer: tenantProfile.security.tokenIssuer,
  });
  if (
    typeof payload.state !== 'string' ||
    typeof payload.verifier !== 'string' ||
    typeof payload.returnTo !== 'string'
  ) {
    throw new Error('Invalid OAuth state.');
  }
  return payload as { state: string; verifier: string; returnTo: string };
}
