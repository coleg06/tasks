import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { TaskAppEnv } from '../app-env';
import { SESSION_COOKIE } from '../auth/session';
import { tenantRuntimeAdapters } from '../runtime/tenant-adapters';
import { usesEnvTrustedUpstream } from './auth-mode';

type AppContext = Context<TaskAppEnv>;

/** Compatibility adapter for handlers that still consume the legacy TaskIdentity shape. */
export async function requireTasksSession(context: AppContext, permission = 'tasks.view') {
  const resolved = await resolveTasksIdentity(context, permission);
  return resolved?.legacyTaskIdentity ?? null;
}

/** Portable identity used by the versioned task-service API and new shared features. */
export async function resolveTasksIdentity(context: AppContext, permission = 'tasks.view') {
  const trustedIdentity = context.get('taskIdentity');
  // Proxy-authenticated deployments never consult a session cookie.
  const token = usesEnvTrustedUpstream(context.env)
    ? undefined
    : getCookie(context, SESSION_COOKIE);
  return tenantRuntimeAdapters.resolveIdentity({
    context,
    permission,
    ...(token ? { sessionToken: token } : {}),
    ...(trustedIdentity ? { trustedIdentity } : {}),
  });
}
