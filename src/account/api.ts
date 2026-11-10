import type { Context } from 'hono';
import { tenantProfile } from '../../shared/tenant-profile';
import { emailDeliveryPreferenceStatements } from '../notifications/delivery';
import { accountPreferencesSchema } from '../shared/schemas';
import { auditStatement, requireTasksSession, type TaskAppEnv } from '../tasks/api';
import { taskAlertPreferencesStatement } from './alerts';

type AppContext = Context<TaskAppEnv>;

export async function updateAccountPreferences(context: AppContext) {
  const identity =
    (await requireTasksSession(context)) ?? (await requireTasksSession(context, 'events.view'));
  if (!identity) return context.json({ error: 'unauthorized' }, 401);

  const parsed = accountPreferencesSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json({ error: 'invalid_account_preferences', issues: parsed.error.issues }, 400);
  }

  const preferences = parsed.data;
  if (preferences.emailDelivery) {
    if (!tenantProfile.capabilities.emailNotifications)
      return context.json({ error: 'email_disabled' }, 403);
  }
  const statements = [
    context.env.DB.prepare(
      `INSERT INTO user_preferences (user_id, task_creation_mode, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
       ON CONFLICT(user_id) DO UPDATE SET
         task_creation_mode = excluded.task_creation_mode,
         updated_at = excluded.updated_at`,
    ).bind(identity.user.id, preferences.taskCreationMode),
    auditStatement(
      context,
      identity.auditUserId,
      'user',
      String(identity.user.id),
      'user.preferences_updated',
      preferences,
    ),
  ];
  if (preferences.notificationEmails) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO user_notification_preferences (
           user_id, assignment_email, comment_email, mention_email, deadline_email, updated_at
         ) VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
         ON CONFLICT(user_id) DO UPDATE SET
           assignment_email = excluded.assignment_email,
           comment_email = excluded.comment_email,
           mention_email = excluded.mention_email,
           deadline_email = excluded.deadline_email,
           updated_at = excluded.updated_at`,
      ).bind(
        identity.user.id,
        preferences.notificationEmails.assignments ? 1 : 0,
        preferences.notificationEmails.comments ? 1 : 0,
        preferences.notificationEmails.mentions ? 1 : 0,
        preferences.notificationEmails.deadlines ? 1 : 0,
      ),
    );
  }
  if (preferences.notificationAlerts) {
    statements.push(
      taskAlertPreferencesStatement(context.env, identity.user.id, preferences.notificationAlerts),
    );
  }
  if (preferences.emailDelivery)
    statements.push(
      ...emailDeliveryPreferenceStatements(
        context.env,
        identity.user.id,
        preferences.emailDelivery,
      ),
    );
  await context.env.DB.batch(statements);

  return context.json({ preferences });
}
