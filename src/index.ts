import { app } from './app';
import type { Env } from './env';
import { runScheduledJob, scheduledJobs } from './platform/jobs';

export { WorkspaceHub } from './realtime/workspace-hub';

export default {
  fetch: app.fetch,
  scheduled(controller: ScheduledController, env: Env, context: ExecutionContext) {
    for (const job of scheduledJobs.forCron(controller.cron)) {
      context.waitUntil(runScheduledJob(env, job, controller.scheduledTime));
    }
  },
};
