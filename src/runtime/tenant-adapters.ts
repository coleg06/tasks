import type { Context } from 'hono';
import type { TaskAppEnv, TaskIdentity } from '../app-env';
import type {
  ResolvedIdentity,
  TaskBackend,
  TaskDirectoryBackend,
  TaskReadBackend,
} from '../core/contracts';
import type { Env } from '../env';
import { SessionIdentityProvider } from '../identity/session';
import { D1TaskReadBackend } from '../persistence/d1-task-backend';
import { tenantConfigurationIsVerified } from '../tenancy/configuration';

export type RuntimeResolvedIdentity = ResolvedIdentity & {
  /** Present only while a legacy handler still requires the D1 identity shape. */
  readonly legacyTaskIdentity?: TaskIdentity;
};

export type RuntimeIdentityEvidence = {
  readonly context: Context<TaskAppEnv>;
  readonly permission: string;
  readonly sessionToken?: string;
  readonly trustedIdentity?: TaskIdentity;
};

export interface TenantRuntimeAdapters {
  readonly browserAuthentication: 'session-cookie' | 'trusted-upstream';
  /** Header whose presence identifies an authenticated trusted-upstream browser request. */
  readonly browserIdentityHeader?: string;
  /** Verify deployment-owned bindings and upstream dependencies before serving APIs. */
  verifyTenantConfiguration(env: Env): Promise<boolean>;
  /**
   * Optional. Scheduled work calls this on every invocation; an adapter that caches
   * `verifyTenantConfiguration` results must implement it and bypass that cache.
   */
  verifyTenantConfigurationFresh?(env: Env): Promise<boolean>;
  resolveIdentity(evidence: RuntimeIdentityEvidence): Promise<RuntimeResolvedIdentity | null>;
  createTaskReadBackend(env: Env): TaskReadBackend;
  /** Omitted by deployments that have not implemented audited portable writes. */
  createTaskBackend?(env: Env): TaskBackend;
  /** Omitted when the source has no portable principal/project directory. */
  createTaskDirectoryBackend?(env: Env): TaskDirectoryBackend;
}

/**
 * Default self-hosted composition: signed browser sessions plus D1 task reads.
 * A deployment overlay may replace this single module with adapters for
 * another identity provider and persistence service without changing application routes.
 */
export const tenantRuntimeAdapters: TenantRuntimeAdapters = {
  browserAuthentication: 'session-cookie',
  verifyTenantConfiguration: tenantConfigurationIsVerified,
  // The default check reads the identity row on every call and keeps no cache.
  verifyTenantConfigurationFresh: tenantConfigurationIsVerified,
  async resolveIdentity({ context, permission, sessionToken, trustedIdentity }) {
    const provider = new SessionIdentityProvider(context.env);
    const resolved = trustedIdentity
      ? await provider.resolve({ kind: 'trusted', identity: trustedIdentity, permission })
      : sessionToken
        ? await provider.resolve({ kind: 'browser', token: sessionToken, permission })
        : null;
    if (!resolved) return null;
    return { ...resolved, legacyTaskIdentity: resolved.taskIdentity };
  },
  createTaskReadBackend(env) {
    return new D1TaskReadBackend(env.DB);
  },
};
