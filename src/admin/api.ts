import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { resolveRuntimeFeatures } from '../../shared/runtime-features';
import { tenantProfile } from '../../shared/tenant-profile';
import {
  effectivePermissionKeys,
  PLATFORM_ADMIN_PERMISSION,
  userHasPermission,
} from '../auth/permissions';
import { SESSION_COOKIE, type SessionClaims, signSession, verifySession } from '../auth/session';
import type { Env } from '../env';
import { logApplicationError } from '../logging';
import { notificationsConfigured } from '../notifications/email';
import { taskAlertPublisherConfigured } from '../notifications/portal';
import type { SqlStatement } from '../platform/ports';
import { isHostedEmail } from '../runtime/identity-config';
import { auditStatement, requireTasksSession, type TaskAppEnv } from '../tasks/api';

type AppContext = Context<TaskAppEnv>;

export async function getAdminOverview(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const overview = await Promise.all([
    context.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) AS users,
        (SELECT COUNT(*) FROM projects
          WHERE archived_at IS NULL AND project_type = 'shared') AS projects,
        (SELECT COUNT(*) FROM tasks WHERE archived_at IS NULL) AS tasks,
        (SELECT COUNT(*) FROM task_comments WHERE deleted_at IS NULL) AS comments`,
    ).first<{ users: number; projects: number; tasks: number; comments: number }>(),
    context.env.DB.prepare(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.photo_url, u.google_subject,
         u.created_at,
         COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name,
         u.status, u.last_seen_at,
         COALESCE(GROUP_CONCAT(up.permission_key, ','), '') AS permissions
       FROM users u
       LEFT JOIN user_permissions up ON up.user_id = u.id
       GROUP BY u.id
       ORDER BY u.status, name, u.email`,
    ).all<{
      id: number;
      email: string;
      first_name: string;
      last_name: string;
      photo_url: string | null;
      google_subject: string | null;
      created_at: string;
      name: string;
      status: string;
      last_seen_at: string | null;
      permissions: string;
    }>(),
    context.env.DB.prepare(
      `SELECT p.project_key, p.name, p.visibility, w.name AS workspace_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.archived_at IS NULL) AS task_count,
         (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count
       FROM projects p JOIN workspaces w ON w.id = p.workspace_id
       WHERE p.archived_at IS NULL AND p.project_type = 'shared' ORDER BY w.name, p.name`,
    ).all<{
      project_key: string;
      name: string;
      visibility: string;
      workspace_name: string;
      task_count: number;
      member_count: number;
    }>(),
    context.env.DB.prepare(
      `SELECT ae.id, ae.entity_type, ae.entity_key, ae.action, ae.changes_json,
         ae.request_id, ae.created_at,
         COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email, 'System') AS actor_name,
         u.email AS actor_email
       FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_user_id
       ORDER BY ae.id DESC LIMIT 100`,
    ).all<{
      id: number;
      entity_type: string;
      entity_key: string;
      action: string;
      changes_json: string;
      request_id: string | null;
      created_at: string;
      actor_name: string;
      actor_email: string | null;
    }>(),
    context.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'accepted'
           AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours') THEN 1 ELSE 0 END), 0)
           AS accepted_24h,
         COALESCE(SUM(CASE WHEN status = 'failed'
           AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours') THEN 1 ELSE 0 END), 0)
           AS failed_24h,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS unresolved_failed,
         COALESCE(SUM(CASE WHEN status = 'pending'
           AND updated_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now','-15 minutes') THEN 1 ELSE 0 END), 0)
           AS stalled_pending,
         MAX(CASE WHEN status = 'accepted' THEN updated_at END) AS last_accepted_at,
         MAX(CASE WHEN status = 'failed' THEN updated_at END) AS last_failed_at
       FROM notification_deliveries`,
    ).first<{
      accepted_24h: number;
      failed_24h: number;
      unresolved_failed: number;
      stalled_pending: number;
      last_accepted_at: string | null;
      last_failed_at: string | null;
    }>(),
    context.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'delivered'
           AND delivered_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours') THEN 1 ELSE 0 END), 0)
           AS delivered_24h,
         COALESCE(SUM(CASE WHEN status = 'pending'
           AND available_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now') THEN 1 ELSE 0 END), 0)
           AS ready_to_retry,
         COALESCE(SUM(CASE WHEN status = 'processing'
           AND updated_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now','-15 minutes') THEN 1 ELSE 0 END), 0)
           AS stalled_processing,
         COALESCE(SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END), 0) AS dead_letter,
         MAX(CASE WHEN status = 'delivered' THEN delivered_at END) AS last_delivered_at
       FROM notification_outbox`,
    ).first<{
      delivered_24h: number;
      ready_to_retry: number;
      stalled_processing: number;
      dead_letter: number;
      last_delivered_at: string | null;
    }>(),
    context.env.DB.prepare(
      `SELECT nd.id, nd.kind, nd.entity_type, nd.entity_key, nd.status, nd.error_code,
         nd.email_request_id, nd.created_at, nd.updated_at,
         COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS recipient_name,
         u.email AS recipient_email
       FROM notification_deliveries nd JOIN users u ON u.id = nd.user_id
       ORDER BY nd.id DESC LIMIT 30`,
    ).all<{
      id: number;
      kind: string;
      entity_type: string;
      entity_key: string;
      status: string;
      error_code: string | null;
      email_request_id: string | null;
      created_at: string;
      updated_at: string;
      recipient_name: string;
      recipient_email: string;
    }>(),
    context.env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN severity = 'error'
           AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours') THEN 1 ELSE 0 END), 0)
           AS errors_24h,
         COALESCE(SUM(CASE WHEN severity = 'warning'
           AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-24 hours') THEN 1 ELSE 0 END), 0)
           AS warnings_24h,
         MAX(created_at) AS last_event_at
       FROM operational_events`,
    ).first<{ errors_24h: number; warnings_24h: number; last_event_at: string | null }>(),
    context.env.DB.prepare(
      `SELECT oe.id, oe.severity, oe.event, oe.source, oe.request_id, oe.method, oe.path,
         oe.status_code, oe.message, oe.details_json, oe.created_at,
         COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS actor_name,
         u.email AS actor_email
       FROM operational_events oe LEFT JOIN users u ON u.id = oe.actor_user_id
       ORDER BY oe.id DESC LIMIT 100`,
    ).all<{
      id: number;
      severity: 'warning' | 'error';
      event: string;
      source: string;
      request_id: string | null;
      method: string | null;
      path: string | null;
      status_code: number | null;
      message: string;
      details_json: string;
      created_at: string;
      actor_name: string | null;
      actor_email: string | null;
    }>(),
  ]);
  const [
    stats,
    users,
    projects,
    events,
    emailHealth,
    portalAlertHealth,
    recentEmailDeliveries,
    operationalHealth,
    operationalEvents,
  ] = overview;
  return context.json({
    stats: stats ?? { users: 0, projects: 0, tasks: 0, comments: 0 },
    users: users.results.map((user) => ({
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      name: user.name,
      photoUrl: user.photo_url,
      hasSignedIn: Boolean(user.google_subject),
      createdAt: user.created_at,
      status: user.status,
      lastSeenAt: user.last_seen_at,
      permissions: user.permissions ? user.permissions.split(',').sort() : [],
    })),
    projects: projects.results.map((project) => ({
      key: project.project_key,
      name: project.name,
      visibility: project.visibility,
      workspaceName: project.workspace_name,
      taskCount: project.task_count,
      memberCount: project.member_count,
    })),
    events: events.results.map((event) => ({
      id: event.id,
      entityType: event.entity_type,
      entityKey: event.entity_key,
      action: event.action,
      changes: JSON.parse(event.changes_json),
      requestId: event.request_id,
      createdAt: event.created_at,
      actor: { name: event.actor_name, email: event.actor_email },
    })),
    notificationHealth: {
      environment: context.env.ENVIRONMENT,
      emailConfigured: notificationsConfigured(context.env),
      portalAlertsConfigured: taskAlertPublisherConfigured(context.env),
      email: {
        accepted24h: emailHealth?.accepted_24h ?? 0,
        failed24h: emailHealth?.failed_24h ?? 0,
        unresolvedFailed: emailHealth?.unresolved_failed ?? 0,
        stalledPending: emailHealth?.stalled_pending ?? 0,
        lastAcceptedAt: emailHealth?.last_accepted_at ?? null,
        lastFailedAt: emailHealth?.last_failed_at ?? null,
      },
      portalAlerts: {
        delivered24h: portalAlertHealth?.delivered_24h ?? 0,
        readyToRetry: portalAlertHealth?.ready_to_retry ?? 0,
        stalledProcessing: portalAlertHealth?.stalled_processing ?? 0,
        deadLetter: portalAlertHealth?.dead_letter ?? 0,
        lastDeliveredAt: portalAlertHealth?.last_delivered_at ?? null,
      },
      recentEmailDeliveries: recentEmailDeliveries.results.map((delivery) => ({
        id: delivery.id,
        kind: delivery.kind,
        entityType: delivery.entity_type,
        entityKey: delivery.entity_key,
        status: delivery.status,
        errorCode: delivery.error_code,
        requestId: delivery.email_request_id,
        createdAt: delivery.created_at,
        updatedAt: delivery.updated_at,
        recipient: { name: delivery.recipient_name, email: delivery.recipient_email },
      })),
    },
    operationalHealth: {
      errors24h: operationalHealth?.errors_24h ?? 0,
      warnings24h: operationalHealth?.warnings_24h ?? 0,
      lastEventAt: operationalHealth?.last_event_at ?? null,
      recentEvents: operationalEvents.results.map((event) => ({
        id: event.id,
        severity: event.severity,
        event: event.event,
        source: event.source,
        requestId: event.request_id,
        method: event.method,
        path: event.path,
        statusCode: event.status_code,
        message: event.message,
        details: JSON.parse(event.details_json) as Record<string, unknown>,
        createdAt: event.created_at,
        actor: event.actor_name ? { name: event.actor_name, email: event.actor_email } : null,
      })),
    },
  });
}

export async function updateAdminUser(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const eventsEnabled = resolveRuntimeFeatures(context.env.FEATURE_MODULES).events;
  const userId = Number(context.req.param('userId'));
  if (!Number.isInteger(userId) || userId < 1) return context.json({ error: 'invalid_user' }, 400);
  const input = await context.req.json<{
    status?: unknown;
    email?: unknown;
    firstName?: unknown;
    lastName?: unknown;
    hasTaskAccess?: unknown;
    isManager?: unknown;
    isEventManager?: unknown;
    canApproveEvents?: unknown;
    isPlatformAdmin?: unknown;
  }>();
  const actorIsPlatformAdmin = await userHasPermission(
    context.env,
    identity.user.id,
    PLATFORM_ADMIN_PERMISSION,
  );
  const target = await context.env.DB.prepare(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.google_subject, u.status,
       EXISTS(SELECT 1 FROM user_permissions up
         WHERE up.user_id = u.id AND up.permission_key = 'tasks.manage') AS is_manager,
       EXISTS(SELECT 1 FROM user_permissions up
         WHERE up.user_id = u.id AND up.permission_key = 'events.manage') AS is_event_manager,
       EXISTS(SELECT 1 FROM user_permissions up
         WHERE up.user_id = u.id AND up.permission_key = 'events.approve') AS can_approve_events,
       EXISTS(SELECT 1 FROM user_permissions up
         WHERE up.user_id = u.id AND up.permission_key = 'tasks.view') AS has_task_access,
       EXISTS(SELECT 1 FROM user_permissions up
         WHERE up.user_id = u.id AND up.permission_key = 'platform.admin') AS is_platform_admin
     FROM users u WHERE u.id = ?`,
  )
    .bind(userId)
    .first<{
      id: number;
      email: string;
      first_name: string;
      last_name: string;
      google_subject: string | null;
      status: string;
      is_manager: number;
      is_event_manager: number;
      can_approve_events: number;
      has_task_access: number;
      is_platform_admin: number;
    }>();
  if (!target) return context.json({ error: 'not_found' }, 404);
  // A manager must not be able to demote, disable or otherwise edit a platform administrator.
  if (target.is_platform_admin && !actorIsPlatformAdmin) {
    return context.json({ error: 'platform_admin_required' }, 403);
  }
  const firstName =
    input.firstName === undefined
      ? target.first_name
      : String(input.firstName).trim().slice(0, 120);
  const lastName =
    input.lastName === undefined ? target.last_name : String(input.lastName).trim().slice(0, 120);
  const email = input.email === undefined ? target.email : String(input.email).trim().toLowerCase();
  if (!isHostedEmail(context.env, email)) {
    return context.json({ error: 'hosted_email_required' }, 400);
  }
  if (email !== target.email.toLowerCase() && target.google_subject) {
    return context.json({ error: 'signed_in_email_locked' }, 400);
  }
  const duplicate = await context.env.DB.prepare(
    'SELECT id FROM users WHERE email = ? COLLATE NOCASE AND id <> ?',
  )
    .bind(email, userId)
    .first<{ id: number }>();
  if (duplicate) return context.json({ error: 'email_in_use' }, 409);
  const status =
    input.status === undefined
      ? target.status
      : input.status === 'disabled'
        ? 'disabled'
        : 'active';
  const isPlatformAdmin =
    input.isPlatformAdmin === undefined
      ? Boolean(target.is_platform_admin)
      : input.isPlatformAdmin === true;
  if (isPlatformAdmin !== Boolean(target.is_platform_admin) && !actorIsPlatformAdmin) {
    return context.json({ error: 'platform_admin_required' }, 403);
  }
  if (target.id === identity.user.id && target.is_platform_admin && !isPlatformAdmin) {
    return context.json({ error: 'cannot_remove_own_platform_admin_access' }, 400);
  }
  const isManager =
    isPlatformAdmin ||
    (input.isManager === undefined ? Boolean(target.is_manager) : input.isManager === true);
  const hasTaskAccess =
    input.hasTaskAccess === undefined
      ? Boolean(target.has_task_access)
      : input.hasTaskAccess === true || isManager;
  const isEventManager =
    eventsEnabled &&
    (isPlatformAdmin ||
      (input.isEventManager === undefined
        ? Boolean(target.is_event_manager)
        : input.isEventManager === true));
  const canApproveEvents =
    eventsEnabled &&
    (isPlatformAdmin ||
      (input.canApproveEvents === undefined
        ? Boolean(target.can_approve_events)
        : input.canApproveEvents === true));
  if (
    target.id === identity.user.id &&
    (status === 'disabled' || (!isManager && !isPlatformAdmin))
  ) {
    return context.json({ error: 'cannot_remove_own_admin_access' }, 400);
  }
  await context.env.DB.prepare(
    `UPDATE users SET email = ?, first_name = ?, last_name = ?, status = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
  )
    .bind(email, firstName, lastName, status, userId)
    .run();
  const accessStatements: SqlStatement[] = [
    isPlatformAdmin
      ? context.env.DB.prepare(
          `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
           SELECT ?, key FROM permissions WHERE ? = 1 OR key NOT LIKE 'events.%'`,
        ).bind(userId, eventsEnabled ? 1 : 0)
      : context.env.DB.prepare(
          `DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'platform.admin'`,
        ).bind(userId),
    hasTaskAccess
      ? context.env.DB.prepare(
          `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'tasks.view')`,
        ).bind(userId)
      : context.env.DB.prepare(
          `DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'tasks.view'`,
        ).bind(userId),
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'tasks.personal')`,
    ).bind(userId),
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'tasks.comment')`,
    ).bind(userId),
    isManager
      ? context.env.DB.prepare(
          `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'tasks.manage')`,
        ).bind(userId)
      : context.env.DB.prepare(
          `DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'tasks.manage'`,
        ).bind(userId),
  ];
  if (eventsEnabled) {
    accessStatements.push(
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'events.view')`,
      ).bind(userId),
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'events.create')`,
      ).bind(userId),
      isEventManager
        ? context.env.DB.prepare(
            `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'events.manage')`,
          ).bind(userId)
        : context.env.DB.prepare(
            `DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'events.manage'`,
          ).bind(userId),
      canApproveEvents
        ? context.env.DB.prepare(
            `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'events.approve')`,
          ).bind(userId)
        : context.env.DB.prepare(
            `DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'events.approve'`,
          ).bind(userId),
    );
  }
  accessStatements.push(
    auditStatement(context, identity.auditUserId, 'user', email, 'user.access_updated', {
      before: {
        email: target.email,
        firstName: target.first_name,
        lastName: target.last_name,
        status: target.status,
        hasTaskAccess: Boolean(target.has_task_access),
        isManager: Boolean(target.is_manager),
        isEventManager: Boolean(target.is_event_manager),
        canApproveEvents: Boolean(target.can_approve_events),
        isPlatformAdmin: Boolean(target.is_platform_admin),
      },
      after: {
        email,
        firstName,
        lastName,
        status,
        hasTaskAccess,
        isManager,
        isEventManager,
        canApproveEvents,
        isPlatformAdmin,
      },
    }),
  );
  await context.env.DB.batch(accessStatements);
  return context.json({ ok: true });
}

function validStaffEmail(env: Env, value: unknown) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return isHostedEmail(env, email) ? email : null;
}

export async function inviteAdminUser(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const eventsEnabled = resolveRuntimeFeatures(context.env.FEATURE_MODULES).events;
  const input = await context.req.json<{
    email?: unknown;
    firstName?: unknown;
    lastName?: unknown;
    hasTaskAccess?: unknown;
    isManager?: unknown;
    isEventManager?: unknown;
    canApproveEvents?: unknown;
    isPlatformAdmin?: unknown;
  }>();
  const isPlatformAdmin = input.isPlatformAdmin === true;
  if (
    isPlatformAdmin &&
    !(await userHasPermission(context.env, identity.user.id, PLATFORM_ADMIN_PERMISSION))
  ) {
    return context.json({ error: 'platform_admin_required' }, 403);
  }
  const email = validStaffEmail(context.env, input.email);
  if (!email) return context.json({ error: 'hosted_email_required' }, 400);
  const firstName = typeof input.firstName === 'string' ? input.firstName.trim().slice(0, 120) : '';
  const lastName = typeof input.lastName === 'string' ? input.lastName.trim().slice(0, 120) : '';
  const existing = await context.env.DB.prepare(
    'SELECT id FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(email)
    .first<{ id: number }>();
  if (existing) return context.json({ error: 'user_exists' }, 409);
  const created = await context.env.DB.prepare(
    `INSERT INTO users (email, first_name, last_name) VALUES (?, ?, ?) RETURNING id`,
  )
    .bind(email, firstName, lastName)
    .first<{ id: number }>();
  if (!created) return context.json({ error: 'user_creation_failed' }, 500);
  const hasTaskAccess = isPlatformAdmin || input.hasTaskAccess === true || input.isManager === true;
  const permissionKeys = ['tasks.personal', 'tasks.comment'];
  if (eventsEnabled) permissionKeys.push('events.view', 'events.create');
  if (hasTaskAccess) permissionKeys.push('tasks.view');
  if (isPlatformAdmin || input.isManager === true) permissionKeys.push('tasks.manage');
  if (eventsEnabled && (isPlatformAdmin || input.isEventManager === true)) {
    permissionKeys.push('events.manage');
  }
  if (eventsEnabled && (isPlatformAdmin || input.canApproveEvents === true)) {
    permissionKeys.push('events.approve');
  }
  if (isPlatformAdmin) permissionKeys.push(PLATFORM_ADMIN_PERMISSION);
  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
       SELECT id, ?, 'member' FROM workspaces WHERE workspace_key = ?`,
    ).bind(created.id, tenantProfile.workspaceKey),
    auditStatement(context, identity.auditUserId, 'user', email, 'user.invited', {
      firstName,
      lastName,
      permissions: permissionKeys,
    }),
  ];
  for (const permission of permissionKeys) {
    statements.push(
      context.env.DB.prepare(
        'INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, ?)',
      ).bind(created.id, permission),
    );
  }
  if (isPlatformAdmin) {
    statements.push(
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
         SELECT ?, key FROM permissions WHERE ? = 1 OR key NOT LIKE 'events.%'`,
      ).bind(created.id, eventsEnabled ? 1 : 0),
    );
  }
  await context.env.DB.batch(statements);
  return context.json(
    {
      user: { id: created.id, email, firstName, lastName },
      signInPath: eventsEnabled ? '/auth/login?returnTo=%2Fevents' : '/auth/login?returnTo=%2F',
    },
    201,
  );
}

export async function impersonateAdminUser(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  if (identity.session.act) return context.json({ error: 'already_impersonating' }, 400);
  const userId = Number(context.req.param('userId'));
  if (!Number.isInteger(userId) || userId < 1 || userId === identity.user.id) {
    return context.json({ error: 'invalid_user' }, 400);
  }
  const target = await context.env.DB.prepare(`SELECT id, email, status FROM users WHERE id = ?`)
    .bind(userId)
    .first<{ id: number; email: string; status: string }>();
  if (!target) return context.json({ error: 'not_found' }, 404);
  if (target.status !== 'active') return context.json({ error: 'inactive_user' }, 400);
  const permissions = await effectivePermissionKeys(context.env, target.id);
  // Impersonation must never raise privilege: the target's effective permissions
  // (including the platform.admin expansion) have to be a subset of the actor's.
  const actorPermissions = new Set(await effectivePermissionKeys(context.env, identity.user.id));
  if (permissions.some((permission) => !actorPermissions.has(permission))) {
    return context.json({ error: 'platform_admin_required' }, 403);
  }
  await auditStatement(
    context,
    identity.auditUserId,
    'user',
    target.email,
    'user.impersonation_started',
    { targetUserId: target.id },
  ).run();
  const token = await signSession(context.env, target, permissions, identity.user);
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge: 43_200,
    path: '/',
    sameSite: 'Lax',
    secure: true,
  });
  return context.json({ ok: true });
}

export async function stopAdminImpersonation(context: AppContext) {
  const token = getCookie(context, SESSION_COOKIE);
  if (!token) return context.json({ error: 'unauthorized' }, 401);
  let session: SessionClaims;
  try {
    session = await verifySession(context.env, token);
  } catch {
    return context.json({ error: 'unauthorized' }, 401);
  }
  if (!session.act) return context.json({ error: 'not_impersonating' }, 400);
  // Stopping must always work for a validly signed impersonation session: it only ever lowers
  // privilege. The actor's session is restored only while the actor is still active and may
  // impersonate; otherwise the session simply ends. Both outcomes are audited.
  const actorId = Number(session.act.sub);
  const targetId = Number(session.sub);
  const actor = await context.env.DB.prepare(
    `SELECT id, email, status FROM users WHERE id = ? AND status = 'active'`,
  )
    .bind(actorId)
    .first<{ id: number; email: string; status: string }>();
  const permissionKeys =
    actor?.status === 'active' ? await effectivePermissionKeys(context.env, actor.id) : [];
  const mayRestore = actor?.status === 'active' && permissionKeys.includes('tasks.manage');
  try {
    await auditStatement(
      context,
      actor?.id ?? targetId,
      'user',
      session.email,
      mayRestore ? 'user.impersonation_stopped' : 'user.impersonation_ended_unauthorized',
      { targetUserId: targetId, actorUserId: actorId },
    ).run();
  } catch (error) {
    // An unauditable outcome (for example both users deleted) must not keep the session alive.
    await logApplicationError(
      'admin.impersonation_stop_audit_failed',
      error,
      context.env,
      context.get('requestId'),
    );
  }
  if (!actor || !mayRestore) {
    deleteCookie(context, SESSION_COOKIE, { path: '/', secure: true });
    return context.json({ ok: true, restored: false });
  }
  const restored = await signSession(context.env, actor, permissionKeys);
  setCookie(context, SESSION_COOKIE, restored, {
    httpOnly: true,
    maxAge: 43_200,
    path: '/',
    sameSite: 'Lax',
    secure: true,
  });
  return context.json({ ok: true });
}
