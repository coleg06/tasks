import type { Env } from '../env';
import { tenantRuntimeAdapters } from '../runtime/tenant-adapters';

/** Value of `TASKS_TRUSTED_UPSTREAM_TRUST` acknowledging the proxy contract described in docs. */
export const TRUSTED_UPSTREAM_TRUST_ACKNOWLEDGEMENT = 'proxy-replaces-headers';

const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

type AuthModeEnv = Pick<
  Env,
  | 'TASKS_AUTH_MODE'
  | 'TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER'
  | 'TASKS_TRUSTED_UPSTREAM_NAME_HEADER'
  | 'TASKS_TRUSTED_UPSTREAM_TRUST'
>;

export type TrustedUpstreamSettings = {
  readonly emailHeader: string;
  readonly nameHeader: string | null;
};

/** `session` (default), `trusted-upstream`, or `invalid` for any other configured value. */
export function configuredAuthMode(
  env: Pick<Env, 'TASKS_AUTH_MODE'>,
): 'session' | 'trusted-upstream' | 'invalid' {
  const value = (env.TASKS_AUTH_MODE ?? '').trim();
  if (value === '' || value === 'session') return 'session';
  return value === 'trusted-upstream' ? 'trusted-upstream' : 'invalid';
}

/**
 * Trusted-upstream settings when that mode is selected by `TASKS_AUTH_MODE` and fully configured;
 * null otherwise. Callers treat a selected-but-incomplete mode as a closed (503) configuration.
 */
export function trustedUpstreamSettings(env: AuthModeEnv): TrustedUpstreamSettings | null {
  if (configuredAuthMode(env) !== 'trusted-upstream') return null;
  const emailHeader = (env.TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER ?? '').trim();
  const nameHeader = (env.TASKS_TRUSTED_UPSTREAM_NAME_HEADER ?? '').trim();
  if (!HEADER_NAME.test(emailHeader)) return null;
  if (nameHeader && !HEADER_NAME.test(nameHeader)) return null;
  if ((env.TASKS_TRUSTED_UPSTREAM_TRUST ?? '').trim() !== TRUSTED_UPSTREAM_TRUST_ACKNOWLEDGEMENT) {
    return null;
  }
  return { emailHeader, nameHeader: nameHeader || null };
}

/** True when browsers are authenticated by proxy headers rather than a signed session cookie. */
export function usesEnvTrustedUpstream(env: AuthModeEnv): boolean {
  return (
    tenantRuntimeAdapters.browserAuthentication === 'session-cookie' &&
    configuredAuthMode(env) !== 'session'
  );
}

/**
 * Names (never values) of the settings that keep the selected authentication mode from working.
 * Empty when the mode is usable or is not selected through configuration.
 */
export function authModeProblems(env: AuthModeEnv): string[] {
  const mode = configuredAuthMode(env);
  if (mode === 'session') return [];
  if (mode === 'invalid') return ['TASKS_AUTH_MODE'];
  const problems: string[] = [];
  if (!HEADER_NAME.test((env.TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER ?? '').trim())) {
    problems.push('TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER');
  }
  const nameHeader = (env.TASKS_TRUSTED_UPSTREAM_NAME_HEADER ?? '').trim();
  if (nameHeader && !HEADER_NAME.test(nameHeader))
    problems.push('TASKS_TRUSTED_UPSTREAM_NAME_HEADER');
  if ((env.TASKS_TRUSTED_UPSTREAM_TRUST ?? '').trim() !== TRUSTED_UPSTREAM_TRUST_ACKNOWLEDGEMENT) {
    problems.push('TASKS_TRUSTED_UPSTREAM_TRUST');
  }
  return problems;
}
