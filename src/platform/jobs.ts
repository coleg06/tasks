import type { Env } from '../env';
import { logApplicationError, pruneOperationalEvents } from '../logging';
import { sendDeadlineNotifications } from '../notifications/deadlines';
import { sendEmailDigests } from '../notifications/digests';
import { retryTaskAlertOutbox } from '../notifications/portal';
import { tenantRuntimeAdapters } from '../runtime/tenant-adapters';
import type { ScheduledJob, ScheduledJobs } from './ports';

/**
 * The single job table. Cloudflare cron triggers (src/index.ts) and the self-hosted
 * scheduler (src/platform/scheduler.ts) both run exactly these entries.
 */
export const scheduledJobTable: readonly ScheduledJob<Env>[] = [
  { name: 'email_digests', cron: '* * * * *', run: (env) => sendEmailDigests(env) },
  {
    name: 'deadline_notifications',
    cron: '0 13 * * *',
    run: (env) => sendDeadlineNotifications(env),
  },
  {
    name: 'operational_log_retention',
    cron: '0 13 * * *',
    run: (env) => pruneOperationalEvents(env),
  },
  { name: 'portal_alert_retry', cron: '*/5 * * * *', run: (env) => retryTaskAlertOutbox(env) },
];

export const scheduledJobs: ScheduledJobs<Env> = {
  jobs: scheduledJobTable,
  forCron: (cron) => scheduledJobTable.filter((job) => job.cron === cron),
};

type FreshTenantVerifier = {
  verifyTenantConfigurationFresh?: (env: Env) => Promise<boolean>;
};

/**
 * Verify the tenant binding freshly for this invocation. An adapter that caches must expose
 * `verifyTenantConfigurationFresh`; otherwise its normal check is used. A false or thrown result
 * is reported to the runtime log only: writing an operational event (logApplicationError) into a
 * database whose identity could not be verified would itself cross the tenant boundary.
 */
async function assertFreshTenantConfiguration(env: Env, job: ScheduledJob<Env>, requestId: string) {
  // Structural cast: a deployment overlay replaces tenant-adapters.ts, including its interface.
  const adapters = tenantRuntimeAdapters as typeof tenantRuntimeAdapters & FreshTenantVerifier;
  const verify = adapters.verifyTenantConfigurationFresh ?? adapters.verifyTenantConfiguration;
  let verified = false;
  let failure: string | undefined;
  try {
    verified = (await verify.call(adapters, env)) === true;
  } catch (error) {
    failure = error instanceof Error ? error.name : 'unknown_error';
  }
  if (verified) return;
  console.error(
    JSON.stringify({
      type: 'scheduled_job',
      name: job.name,
      status: 'tenant_verification_failed',
      requestId,
      environment: env.ENVIRONMENT,
      ...(failure ? { error: failure } : {}),
    }),
  );
  throw new Error('tenant_configuration_mismatch');
}

/**
 * Run one job with the shared success/failure logging. Every invocation first re-verifies the
 * tenant (fresh, uncached); on failure no job code runs. Job failures are logged, then rethrown.
 */
export async function runScheduledJob(
  env: Env,
  job: ScheduledJob<Env>,
  scheduledTime: number,
): Promise<void> {
  const startedAt = Date.now();
  const requestId = `cron:${job.name}:${scheduledTime}`;
  await assertFreshTenantConfiguration(env, job, requestId);
  try {
    const result = await job.run(env);
    console.log(
      JSON.stringify({
        type: 'scheduled_job',
        name: job.name,
        status: 'success',
        requestId,
        environment: env.ENVIRONMENT,
        durationMs: Date.now() - startedAt,
        result,
      }),
    );
  } catch (error) {
    await logApplicationError(`scheduled.${job.name}.failed`, error, env, requestId, {
      cron: job.cron,
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
}
