import type { Env } from '../env';
import { taskUrl, type UserNotification } from '../notifications/email';

export function sortKey(
  status: string,
  priority: string | null,
  dueDate: string | null,
  taskKey: string,
) {
  return `${String(['in_progress', 'blocked', 'not_started', 'backlog', 'done'].indexOf(status)).padStart(2, '0')}:${priority ?? 'z'}:${dueDate ?? '9999-12-31'}:${taskKey}`;
}

export async function taskKeyForCreation(userId: number, mutationKey?: string) {
  if (!mutationKey)
    return `TASK-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${userId}:${mutationKey}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `TASK-${hex.slice(0, 12).toUpperCase()}`;
}

export type TaskAssignmentNotificationInput = {
  actorUserId: number;
  assignee: { id: number } | null;
  dueDate: string | null;
  env: Env;
  nextVersion: number;
  previousAssigneeUserId: number | null;
  taskKey: string;
  title: string;
};

export function taskAssignmentNotification(
  input: TaskAssignmentNotificationInput,
): UserNotification | null {
  if (!input.assignee || input.previousAssigneeUserId === input.assignee.id) return null;
  return {
    userId: input.assignee.id,
    actorUserId: input.actorUserId,
    kind: 'assignment',
    entityType: 'task',
    entityKey: input.taskKey,
    dedupeKey: `assignment:task:${input.taskKey}:${input.assignee.id}:v${input.nextVersion}`,
    subject: `Task assigned: ${input.title}`,
    heading: 'A task was assigned to you',
    message: `${input.title}${input.dueDate ? ` is due ${input.dueDate}.` : '.'}`,
    url: taskUrl(input.env, input.taskKey),
    taskVersion: input.nextVersion,
  };
}
