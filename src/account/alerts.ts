import type { Context } from 'hono';
import type { Env } from '../env';
import { type TaskAlertPreferences, taskAlertPreferencesPatchSchema } from '../shared/schemas';
import { auditStatement, requireTasksSession, type TaskAppEnv } from '../tasks/api';

type AppContext = Context<TaskAppEnv>;

export const defaultTaskAlertPreferences: TaskAlertPreferences = {
  assignments: { email: true, inApp: false, push: false },
  comments: { email: true, inApp: false, push: false },
  mentions: { email: true, inApp: false, push: false },
  deadlines: { email: true, inApp: false, push: false },
};

type PreferenceRow = {
  assignment_email: number;
  assignment_in_app: number;
  assignment_push: number;
  comment_email: number;
  comment_in_app: number;
  comment_push: number;
  mention_email: number;
  mention_in_app: number;
  mention_push: number;
  deadline_email: number;
  deadline_in_app: number;
  deadline_push: number;
};

export async function readTaskAlertPreferences(env: Env, userId: number) {
  const row = await env.DB.prepare(
    `SELECT assignment_email, assignment_in_app, assignment_push,
       comment_email, comment_in_app, comment_push,
       mention_email, mention_in_app, mention_push,
       deadline_email, deadline_in_app, deadline_push
     FROM user_notification_preferences WHERE user_id = ?`,
  )
    .bind(userId)
    .first<PreferenceRow>();
  if (!row) return defaultTaskAlertPreferences;
  return {
    assignments: {
      email: Boolean(row.assignment_email),
      inApp: Boolean(row.assignment_in_app),
      push: Boolean(row.assignment_push),
    },
    comments: {
      email: Boolean(row.comment_email),
      inApp: Boolean(row.comment_in_app),
      push: Boolean(row.comment_push),
    },
    mentions: {
      email: Boolean(row.mention_email),
      inApp: Boolean(row.mention_in_app),
      push: Boolean(row.mention_push),
    },
    deadlines: {
      email: Boolean(row.deadline_email),
      inApp: Boolean(row.deadline_in_app),
      push: Boolean(row.deadline_push),
    },
  } satisfies TaskAlertPreferences;
}

export function taskAlertPreferencesStatement(
  env: Env,
  userId: number,
  preferences: TaskAlertPreferences,
) {
  return env.DB.prepare(
    `INSERT INTO user_notification_preferences (
       user_id,
       assignment_email, assignment_in_app, assignment_push,
       comment_email, comment_in_app, comment_push,
       mention_email, mention_in_app, mention_push,
       deadline_email, deadline_in_app, deadline_push,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(user_id) DO UPDATE SET
       assignment_email = excluded.assignment_email,
       assignment_in_app = excluded.assignment_in_app,
       assignment_push = excluded.assignment_push,
       comment_email = excluded.comment_email,
       comment_in_app = excluded.comment_in_app,
       comment_push = excluded.comment_push,
       mention_email = excluded.mention_email,
       mention_in_app = excluded.mention_in_app,
       mention_push = excluded.mention_push,
       deadline_email = excluded.deadline_email,
       deadline_in_app = excluded.deadline_in_app,
       deadline_push = excluded.deadline_push,
       updated_at = excluded.updated_at`,
  ).bind(
    userId,
    preferences.assignments.email ? 1 : 0,
    preferences.assignments.inApp ? 1 : 0,
    preferences.assignments.push ? 1 : 0,
    preferences.comments.email ? 1 : 0,
    preferences.comments.inApp ? 1 : 0,
    preferences.comments.push ? 1 : 0,
    preferences.mentions.email ? 1 : 0,
    preferences.mentions.inApp ? 1 : 0,
    preferences.mentions.push ? 1 : 0,
    preferences.deadlines.email ? 1 : 0,
    preferences.deadlines.inApp ? 1 : 0,
    preferences.deadlines.push ? 1 : 0,
  );
}

export async function getTaskAlertPreferences(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  return context.json({
    preferences: await readTaskAlertPreferences(context.env, identity.user.id),
  });
}

export async function updateTaskAlertPreferences(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const parsed = taskAlertPreferencesPatchSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json(
      { error: 'invalid_task_alert_preferences', issues: parsed.error.issues },
      400,
    );
  }
  const current = await readTaskAlertPreferences(context.env, identity.user.id);
  const mergeChannel = (
    existing: TaskAlertPreferences['assignments'],
    patch:
      | { email?: boolean | undefined; inApp?: boolean | undefined; push?: boolean | undefined }
      | undefined,
  ) => ({
    email: patch?.email ?? existing.email,
    inApp: patch?.inApp ?? existing.inApp,
    push: patch?.push ?? existing.push,
  });
  const preferences: TaskAlertPreferences = {
    assignments: mergeChannel(current.assignments, parsed.data.assignments),
    comments: mergeChannel(current.comments, parsed.data.comments),
    mentions: mergeChannel(current.mentions, parsed.data.mentions),
    deadlines: mergeChannel(current.deadlines, parsed.data.deadlines),
  };
  await context.env.DB.batch([
    taskAlertPreferencesStatement(context.env, identity.user.id, preferences),
    auditStatement(
      context,
      identity.auditUserId,
      'user',
      String(identity.user.id),
      'user.task_alert_preferences_updated',
      preferences,
    ),
  ]);
  return context.json({ preferences });
}
