import type { Context } from 'hono';
import { userHasPermission } from '../auth/permissions';
import { requireTasksSession, type TaskAppEnv } from '../tasks/api';

type AppContext = Context<TaskAppEnv>;

export async function getMyWorkSummary(context: AppContext) {
  const identity =
    (await requireTasksSession(context, 'events.view')) ??
    (await requireTasksSession(context, 'tasks.view'));
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const [hasSharedTaskAccess, hasPersonalTaskAccess, canManageTasks] = await Promise.all([
    userHasPermission(context.env, identity.user.id, 'tasks.view'),
    userHasPermission(context.env, identity.user.id, 'tasks.personal'),
    userHasPermission(context.env, identity.user.id, 'tasks.manage'),
  ]);
  const [tasks, eventWork] = await Promise.all([
    hasSharedTaskAccess || hasPersonalTaskAccess
      ? context.env.DB.prepare(
          `SELECT t.task_key AS item_key, t.title, t.status, t.due_date AS due_at,
       p.name AS context_name, 'task' AS kind
       FROM tasks t JOIN projects p ON p.id = t.project_id
       JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = wm.user_id
       WHERE t.assignee_user_id = ? AND t.archived_at IS NULL AND p.archived_at IS NULL
         AND t.status <> 'done'
         AND (
           (p.project_type = 'personal' AND p.personal_owner_user_id = ?)
           OR (? = 1 AND p.project_type = 'shared' AND (
             p.visibility = 'workspace'
             OR wm.role IN ('owner','admin')
             OR pm.user_id IS NOT NULL
             OR ? = 1
           ))
         )
       ORDER BY t.due_date IS NULL, t.due_date, t.updated_at DESC LIMIT 20`,
        )
          .bind(
            identity.user.id,
            identity.user.id,
            identity.user.id,
            hasSharedTaskAccess ? 1 : 0,
            canManageTasks ? 1 : 0,
          )
          .all<{
            item_key: string;
            title: string;
            status: string;
            due_at: string | null;
            context_name: string;
            kind: 'task';
          }>()
      : Promise.resolve({
          results: [] as Array<{
            item_key: string;
            title: string;
            status: string;
            due_at: string | null;
            context_name: string;
            kind: 'task';
          }>,
        }),
    context.env.DB.prepare(
      `SELECT wi.work_item_key AS item_key, wi.title, wi.status, wi.due_at,
       e.title AS context_name, e.event_key, e.seq, 'event' AS kind
       FROM event_work_items wi JOIN events e ON e.id = wi.event_id
       WHERE wi.owner_user_id = ? AND e.archived_at IS NULL
         AND wi.status NOT IN ('done','not_needed')
       ORDER BY wi.due_at IS NULL, wi.due_at, e.start_at LIMIT 20`,
    )
      .bind(identity.user.id)
      .all<{
        item_key: string;
        title: string;
        status: string;
        due_at: string | null;
        context_name: string;
        event_key: string;
        seq: number;
        kind: 'event';
      }>(),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  const items = [
    ...tasks.results.map((item) => ({
      ...item,
      reference: item.item_key,
      href: `/?view=mine&task=${encodeURIComponent(item.item_key)}`,
    })),
    ...eventWork.results.map((item) => ({
      ...item,
      reference: `E-${item.seq}`,
      href: `/events/${encodeURIComponent(item.event_key)}`,
    })),
  ].sort((left, right) => {
    if (!left.due_at) return right.due_at ? 1 : 0;
    if (!right.due_at) return -1;
    return left.due_at.localeCompare(right.due_at);
  });
  return context.json({
    counts: {
      open: items.length,
      overdue: items.filter((item) => item.due_at && item.due_at < today).length,
      dueSoon: items.filter((item) => item.due_at && item.due_at >= today && item.due_at <= soon)
        .length,
    },
    items: items.slice(0, 8),
  });
}
