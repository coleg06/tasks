import type { Env } from '../env';
import type { EmailDeliveryPreferences, EmailFrequency } from '../shared/schemas';
import type { NotificationKind, UserNotification } from './email';

export const defaultEmailDeliveryPreferences: EmailDeliveryPreferences = {
  hardLimit: 5,
  period: 'day',
  assignments: 'immediate',
  comments: 'immediate',
  mentions: 'immediate',
  deadlines: 'immediate',
};
export const emailPeriodSeconds = { hour: 3600, day: 86400, week: 604800 } as const;
export const emailCategory = {
  assignment: 'assignments',
  comment: 'comments',
  mention: 'mentions',
  deadline: 'deadlines',
} as const;
export type DigestFrequency = Exclude<EmailFrequency, 'immediate' | 'off'>;
export const digestSeconds = { hourly: 3600, daily: 86400, weekly: 604800 } as const;

export async function readEmailDeliverySettings(env: Env) {
  const row = await env.DB.prepare(
    'SELECT per_minute FROM email_delivery_settings WHERE id = 1',
  ).first<{ per_minute: number }>();
  return { perMinute: row?.per_minute ?? 5 };
}

export async function readEmailDeliveryPreferences(env: Env, userId: number) {
  const row =
    await env.DB.prepare(`SELECT hard_limit, period_seconds, assignment, comment, mention, deadline
    FROM email_delivery_preferences WHERE user_id = ?`)
      .bind(userId)
      .first<{
        hard_limit: number;
        period_seconds: number;
        assignment: EmailFrequency;
        comment: EmailFrequency;
        mention: EmailFrequency;
        deadline: EmailFrequency;
      }>();
  const legacy =
    await env.DB.prepare(`SELECT assignment_email, comment_email, mention_email, deadline_email
    FROM user_notification_preferences WHERE user_id = ?`)
      .bind(userId)
      .first<Record<string, number>>();
  return {
    hardLimit: row?.hard_limit ?? 5,
    period: row?.period_seconds === 3600 ? 'hour' : row?.period_seconds === 604800 ? 'week' : 'day',
    assignments: legacy?.assignment_email === 0 ? 'off' : (row?.assignment ?? 'immediate'),
    comments: legacy?.comment_email === 0 ? 'off' : (row?.comment ?? 'immediate'),
    mentions: legacy?.mention_email === 0 ? 'off' : (row?.mention ?? 'immediate'),
    deadlines: legacy?.deadline_email === 0 ? 'off' : (row?.deadline ?? 'immediate'),
  } satisfies EmailDeliveryPreferences;
}

export function emailDeliveryPreferenceStatements(
  env: Env,
  userId: number,
  p: EmailDeliveryPreferences,
) {
  return [
    env.DB.prepare(`INSERT INTO email_delivery_preferences
      (user_id, hard_limit, period_seconds, assignment, comment, mention, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      hard_limit = excluded.hard_limit, period_seconds = excluded.period_seconds,
      assignment = excluded.assignment, comment = excluded.comment,
      mention = excluded.mention, deadline = excluded.deadline`).bind(
      userId,
      p.hardLimit,
      emailPeriodSeconds[p.period],
      p.assignments,
      p.comments,
      p.mentions,
      p.deadlines,
    ),
    env.DB.prepare(`INSERT INTO user_notification_preferences
      (user_id, assignment_email, comment_email, mention_email, deadline_email)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      assignment_email = excluded.assignment_email, comment_email = excluded.comment_email,
      mention_email = excluded.mention_email, deadline_email = excluded.deadline_email,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`).bind(
      userId,
      p.assignments !== 'off',
      p.comments !== 'off',
      p.mentions !== 'off',
      p.deadlines !== 'off',
    ),
    // A settings change cannot resurrect old content or repurpose a previous interval.
    env.DB.prepare('DELETE FROM email_digest_buckets WHERE user_id = ?').bind(userId),
  ];
}

