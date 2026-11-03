import type { Env } from '../env';
import {
  eventUrl,
  myTasksUrl,
  type NotificationDetail,
  sendUserNotification,
  taskUrl,
} from './email';

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number) {
  const next = new Date(value);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function deadlineLabel(days: number) {
  if (days === 0) return 'Due today';
  return days === 1 ? 'Due tomorrow' : `Due in ${days} days`;
}

export type DeadlineDigestItem = NotificationDetail & {
  userId: number;
  days: number;
};

export function groupDeadlineItems(items: DeadlineDigestItem[]) {
  const grouped = new Map<number, DeadlineDigestItem[]>();
  for (const item of items) {
    const userItems = grouped.get(item.userId) ?? [];
    userItems.push(item);
    grouped.set(item.userId, userItems);
  }
  for (const userItems of grouped.values()) {
    userItems.sort(
      (left, right) => left.days - right.days || left.title.localeCompare(right.title),
    );
  }
  return grouped;
}

function digestSummary(items: DeadlineDigestItem[]) {
  const counts = new Map<number, number>();
  for (const item of items) counts.set(item.days, (counts.get(item.days) ?? 0) + 1);
  return [
    counts.get(0) ? `${counts.get(0)} due today` : '',
    counts.get(1) ? `${counts.get(1)} due tomorrow` : '',
    counts.get(3) ? `${counts.get(3)} due in 3 days` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

export async function sendDeadlineNotifications(env: Env, now = new Date()) {
  // Development contains copied staff and task data. Never turn that dataset into real email.
  if (env.ENVIRONMENT !== 'production') {
    return { attempted: 0, matchedItems: 0, skipped: 'non_production' as const };
  }

  const runDate = isoDate(now);
  const today = new Date(`${runDate}T12:00:00Z`);
  const offsets = [0, 1, 3];
  const items: DeadlineDigestItem[] = [];

  for (const days of offsets) {
    const dueDate = isoDate(addDays(today, days));
    const tasks = await env.DB.prepare(
      `SELECT t.task_key, t.title, t.assignee_user_id, p.name AS project_name
       FROM tasks t JOIN users u ON u.id = t.assignee_user_id
       JOIN projects p ON p.id = t.project_id
       WHERE t.due_date = ? AND t.status NOT IN ('done') AND t.archived_at IS NULL
         AND p.archived_at IS NULL AND u.status = 'active'`,
    )
      .bind(dueDate)
      .all<{
        task_key: string;
        title: string;
        assignee_user_id: number;
        project_name: string;
      }>();
    items.push(
      ...tasks.results.map((task) => ({
        userId: task.assignee_user_id,
        days,
        label: deadlineLabel(days),
        title: task.title,
        context: task.project_name,
        url: taskUrl(env, task.task_key),
      })),
    );

    const workItems = await env.DB.prepare(
      `SELECT wi.work_item_key, wi.title, wi.owner_user_id, e.event_key, e.title AS event_title
       FROM event_work_items wi JOIN events e ON e.id = wi.event_id
       JOIN users u ON u.id = wi.owner_user_id
       WHERE substr(wi.due_at, 1, 10) = ? AND wi.status NOT IN ('done','not_needed')
         AND e.archived_at IS NULL AND u.status = 'active'`,
    )
      .bind(dueDate)
      .all<{
        work_item_key: string;
        title: string;
        owner_user_id: number;
        event_key: string;
        event_title: string;
      }>();
    items.push(
      ...workItems.results.map((item) => ({
        userId: item.owner_user_id,
        days,
        label: deadlineLabel(days),
        title: item.title,
        context: item.event_title,
        url: eventUrl(env, item.event_key),
      })),
    );
  }

  const digests = groupDeadlineItems(items);
  let attempted = 0;
  for (const [userId, userItems] of digests) {
    attempted += 1;
    const visibleItems = userItems.slice(0, 25);
    const omitted = userItems.length - visibleItems.length;
    const summary = digestSummary(userItems);
    const message = omitted
      ? `${summary}. The first 25 items are shown below; ${omitted} more are waiting in My Tasks.`
      : `${summary}.`;
    await sendUserNotification(env, {
      userId,
      kind: 'deadline',
      entityType: 'deadline_digest',
      entityKey: runDate,
      dedupeKey: `deadline-digest:${userId}:${runDate}`,
      subject: `Tasks deadline digest: ${userItems.length} upcoming ${userItems.length === 1 ? 'item' : 'items'}`,
      heading: 'Your upcoming Tasks deadlines',
      message,
      details: visibleItems,
      url: myTasksUrl(env),
    });
  }

  return { attempted, matchedItems: items.length };
}
