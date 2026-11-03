import { hostedEmailMatches, normalizeHostedDomain } from '../../shared/hosted-domain';
import { tenantAppOrigin, tenantProfile } from '../../shared/tenant-profile';
import type { Env } from '../env';

type IdentityConfigEnv = Pick<
  Env,
  'ENVIRONMENT' | 'TASKS_HOSTED_DOMAIN' | 'TASKS_INITIAL_ADMIN_EMAIL' | 'TASKS_PUBLIC_ORIGIN'
>;

/**
 * Hosted email domain for sign-in and invitations. A domain compiled into the tenant profile is
 * authoritative and cannot be loosened by configuration; otherwise `TASKS_HOSTED_DOMAIN` applies.
 * Empty means no domain restriction.
 */
export function configuredHostedDomain(env: Pick<Env, 'TASKS_HOSTED_DOMAIN'>): string {
  return normalizeHostedDomain(tenantProfile.identity.hostedDomain)
    ? normalizeHostedDomain(tenantProfile.identity.hostedDomain)
    : normalizeHostedDomain(env.TASKS_HOSTED_DOMAIN);
}

export function isHostedEmail(env: Pick<Env, 'TASKS_HOSTED_DOMAIN'>, email: string): boolean {
  return hostedEmailMatches(email, configuredHostedDomain(env));
}

/** Emails that receive every permission when they sign in: the profile's and the configured one. */
export function initialAdminEmails(env: Pick<Env, 'TASKS_INITIAL_ADMIN_EMAIL'>): string[] {
  return [tenantProfile.identity.initialAdminEmail, env.TASKS_INITIAL_ADMIN_EMAIL ?? '']
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function isInitialAdminEmail(env: Pick<Env, 'TASKS_INITIAL_ADMIN_EMAIL'>, email: string) {
  return initialAdminEmails(env).includes(email.trim().toLowerCase());
}

/**
 * Whether a person unknown to the database may be created at sign-in: only when a hosted domain is
 * configured and the address is in it, or the address is the configured first administrator.
 * Without either, only administrator-created users can sign in.
 */
export function mayCreateUserOnSignIn(
  env: Pick<Env, 'TASKS_HOSTED_DOMAIN' | 'TASKS_INITIAL_ADMIN_EMAIL'>,
  email: string,
): boolean {
  if (isInitialAdminEmail(env, email)) return true;
  return configuredHostedDomain(env) !== '' && isHostedEmail(env, email);
}

/**
 * Origin used in links the application sends out (email, notifications). Like `publicOrigin` but
 * without a request: it is empty (relative links) when nothing configures an origin.
 */
export function outboundLinkOrigin(env: IdentityConfigEnv): string {
  return env.TASKS_PUBLIC_ORIGIN?.trim()
    ? publicOrigin(env, 'http://invalid.invalid/')
    : tenantAppOrigin(env.ENVIRONMENT, tenantProfile.origins.development);
}

/**
 * Browser-facing origin of the application. `TASKS_PUBLIC_ORIGIN` (an http(s) origin) wins; then
 * the profile's origin for the environment; then the request's own origin.
 */
export function publicOrigin(env: IdentityConfigEnv, requestUrl: string): string {
  const configured = env.TASKS_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // Startup validation rejects a malformed value; never fall back to a guess here.
    }
    throw new Error('TASKS_PUBLIC_ORIGIN must be an http(s) origin');
  }
  return tenantAppOrigin(env.ENVIRONMENT, new URL(requestUrl).origin);
}
