import { tenantProfile, tenantTitle } from '../../shared/tenant-profile';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import type { Env } from '../env';
import { outboundLinkOrigin } from '../runtime/identity-config';
import { deliverTaskAlertOutboxEvent, taskAlertPublisherConfigured } from './portal';

export type NotificationKind = 'assignment' | 'comment' | 'mention' | 'deadline';
export type NotificationEntity = 'task' | 'event' | 'event_work_item' | 'deadline_digest';

export type NotificationDetail = {
  label: string;
  title: string;
  context: string;
  url: string;
};

export type UserNotification = {
  userId: number;
  actorUserId?: number | null;
  kind: NotificationKind;
  entityType: NotificationEntity;
  entityKey: string;
  dedupeKey: string;
  subject: string;
  heading: string;
  message: string;
  url: string;
  details?: NotificationDetail[];
  taskVersion?: number;
};

const preferenceColumns: Record<NotificationKind, { email: string; inApp: string; push: string }> =
  {
    assignment: {
      email: 'assignment_email',
      inApp: 'assignment_in_app',
      push: 'assignment_push',
    },
    comment: { email: 'comment_email', inApp: 'comment_in_app', push: 'comment_push' },
    mention: { email: 'mention_email', inApp: 'mention_in_app', push: 'mention_push' },
    deadline: { email: 'deadline_email', inApp: 'deadline_in_app', push: 'deadline_push' },
  };

function bytesToHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(value: string) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

export async function emailRequestSignature(secret: string, canonical: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
}

export function extractMentionHandles(body: string) {
  const handles = new Set<string>();
  for (const match of body.matchAll(/(^|\s)@([a-z0-9][a-z0-9._+-]{1,63})\b/gi)) {
    if (match[2]) handles.add(match[2].toLowerCase());
  }
  return [...handles];
}

function userHandles(user: { email: string; first_name: string; last_name: string }) {
  const local = user.email.split('@')[0]?.toLowerCase() ?? '';
  const first = user.first_name.trim().toLowerCase();
  const last = user.last_name.trim().toLowerCase();
  return new Set(
    [local, first && last ? `${first}.${last}` : '', first && last ? `${first}${last}` : ''].filter(
      Boolean,
    ),
  );
}

