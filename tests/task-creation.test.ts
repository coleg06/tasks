import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { taskMutationSchema, taskPatchSchema } from '../src/shared/schemas';
import { taskAssignmentNotification, taskKeyForCreation } from '../src/tasks/api';

const validTask = {
  title: 'Check the lobby display',
  description: '',
  status: 'not_started',
  priority: null,
  effort: null,
  assigneeEmail: null,
  dueDate: null,
  projectKey: 'IT',
  taskTypes: [],
};

describe('task creation consistency', () => {
  it('accepts a browser mutation key without making it patchable', () => {
    const mutationKey = '00000000-0000-4000-8000-000000000001';
    expect(taskMutationSchema.parse({ ...validTask, mutationKey }).mutationKey).toBe(mutationKey);
    expect(taskPatchSchema.safeParse({ mutationKey }).success).toBe(false);
  });

  it('derives the same task key for retries by the same user', async () => {
    const mutationKey = '00000000-0000-4000-8000-000000000001';
    const first = await taskKeyForCreation(6, mutationKey);
    const retry = await taskKeyForCreation(6, mutationKey);
    const otherUser = await taskKeyForCreation(7, mutationKey);

    expect(first).toMatch(/^TASK-[A-F0-9]{12}$/);
    expect(retry).toBe(first);
    expect(otherUser).not.toBe(first);
  });

  it('notifies the new assignee once per assignment version, but not for an unchanged owner', () => {
    const common = {
      actorUserId: 6,
      assignee: { id: 9 },
      dueDate: '2026-09-03',
      env: { ENVIRONMENT: 'production' } as Env,
      nextVersion: 4,
      taskKey: 'TASK-1',
      title: 'Prepare the event slide',
    };
    const notification = taskAssignmentNotification({
      ...common,
      previousAssigneeUserId: 6,
    });

    expect(notification).toMatchObject({
      userId: 9,
      actorUserId: 6,
      kind: 'assignment',
      dedupeKey: 'assignment:task:TASK-1:9:v4',
      subject: 'Task assigned: Prepare the event slide',
      taskVersion: 4,
    });
    expect(taskAssignmentNotification({ ...common, previousAssigneeUserId: 9 })).toBeNull();
    expect(
      taskAssignmentNotification({
        ...common,
        assignee: null,
        previousAssigneeUserId: 9,
      }),
    ).toBeNull();
  });
});
