import { tenantProfile } from '../../shared/tenant-profile';
import { PLATFORM_ADMIN_PERMISSION, userHasPermission } from '../auth/permissions';
import { requireTasksSession } from '../tasks/api';
import { auditChangesSelect, visibleAuditCondition } from './audit-visibility';
import { type AppContext, MANAGE_PERMISSION } from './rbac';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function nextDay(date: string) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCDate(parsed.getUTCDate() + 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * GET /api/admin/audit?actor=&target=&action=&from=&to=&limit=&cursor=
 *
 * Immutable activity records, newest first, paginated by id. `actor` matches the acting user's
 * name or email, `target` the affected entity (a person's email, `role:<key>`, a project key),
 * `action` an exact action or a family prefix (`user` matches `user.*`), and `from`/`to` are
 * inclusive UTC dates.
 *
 * Without `platform.admin`, events about personal-project tasks and their comments are excluded
 * everywhere (rows, `target` search, the action list), and task/comment events that can no longer
 * be tied to a project have their `changes` redacted (`redacted: true`). See audit-visibility.ts.
 */
export async function listAuditEvents(context: AppContext) {
  if (!tenantProfile.tasks.userAdministration) return context.json({ error: 'not_found' }, 404);
  const identity = await requireTasksSession(context, MANAGE_PERMISSION);
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const rawCursor = context.req.query('cursor');
  const cursor = rawCursor === undefined ? null : Number(rawCursor);
  if (cursor !== null && (!Number.isInteger(cursor) || cursor < 1)) {
    return context.json({ error: 'invalid_cursor' }, 400);
  }
  const requested = Number(context.req.query('limit'));
  const limit =
    Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_PAGE) : DEFAULT_PAGE;
  const actor = context.req.query('actor')?.trim().slice(0, 120);
  const target = context.req.query('target')?.trim().slice(0, 200);
  const action = context.req.query('action')?.trim().slice(0, 80);
  const from = context.req.query('from');
  const to = context.req.query('to');
  if ((from && !DATE.test(from)) || (to && !DATE.test(to))) {
    return context.json({ error: 'invalid_date' }, 400);
  }
  const restricted = !(await userHasPermission(
    context.env,
    identity.user.id,
    PLATFORM_ADMIN_PERMISSION,
  ));
  const conditions: string[] = restricted ? [visibleAuditCondition()] : [];
  const binds: unknown[] = [];
  if (cursor !== null) {
    conditions.push('ae.id < ?');
    binds.push(cursor);
  }
  if (action) {
    conditions.push(`(ae.action = ? OR ae.action LIKE ? ESCAPE '\\')`);
    binds.push(action, `${escapeLike(action)}.%`);
  }
  if (target) {
    conditions.push(`ae.entity_key LIKE ? ESCAPE '\\'`);
    binds.push(`%${escapeLike(target)}%`);
  }
  if (actor) {
    conditions.push(
      `ae.actor_user_id IN (
         SELECT id FROM users
         WHERE email LIKE ? ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE ? ESCAPE '\\')`,
    );
    binds.push(`%${escapeLike(actor)}%`, `%${escapeLike(actor)}%`);
  }
  if (from) {
    conditions.push('ae.created_at >= ?');
    binds.push(`${from}T00:00:00Z`);
  }
  if (to) {
    const end = nextDay(to);
    if (!end) return context.json({ error: 'invalid_date' }, 400);
    conditions.push('ae.created_at < ?');
    binds.push(`${end}T00:00:00Z`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await context.env.DB.prepare(
    `SELECT ae.id, ae.entity_type, ae.entity_key, ae.action, ${auditChangesSelect(restricted)},
       ae.request_id, ae.created_at, ae.actor_user_id,
       COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email, 'System') AS actor_name,
       u.email AS actor_email
     FROM audit_events ae LEFT JOIN users u ON u.id = ae.actor_user_id
     ${where} ORDER BY ae.id DESC LIMIT ?`,
  )
    .bind(...binds, limit + 1)
    .all<{
      id: number;
      entity_type: string;
      entity_key: string;
      action: string;
      changes_json: string;
      redacted: number;
      request_id: string | null;
      created_at: string;
      actor_user_id: number | null;
      actor_name: string;
      actor_email: string | null;
    }>();
  const page = rows.results.slice(0, limit);
  const actions =
    cursor === null
      ? (
          await context.env.DB.prepare(
            `SELECT DISTINCT ae.action FROM audit_events ae
             ${restricted ? `WHERE ${visibleAuditCondition()}` : ''} ORDER BY ae.action`,
          ).all<{
            action: string;
          }>()
        ).results.map((row) => row.action)
      : undefined;
  return context.json({
    events: page.map((event) => ({
      id: event.id,
      entityType: event.entity_type,
      entityKey: event.entity_key,
      action: event.action,
      changes: JSON.parse(event.changes_json),
      ...(event.redacted ? { redacted: true } : {}),
      requestId: event.request_id,
      createdAt: event.created_at,
      actor: { id: event.actor_user_id, name: event.actor_name, email: event.actor_email },
    })),
    nextCursor: rows.results.length > limit ? (page.at(-1)?.id ?? null) : null,
    ...(actions ? { actions } : {}),
  });
}