/** A single serialized SQL write checks and consumes BOTH limits, on SQLite and D1. */
export async function reserveEmailQuota(
  env: Env,
  userId: number,
  dedupeKey: string,
  dispatchAt?: number,
) {
  const result =
    await env.DB.prepare(`INSERT OR IGNORE INTO email_send_attempts (dedupe_key, user_id)
    SELECT ?, u.id FROM users u
    LEFT JOIN email_delivery_preferences p ON p.user_id = u.id
    JOIN email_delivery_settings s ON s.id = 1
    WHERE u.id = ? AND u.status = 'active'
      AND (? IS NULL OR unixepoch() < ? + 60)
      AND (SELECT COUNT(*) FROM email_send_attempts WHERE reserved_at > COALESCE(?, unixepoch()) - 60) < s.per_minute
      AND (SELECT COUNT(*) FROM email_send_attempts WHERE user_id = u.id
        AND reserved_at > unixepoch() - COALESCE(p.period_seconds, 86400)) < COALESCE(p.hard_limit, 5)`)
      .bind(dedupeKey, userId, dispatchAt ?? null, dispatchAt ?? null, dispatchAt ?? null)
      .run();
  return result.meta.changes === 1;
}

// A final admission may spend at most five seconds returning from the database before fetch.
// Count its lease deadline (rounded up by one second), so it remains charged for a full
// rolling minute AFTER any permitted submission, even if the database response stalls.
export const emailSendLeaseMs = 5_000;
export async function claimEmailSend(env: Env, dedupeKey: string, dispatchAt?: number) {
  const result = await env.DB.prepare(`UPDATE email_send_attempts
    SET reserved_at = unixepoch() + 6, send_claimed = 1
    WHERE dedupe_key = ? AND send_claimed = 0 AND reserved_at > unixepoch() - 60
      AND (? IS NULL OR unixepoch() < ? + 60)
      AND EXISTS (SELECT 1 FROM users u
        LEFT JOIN email_delivery_preferences p ON p.user_id = u.id
        JOIN email_delivery_settings s ON s.id = 1
        WHERE u.id = email_send_attempts.user_id AND u.status = 'active'
          AND (SELECT COUNT(*) FROM email_send_attempts a
            WHERE a.dedupe_key <> ? AND a.reserved_at > unixepoch() - 60) < s.per_minute
          AND (SELECT COUNT(*) FROM email_send_attempts a WHERE a.user_id = u.id
            AND a.dedupe_key <> ? AND a.reserved_at > unixepoch() - COALESCE(p.period_seconds, 86400))
            < COALESCE(p.hard_limit, 5))`)
    .bind(dedupeKey, dispatchAt ?? null, dispatchAt ?? null, dedupeKey, dedupeKey)
    .run();
  return result.meta.changes === 1;
}

export function digestDueAt(frequency: DigestFrequency, now: number) {
  // Weekly UTC Monday; hour/day are natural UTC boundaries.
  const seconds = digestSeconds[frequency];
  const offset = frequency === 'weekly' ? 345600 : 0;
  return Math.floor((now - offset) / seconds) * seconds + offset + seconds;
}

export async function aggregateDigest(env: Env, n: UserNotification, frequency: DigestFrequency) {
  if (n.entityType === 'deadline_digest' || n.entityKey.length > 100) return;
  const now = Math.floor(Date.now() / 1000);
  const due = digestDueAt(frequency, now);
  await env.DB.batch([
    // Expire old intervals; keep the just-due bucket during its five-minute dispatch grace.
    env.DB.prepare(
      `DELETE FROM email_digest_buckets WHERE user_id = ? AND frequency = ? AND due_at < ?`,
    ).bind(n.userId, frequency, now - 300),
    env.DB.prepare(
      `INSERT OR IGNORE INTO email_digest_buckets (user_id, frequency, due_at) VALUES (?, ?, ?)`,
    ).bind(n.userId, frequency, due),
    env.DB.prepare(`INSERT OR IGNORE INTO email_digest_items
      (user_id, frequency, due_at, kind, entity_type, entity_key)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM email_digest_buckets
        WHERE user_id = ? AND frequency = ? AND due_at = ? AND claimed = 0)
      AND (SELECT COUNT(*) FROM email_digest_items WHERE user_id = ? AND frequency = ? AND due_at = ?) < 25`).bind(
      n.userId,
      frequency,
      due,
      n.kind,
      n.entityType,
      n.entityKey,
      n.userId,
      frequency,
      due,
      n.userId,
      frequency,
      due,
    ),
  ]);
}

export async function emailFrequencyFor(env: Env, userId: number, kind: NotificationKind) {
  return (await readEmailDeliveryPreferences(env, userId))[emailCategory[kind]];
}

/** Bounded work; callers collect every admission decision before running network sends. */
export async function mapEmailBatch<T, R>(items: T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(5, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        const item = items[index];
        if (item !== undefined) results[index] = await work(item);
      }
    }),
  );
  const failure = workers.find((worker) => worker.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return results;
}
