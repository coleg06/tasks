import { jwtVerify, SignJWT } from 'jose';
import { tenantProfile } from '../../shared/tenant-profile';
import type { Env } from '../env';

export const SESSION_COOKIE = `${tenantProfile.security.cookiePrefix}_session`;
export const OAUTH_COOKIE = `${tenantProfile.security.cookiePrefix}_oauth`;

export interface SessionClaims {
  sub: string;
  email: string;
  perms: string[];
  act?: { sub: string; email: string };
  exp: number;
}

const key = (secret: string) => new TextEncoder().encode(secret);

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

export async function signSession(
  env: Env,
  user: { id: number; email: string },
  permissions: string[],
  actor?: { id: number; email: string },
) {
  return new SignJWT({
    email: user.email,
    perms: permissions,
    ...(actor ? { act: { sub: String(actor.id), email: actor.email } } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuer(tenantProfile.security.tokenIssuer)
    .setAudience(tenantProfile.security.tokenIssuer)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('12h')
    .sign(key(env.SESSION_SECRET ?? ''));
}

export async function verifySession(env: Env, token: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, key(env.SESSION_SECRET ?? ''), {
    algorithms: ['HS256'],
    audience: tenantProfile.security.tokenIssuer,
    issuer: tenantProfile.security.tokenIssuer,
  });
  if (
    !payload.sub ||
    typeof payload.email !== 'string' ||
    !Array.isArray(payload.perms) ||
    !payload.perms.every((permission) => typeof permission === 'string') ||
    (payload.act !== undefined &&
      (typeof payload.act !== 'object' ||
        payload.act === null ||
        typeof (payload.act as Record<string, unknown>).sub !== 'string' ||
        typeof (payload.act as Record<string, unknown>).email !== 'string')) ||
    typeof payload.exp !== 'number'
  ) {
    throw new Error('Invalid session claims.');
  }
  return payload as unknown as SessionClaims;
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
