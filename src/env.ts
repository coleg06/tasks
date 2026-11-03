import type { ObjectStore, SqlDatabase } from './platform/ports';

export interface Env {
  ASSETS: Fetcher;
  /**
   * Object storage port (R2 on Cloudflare, filesystem when self-hosted). Declared required for
   * the legacy handlers; portable deployments that configure no store pass `PortableEnv`, and the
   * legacy handlers fail closed (503) when it is absent at runtime.
   */
  EVENT_ASSETS: ObjectStore;
  /** SQL port (D1 on Cloudflare, node:sqlite when self-hosted). See `PortableEnv`. */
  DB: SqlDatabase;
  /** Extra readiness probes registered by the runtime (e.g. the configured datastore). */
  PLATFORM_READINESS_CHECKS?: ReadonlyArray<() => Promise<void>>;
  EVENT_AI_API_KEY?: string;
  EVENT_AI_ENDPOINT?: string;
  EVENT_AI_MODEL?: string;
  EMAIL_API_CLIENT_ID?: string;
  EMAIL_API_ENDPOINT?: string;
  EMAIL_API_SECRET?: string;
  EMAIL_FROM?: string;
  ENVIRONMENT: 'local' | 'dev' | 'production';
  FEATURE_MODULES?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_DRIVE_CLIENT_EMAIL?: string;
  GOOGLE_DRIVE_PRIVATE_KEY?: string;
  GOOGLE_DRIVE_ROOT_FOLDER_ID?: string;
  GOOGLE_DRIVE_SHARED_DRIVE_ID?: string;
  PORTAL_SUPPORT_INGEST_SECRET?: string;
  RELEASE_SHA: string;
  TASKS_GATEWAY_ASSERTION_SECRET?: string;
  /** `true`/`false`. Unset: MCP is on only when `TASKS_MCP_CREDENTIALS_JSON` is set. */
  TASKS_MCP_ENABLED?: string;
  /** `gateway-and-token` (default) or `token` (client credential only, chosen explicitly). */
  TASKS_MCP_AUTH_MODE?: string;
  TASKS_MCP_CREDENTIALS_JSON?: string;
  TASKS_MCP_GATEWAY_SECRET?: string;
  TASK_ALERT_PUBLISHER_SECRET?: string;
  SESSION_SECRET?: string;
  /** Restrict sign-in and invitations to this email domain. No default (any domain). */
  TASKS_HOSTED_DOMAIN?: string;
  /** Email of the first administrator, granted every permission at first sign-in. No default. */
  TASKS_INITIAL_ADMIN_EMAIL?: string;
  /** Browser-facing origin, for example https://tasks.example.org. Defaults to the request. */
  TASKS_PUBLIC_ORIGIN?: string;
  /** `session` (default, Google sign-in) or `trusted-upstream` (identity from proxy headers). */
  TASKS_AUTH_MODE?: string;
  /** Trusted-upstream: header carrying the authenticated email. Required in that mode. */
  TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER?: string;
  /** Trusted-upstream: optional header carrying the display name. */
  TASKS_TRUSTED_UPSTREAM_NAME_HEADER?: string;
  /** Trusted-upstream: must equal `proxy-replaces-headers`, an explicit trust acknowledgement. */
  TASKS_TRUSTED_UPSTREAM_TRUST?: string;
}

/**
 * Environment of a portable (adapter-only) deployment: no datastore or object store is wired.
 * Legacy routes are unreachable in that mode (`tenantProfile.tasks.apiMode === 'portable'`), and
 * the tenant verification gate fails closed when `DB` is absent.
 */
export type PortableEnv = Omit<Env, 'DB' | 'EVENT_ASSETS'> & {
  DB?: SqlDatabase;
  EVENT_ASSETS?: ObjectStore;
};
