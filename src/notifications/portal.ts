import { tenantProfile } from '../../shared/tenant-profile';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import type { Env } from '../env';

const encoder = new TextEncoder();

function bytesToHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function publisherSignature(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export type TaskAlertOutboxEvent = {
  id: number;
  kind: 'assignment' | 'comment' | 'mention' | 'deadline';
  occurredAt: string;
  taskKey: string;
  taskVersion: number;
  recipientPortalUserId: number;
  attempts: number;
};

export function taskAlertPublisherConfigured(env: Env) {
  return (
    tenantProfile.capabilities.portalAlerts &&
    Boolean(tenantExtensions().integrations?.portalAlerts?.endpoint) &&
    env.ENVIRONMENT === 'dev' &&
    typeof env.TASK_ALERT_PUBLISHER_SECRET === 'string' &&
    env.TASK_ALERT_PUBLISHER_SECRET.length >= 32
  );
}

async function recordTaskAlertFailure(env: Env, event: TaskAlertOutboxEvent, error: string) {
  const attempts = event.attempts + 1;
  const deadLettered = attempts >= 5;
  const delaySeconds = [60, 300, 1_800, 7_200, 21_600][Math.min(attempts - 1, 4)] ?? 21_600;
  await env.DB.prepare(
    `UPDATE notification_outbox
     SET status = ?, attempts = ?, last_error = ?,
       available_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = ?`,
  )
    .bind(
      deadLettered ? 'dead_letter' : 'pending',
      attempts,
      error.slice(0, 120),
      `+${delaySeconds} seconds`,
      event.id,
    )
    .run();
  return { status: deadLettered ? ('dead_letter' as const) : ('pending' as const) };
}

export async function deliverTaskAlertOutboxEvent(env: Env, event: TaskAlertOutboxEvent) {
  if (!taskAlertPublisherConfigured(env)) return { status: 'disabled' as const };
  const gateway = tenantExtensions().integrations?.portalAlerts;
  if (!gateway?.endpoint) return { status: 'disabled' as const };
  const prefix = gateway.headerPrefix ?? 'X-Tasks';
  const body = JSON.stringify({
    version: 1,
    environment: 'development',
    publisher: 'tasks',
    event: {
      id: `tasks.event.${event.id}`,
      kind: event.kind,
      occurred_at: event.occurredAt,
      task_key: event.taskKey,
      task_version: event.taskVersion,
      recipient_portal_user_ids: [event.recipientPortalUserId],
    },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await publisherSignature(
    env.TASK_ALERT_PUBLISHER_SECRET ?? '',
    `${timestamp}.${body}`,
  );
  const idempotencyKey = `tasks-alert-event-${event.id}`;
  try {
    const response = await fetch(gateway.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        [`${prefix}-Alert-Publisher`]: 'tasks',
        [`${prefix}-Timestamp`]: timestamp,
        [`${prefix}-Signature`]: `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return recordTaskAlertFailure(env, event, `http_${response.status}`);
    await env.DB.prepare(
      `UPDATE notification_outbox
       SET status = 'delivered', attempts = ?, last_error = NULL,
         delivered_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
    )
      .bind(event.attempts + 1, event.id)
      .run();
    return { status: 'delivered' as const };
  } catch (error) {
    return recordTaskAlertFailure(
      env,
      event,
      error instanceof Error ? error.name : 'request_failed',
    );
  }
}

export async function retryTaskAlertOutbox(env: Env) {
  if (!taskAlertPublisherConfigured(env)) return { attempted: 0 };
  await env.DB.prepare(
    `UPDATE notification_outbox
     SET status = 'pending', last_error = 'processing_timeout',
       available_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE status = 'processing'
       AND updated_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now','-15 minutes')`,
  ).run();
  await env.DB.prepare(
    `UPDATE notification_outbox
     SET status = 'dead_letter', last_error = 'recipient_access_revoked',
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE entity_type = 'task' AND status IN ('pending','failed')
       AND NOT EXISTS (
         SELECT 1
         FROM users u
         JOIN tasks t ON t.task_key = notification_outbox.entity_key
         JOIN projects p ON p.id = t.project_id
         JOIN workspace_members wm
           ON wm.workspace_id = p.workspace_id AND wm.user_id = u.id
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
         WHERE u.id = notification_outbox.user_id
           AND u.status = 'active' AND u.portal_db_id IS NOT NULL
           AND t.archived_at IS NULL AND p.archived_at IS NULL
           AND EXISTS (
             SELECT 1 FROM user_permissions view_up
             WHERE view_up.user_id = u.id
               AND view_up.permission_key IN ('tasks.view', 'tasks.personal', 'platform.admin')
           )
           AND (
             (p.project_type = 'personal' AND p.personal_owner_user_id = u.id)
             OR (p.project_type = 'shared' AND (
               EXISTS (
                 SELECT 1 FROM user_permissions shared_view_up
                 WHERE shared_view_up.user_id = u.id
                   AND shared_view_up.permission_key IN ('tasks.view', 'platform.admin')
               ) AND (
                 p.visibility = 'workspace'
                 OR wm.role IN ('owner','admin')
                 OR pm.user_id IS NOT NULL
                 OR EXISTS (
                   SELECT 1 FROM user_permissions manage_up
                   WHERE manage_up.user_id = u.id AND manage_up.permission_key = 'tasks.manage'
                 )
               )
             ))
           )
       )`,
  ).run();
  const pending = await env.DB.prepare(
    `SELECT o.id, o.kind, o.entity_key, o.task_version, o.created_at, o.attempts,
       u.portal_db_id
     FROM notification_outbox o
     JOIN users u ON u.id = o.user_id
     JOIN tasks t ON t.task_key = o.entity_key
     JOIN projects p ON p.id = t.project_id
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = u.id
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
     WHERE o.status IN ('pending','failed') AND o.available_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')
       AND o.entity_type = 'task' AND u.status = 'active' AND u.portal_db_id IS NOT NULL
       AND t.archived_at IS NULL AND p.archived_at IS NULL
       AND EXISTS (
         SELECT 1 FROM user_permissions view_up
         WHERE view_up.user_id = u.id
           AND view_up.permission_key IN ('tasks.view', 'tasks.personal', 'platform.admin')
       )
       AND (
         (p.project_type = 'personal' AND p.personal_owner_user_id = u.id)
         OR (p.project_type = 'shared' AND (
           EXISTS (
             SELECT 1 FROM user_permissions shared_view_up
             WHERE shared_view_up.user_id = u.id
               AND shared_view_up.permission_key IN ('tasks.view', 'platform.admin')
           ) AND (
             p.visibility = 'workspace'
             OR wm.role IN ('owner','admin')
             OR pm.user_id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM user_permissions manage_up
               WHERE manage_up.user_id = u.id AND manage_up.permission_key = 'tasks.manage'
             )
           )
         ))
       )
     ORDER BY o.available_at, o.id LIMIT 50`,
  ).all<{
    id: number;
    kind: TaskAlertOutboxEvent['kind'];
    entity_key: string;
    task_version: number;
    created_at: string;
    attempts: number;
    portal_db_id: number;
  }>();
  let attempted = 0;
  for (const row of pending.results) {
    const claimed = await env.DB.prepare(
      `UPDATE notification_outbox SET status = 'processing',
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ? AND status IN ('pending','failed')
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    )
      .bind(row.id)
      .run();
    if (claimed.meta.changes !== 1) continue;
    attempted += 1;
    await deliverTaskAlertOutboxEvent(env, {
      id: row.id,
      kind: row.kind,
      occurredAt: row.created_at,
      taskKey: row.entity_key,
      taskVersion: row.task_version,
      recipientPortalUserId: row.portal_db_id,
      attempts: row.attempts,
    });
  }
  return { attempted };
}
