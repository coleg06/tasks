import type { Env } from '../env';
import { type DigestFrequency, mapEmailBatch } from './delivery';
import {
  eventUrl,
  myTasksUrl,
  type NotificationDetail,
  type NotificationEntity,
  type NotificationKind,
  notificationAccessStatement,
  notificationsConfigured,
  prepareScheduledEmail,
  taskUrl,
} from './email';

export type DigestReference = {
  kind: NotificationKind;
  entity_type: NotificationEntity;
  entity_key: string;
};

/** Prepare authorized current details from one snapshot. Stored references contain no text. */
export async function prepareDigestDetails(
  env: Env,
  userId: number,
  frequency: DigestFrequency,
  items: DigestReference[],
) {
  const references = items.slice(0, 25);
  // One atomic database snapshot covers current preferences, active state, access, and titles.
  // Revocation cannot race between an access query and a later content query.
  const statements = [
    env.DB.prepare(`SELECT
    COALESCE(p.assignment, 'immediate') AS assignment, COALESCE(p.comment, 'immediate') AS comment,
    COALESCE(p.mention, 'immediate') AS mention, COALESCE(p.deadline, 'immediate') AS deadline,
    COALESCE(n.assignment_email, 1) AS assignment_email, COALESCE(n.comment_email, 1) AS comment_email,
    COALESCE(n.mention_email, 1) AS mention_email, COALESCE(n.deadline_email, 1) AS deadline_email
    FROM users u LEFT JOIN email_delivery_preferences p ON p.user_id = u.id
    LEFT JOIN user_notification_preferences n ON n.user_id = u.id
    WHERE u.id = ? AND u.status = 'active'`).bind(userId),
  ];
  for (const item of references) {
    statements.push(notificationAccessStatement(env, userId, item.entity_type, item.entity_key));
    statements.push(
      item.entity_type === 'task'
        ? env.DB.prepare(`SELECT t.title, p.name AS context, t.task_key AS target FROM tasks t
          JOIN projects p ON p.id = t.project_id WHERE t.task_key = ?
          AND (? <> 'deadline' OR (t.status <> 'done' AND t.assignee_user_id = ?))`).bind(
            item.entity_key,
            item.kind,
            userId,
          )
        : item.entity_type === 'event_work_item'
          ? env.DB.prepare(`SELECT wi.title, e.title AS context, e.event_key AS target FROM event_work_items wi
            JOIN events e ON e.id = wi.event_id WHERE wi.work_item_key = ?
            AND (? <> 'deadline' OR (wi.status NOT IN ('done','not_needed') AND wi.owner_user_id = ?))`).bind(
              item.entity_key,
              item.kind,
              userId,
            )
          : env.DB.prepare(
              'SELECT title, ministry AS context, event_key AS target FROM events WHERE event_key = ?',
            ).bind(item.entity_key),
    );
  }
  const snapshot = await env.DB.batch<Record<string, unknown>>(statements);
  const preferences = snapshot[0]?.results[0];
  const details: NotificationDetail[] = [];
  let kind: NotificationKind | undefined;
  for (const [index, item] of references.entries()) {
    if (
      !preferences ||
      preferences[item.kind] !== frequency ||
      preferences[`${item.kind}_email`] !== 1 ||
      snapshot[index * 2 + 1]?.results[0]?.allowed !== 1
    )
      continue;
    const row = snapshot[index * 2 + 2]?.results[0] as
      | { title: string; context: string; target: string }
      | undefined;
    if (!row) continue;
    kind ??= item.kind;
    details.push({
      label: item.kind,
      title: row.title.slice(0, 240),
      context: row.context.slice(0, 240),
      url: item.entity_type === 'task' ? taskUrl(env, row.target) : eventUrl(env, row.target),
    });
  }
  return { kind, details };
}

export async function sendEmailDigests(env: Env) {
  // One transaction consumes the entire due cohort. Interrupted invocations cannot
  // leave recipients available for the next minute. Overflow is permanently discarded.
  const results = await env.DB.batch([
    env.DB.prepare('DELETE FROM email_digest_buckets WHERE due_at < unixepoch() - 300'),
    env.DB.prepare('DELETE FROM email_send_attempts WHERE reserved_at <= unixepoch() - 604800'),
    env.DB.prepare('DELETE FROM email_dispatch_runs WHERE started_at < unixepoch() - 2592000'),
    env.DB.prepare(
      `DELETE FROM notification_deliveries WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')`,
    ),
    env.DB.prepare(`DELETE FROM email_digest_buckets WHERE claimed = 0 AND due_at <= unixepoch()
      AND (user_id, frequency, due_at) NOT IN (
        SELECT user_id, frequency, due_at FROM email_digest_buckets
        WHERE claimed = 0 AND due_at <= unixepoch() ORDER BY due_at, user_id, frequency LIMIT 50
      )`),
    env.DB.prepare(`UPDATE email_digest_buckets SET claimed = 1
      WHERE claimed = 0 AND due_at <= unixepoch()
      RETURNING user_id, frequency, due_at, unixepoch() AS dispatch_at`),
  ]);
  if (!notificationsConfigured(env)) return { attempted: 0 };
  const buckets = (results[5]?.results ?? []) as {
    user_id: number;
    frequency: DigestFrequency;
    due_at: number;
    dispatch_at: number;
  }[];
  const sends = await mapEmailBatch(buckets, async (bucket) => {
    try {
      const items =
        await env.DB.prepare(`SELECT kind, entity_type, entity_key FROM email_digest_items
        WHERE user_id = ? AND frequency = ? AND due_at = ? ORDER BY kind, entity_type, entity_key LIMIT 25`)
          .bind(bucket.user_id, bucket.frequency, bucket.due_at)
          .all<DigestReference>();
      const prepared = await prepareDigestDetails(
        env,
        bucket.user_id,
        bucket.frequency,
        items.results,
      );
      if (!prepared.kind || !prepared.details.length) return undefined;
      return await prepareScheduledEmail(
        env,
        {
          userId: bucket.user_id,
          kind: prepared.kind,
          entityType: 'deadline_digest',
          entityKey: `${bucket.frequency}:${bucket.due_at}`,
          dedupeKey: `email-digest:${bucket.user_id}:${bucket.frequency}:${bucket.due_at}`,
          subject: `Tasks ${bucket.frequency} summary`,
          heading: 'Your workflow summary',
          message:
            'Up to 25 currently accessible items from this interval are shown. Open Tasks for current activity.',
          url: myTasksUrl(env),
          details: prepared.details,
        },
        bucket.frequency,
        Math.min(bucket.dispatch_at, bucket.due_at + 240),
      );
    } finally {
      await env.DB.prepare(
        'DELETE FROM email_digest_buckets WHERE user_id = ? AND frequency = ? AND due_at = ?',
      )
        .bind(bucket.user_id, bucket.frequency, bucket.due_at)
        .run();
    }
  });
  const admitted = sends.filter((send) => send !== undefined);
  await mapEmailBatch(admitted, (send) => send());
  return { attempted: admitted.length };
}