export async function mentionedUserIds(env: Env, body: string) {
  const handles = new Set(extractMentionHandles(body));
  if (handles.size === 0) return [];
  const users = await env.DB.prepare(
    `SELECT id, email, first_name, last_name FROM users WHERE status = 'active'`,
  ).all<{ id: number; email: string; first_name: string; last_name: string }>();
  return users.results
    .filter((user) => [...userHandles(user)].some((handle) => handles.has(handle)))
    .map((user) => user.id);
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function notificationPayload(input: {
  from: string;
  to: string;
  recipientName: string;
  subject: string;
  heading: string;
  message: string;
  url: string;
  details?: NotificationDetail[];
}) {
  const recipient = input.recipientName || input.to;
  const details = input.details ?? [];
  const detailText = details.length
    ? `\n\n${details
        .map((detail) => `${detail.label}: ${detail.title} — ${detail.context}\n${detail.url}`)
        .join('\n\n')}`
    : '';
  const detailHtml = details.length
    ? `<ul style="padding-left:20px">${details
        .map(
          (detail) =>
            `<li style="margin-bottom:12px"><strong>${escapeHtml(detail.title)}</strong><br><span style="color:#6b7280">${escapeHtml(detail.label)} · ${escapeHtml(detail.context)}</span><br><a href="${escapeHtml(detail.url)}">Open item</a></li>`,
        )
        .join('')}</ul>`
    : '';
  const product = tenantTitle();
  const text = `${input.heading}\n\n${input.message}${detailText}\n\nOpen in ${product}: ${input.url}`;
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#202124;line-height:1.5"><p>Hi ${escapeHtml(recipient)},</p><h2>${escapeHtml(input.heading)}</h2><p>${escapeHtml(input.message)}</p>${detailHtml}<p><a href="${escapeHtml(input.url)}" style="background:${escapeHtml(tenantProfile.branding.light.accent)};color:${escapeHtml(tenantProfile.branding.light.onAccent)};padding:10px 16px;border-radius:6px;text-decoration:none">Open in ${escapeHtml(product)}</a></p><p style="color:#6b7280;font-size:13px">This is an automated workflow notification from ${escapeHtml(product)}.</p></body></html>`;
  return {
    from: { email: input.from, name: product },
    to: { email: input.to, name: recipient },
    subject: input.subject,
    html,
    text,
  };
}

export function notificationsConfigured(env: Env) {
  // Development exercises the gateway only through the explicit manual smoke job. Automatic
  // application notifications must never use staff addresses from the copied development dataset.
  if (!tenantProfile.capabilities.emailNotifications || env.ENVIRONMENT !== 'production') {
    return false;
  }
  try {
    const endpoint = new URL(env.EMAIL_API_ENDPOINT ?? '');
    return (
      endpoint.protocol === 'https:' &&
      endpoint.origin === tenantProfile.integrations.emailGateway.productionOrigin &&
      env.EMAIL_API_CLIENT_ID === tenantProfile.integrations.emailGateway.clientId &&
      (env.EMAIL_API_SECRET?.length ?? 0) >= 32 &&
      env.EMAIL_FROM === tenantProfile.integrations.emailGateway.fromEmail
    );
  } catch {
    return false;
  }
}

async function canReceiveTaskNotification(env: Env, userId: number, taskKey: string) {
  const access = await env.DB.prepare(
    `SELECT 1 AS allowed
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = wm.user_id
     WHERE t.task_key = ? AND t.archived_at IS NULL AND p.archived_at IS NULL
       AND EXISTS (
         SELECT 1 FROM user_permissions view_up
         WHERE view_up.user_id = wm.user_id
           AND view_up.permission_key IN ('tasks.view', 'tasks.personal', 'platform.admin')
       )
       AND (
         (p.project_type = 'personal' AND p.personal_owner_user_id = wm.user_id)
         OR (p.project_type = 'shared' AND (
           EXISTS (
             SELECT 1 FROM user_permissions shared_view_up
             WHERE shared_view_up.user_id = wm.user_id
               AND shared_view_up.permission_key IN ('tasks.view', 'platform.admin')
           ) AND (
             p.visibility = 'workspace'
             OR wm.role IN ('owner','admin')
             OR pm.user_id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM user_permissions manage_up
               WHERE manage_up.user_id = wm.user_id AND manage_up.permission_key = 'tasks.manage'
             )
           )
         ))
       )`,
  )
    .bind(userId, taskKey)
    .first<{ allowed: number }>();
  return Boolean(access?.allowed);
}

export function taskNotificationOutboxStatement(
  env: Env,
  notification: UserNotification,
  requiredAuditRequestId: string,
) {
  if (
    !taskAlertPublisherConfigured(env) ||
    notification.entityType !== 'task' ||
    !notification.taskVersion
  ) {
    return null;
  }
  const preferences = preferenceColumns[notification.kind];
  return env.DB.prepare(
    `INSERT OR IGNORE INTO notification_outbox (
       dedupe_key, user_id, actor_user_id, kind, entity_type, entity_key,
       task_version, in_app_requested, push_requested
     )
     SELECT ?, u.id, ?, ?, 'task', t.task_key, t.version,
       COALESCE(p.${preferences.inApp}, 0), COALESCE(p.${preferences.push}, 0)
     FROM users u
     JOIN tasks t ON t.task_key = ?
     JOIN projects project ON project.id = t.project_id
     JOIN workspace_members wm ON wm.workspace_id = project.workspace_id AND wm.user_id = u.id
     LEFT JOIN project_members pm ON pm.project_id = project.id AND pm.user_id = u.id
     LEFT JOIN user_notification_preferences p ON p.user_id = u.id
     WHERE u.id = ? AND u.status = 'active' AND u.portal_db_id IS NOT NULL
       AND (? IS NULL OR u.id <> ?)
       AND t.archived_at IS NULL AND project.archived_at IS NULL AND t.version = ?
       AND EXISTS (
         SELECT 1 FROM user_permissions view_up
         WHERE view_up.user_id = u.id
           AND view_up.permission_key IN ('tasks.view', 'tasks.personal', 'platform.admin')
       )
       AND (
         (project.project_type = 'personal' AND project.personal_owner_user_id = u.id)
         OR (project.project_type = 'shared' AND (
           EXISTS (
             SELECT 1 FROM user_permissions shared_view_up
             WHERE shared_view_up.user_id = u.id
               AND shared_view_up.permission_key IN ('tasks.view', 'platform.admin')
           ) AND (
             project.visibility = 'workspace'
             OR wm.role IN ('owner','admin')
             OR pm.user_id IS NOT NULL
             OR EXISTS (
               SELECT 1 FROM user_permissions manage_up
               WHERE manage_up.user_id = u.id AND manage_up.permission_key = 'tasks.manage'
             )
           )
         ))
       )
       AND (COALESCE(p.${preferences.inApp}, 0) = 1 OR COALESCE(p.${preferences.push}, 0) = 1)
       AND EXISTS (
         SELECT 1 FROM audit_events ae WHERE ae.request_id = ?
       )`,
  ).bind(
    notification.dedupeKey,
    notification.actorUserId ?? null,
    notification.kind,
    notification.entityKey,
    notification.userId,
    notification.actorUserId ?? null,
    notification.actorUserId ?? null,
    notification.taskVersion,
    requiredAuditRequestId,
  );
}

export async function sendUserNotification(env: Env, notification: UserNotification) {
  if (notification.userId === notification.actorUserId) {
    return { status: 'skipped' as const };
  }
  if (
    notification.entityType === 'task' &&
    !(await canReceiveTaskNotification(env, notification.userId, notification.entityKey))
  ) {
    return { status: 'skipped' as const };
  }
  const preferences = preferenceColumns[notification.kind];
  const user = await env.DB.prepare(
    `SELECT u.email, u.portal_db_id,
       COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name,
       COALESCE((SELECT ${preferences.email} FROM user_notification_preferences p WHERE p.user_id = u.id), 1) AS email_enabled,
       COALESCE((SELECT ${preferences.inApp} FROM user_notification_preferences p WHERE p.user_id = u.id), 0) AS in_app_enabled,
       COALESCE((SELECT ${preferences.push} FROM user_notification_preferences p WHERE p.user_id = u.id), 0) AS push_enabled
     FROM users u WHERE u.id = ? AND u.status = 'active'`,
  )
    .bind(notification.userId)
    .first<{
      email: string;
      name: string;
      email_enabled: number;
      in_app_enabled: number;
      push_enabled: number;
      portal_db_id: number | null;
    }>();
  if (!user) return { status: 'skipped' as const };

  let outboxReserved = false;
  if (
    notification.entityType === 'task' &&
    notification.taskVersion &&
    user.portal_db_id &&
    taskAlertPublisherConfigured(env) &&
    (user.in_app_enabled || user.push_enabled)
  ) {
    const reservation = await env.DB.prepare(
      `INSERT OR IGNORE INTO notification_outbox (
         dedupe_key, user_id, actor_user_id, kind, entity_type, entity_key,
         task_version, in_app_requested, push_requested
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        notification.dedupeKey,
        notification.userId,
        notification.actorUserId ?? null,
        notification.kind,
        notification.entityType,
        notification.entityKey,
        notification.taskVersion,
        user.in_app_enabled ? 1 : 0,
        user.push_enabled ? 1 : 0,
      )
      .run();
    outboxReserved = reservation.meta.changes === 1;
    const outbox = await env.DB.prepare(
      `SELECT id, created_at, attempts FROM notification_outbox
       WHERE dedupe_key = ? AND user_id = ? AND status IN ('pending','failed')
         AND available_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
    )
      .bind(notification.dedupeKey, notification.userId)
      .first<{ id: number; created_at: string; attempts: number }>();
    if (outbox) {
      const claimed = await env.DB.prepare(
        `UPDATE notification_outbox SET status = 'processing',
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = ? AND status IN ('pending','failed')
           AND available_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
      )
        .bind(outbox.id)
        .run();
      if (claimed.meta.changes === 1) {
        await deliverTaskAlertOutboxEvent(env, {
          id: outbox.id,
          kind: notification.kind,
          occurredAt: outbox.created_at,
          taskKey: notification.entityKey,
          taskVersion: notification.taskVersion,
          recipientPortalUserId: user.portal_db_id,
          attempts: outbox.attempts,
        });
      }
    }
  }

  if (!user.email_enabled || !notificationsConfigured(env)) {
    return { status: 'skipped' as const, outboxReserved };
  }

  const reserved = await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_deliveries
       (dedupe_key, user_id, kind, entity_type, entity_key)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      notification.dedupeKey,
      notification.userId,
      notification.kind,
      notification.entityType,
      notification.entityKey,
    )
    .run();
  if (!reserved.meta.changes) {
    const existing = await env.DB.prepare(
      'SELECT status FROM notification_deliveries WHERE dedupe_key = ?',
    )
      .bind(notification.dedupeKey)
      .first<{ status: string }>();
    if (existing?.status === 'accepted') return { status: 'duplicate' as const };
    await env.DB.prepare(
      `UPDATE notification_deliveries SET status = 'pending', error_code = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE dedupe_key = ?`,
    )
      .bind(notification.dedupeKey)
      .run();
  }

  const body = JSON.stringify(
    notificationPayload({
      from: env.EMAIL_FROM ?? '',
      to: user.email,
      recipientName: user.name,
      subject: notification.subject,
      heading: notification.heading,
      message: notification.message,
      url: notification.url,
      ...(notification.details ? { details: notification.details } : {}),
    }),
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const headerPrefix = tenantExtensions().integrations?.emailGateway?.headerPrefix ?? 'X-Tasks';
  const path = '/v1/email';
  const requestId = `tasks-${(await sha256(notification.dedupeKey)).slice(0, 48)}`;
  const bodyDigest = await sha256(body);
  const canonical = `${timestamp}\nPOST\n${path}\n${requestId}\n${bodyDigest}`;
  const signature = await emailRequestSignature(env.EMAIL_API_SECRET ?? '', canonical);
  try {
    const response = await fetch(new URL(path, env.EMAIL_API_ENDPOINT).toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [`${headerPrefix}-Client`]: env.EMAIL_API_CLIENT_ID ?? '',
        [`${headerPrefix}-Timestamp`]: timestamp,
        [`${headerPrefix}-Signature`]: `v1=${signature}`,
        'Idempotency-Key': requestId,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    await env.DB.prepare(
      `UPDATE notification_deliveries SET email_request_id = ?, status = ?, error_code = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE dedupe_key = ?`,
    )
      .bind(
        requestId,
        response.ok ? 'accepted' : 'failed',
        response.ok ? null : (result.error ?? `http_${response.status}`),
        notification.dedupeKey,
      )
      .run();
    return { status: response.ok ? ('accepted' as const) : ('failed' as const), requestId };
  } catch (error) {
    const code = error instanceof Error ? error.name.slice(0, 100) : 'request_failed';
    await env.DB.prepare(
      `UPDATE notification_deliveries SET email_request_id = ?, status = 'failed', error_code = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE dedupe_key = ?`,
    )
      .bind(requestId, code, notification.dedupeKey)
      .run();
    return { status: 'failed' as const, requestId };
  }
}

export function taskUrl(env: Env, taskKey: string) {
  const origin = outboundLinkOrigin(env);
  return `${origin}/?task=${encodeURIComponent(taskKey)}&view=open`;
}

export function eventUrl(env: Env, eventKey: string) {
  const origin = outboundLinkOrigin(env);
  return `${origin}/events/${encodeURIComponent(eventKey)}?view=open`;
}

export function myTasksUrl(env: Env) {
  const origin = outboundLinkOrigin(env);
  return `${origin}/?view=mine`;
}
