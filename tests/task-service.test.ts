import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import type { Env } from '../src/env';
import {
  sortKey as compatibilitySortKey,
  taskAssignmentNotification as compatibilityTaskAssignmentNotification,
  taskKeyForCreation as compatibilityTaskKeyForCreation,
} from '../src/tasks/api';
import { sortKey, taskAssignmentNotification, taskKeyForCreation } from '../src/tasks/service';

describe('task service helpers', () => {
  it('preserves the existing task sort ordering and fallback values', () => {
    expect(sortKey('in_progress', 'high', '2026-09-01', 'TASK-A')).toBe(
      '00:high:2026-09-01:TASK-A',
    );
    expect(sortKey('backlog', null, null, 'TASK-B')).toBe('03:z:9999-12-31:TASK-B');
    expect(sortKey('unknown', null, null, 'TASK-Z')).toBe('-1:z:9999-12-31:TASK-Z');
  });

  it('derives the same deterministic task key used by mutation retries', async () => {
    const mutationKey = '00000000-0000-4000-8000-000000000001';

    await expect(taskKeyForCreation(6, mutationKey)).resolves.toBe('TASK-C3CC04844AFD');
    await expect(taskKeyForCreation(6, mutationKey)).resolves.toBe('TASK-C3CC04844AFD');
    await expect(taskKeyForCreation(7, mutationKey)).resolves.not.toBe('TASK-C3CC04844AFD');
  });

  it('keeps assignment notification versioning and dedupe semantics exact', () => {
    const notification = taskAssignmentNotification({
      actorUserId: 6,
      assignee: { id: 9 },
      dueDate: '2026-09-03',
      env: { ENVIRONMENT: 'production' } as Env,
      nextVersion: 4,
      previousAssigneeUserId: 6,
      taskKey: 'TASK-1',
      title: 'Prepare the event slide',
    });

    expect(notification).toEqual({
      userId: 9,
      actorUserId: 6,
      kind: 'assignment',
      entityType: 'task',
      entityKey: 'TASK-1',
      dedupeKey: 'assignment:task:TASK-1:9:v4',
      subject: 'Task assigned: Prepare the event slide',
      heading: 'A task was assigned to you',
      message: 'Prepare the event slide is due 2026-09-03.',
      url: `${tenantProfile.origins.production}/?task=TASK-1&view=open`,
      taskVersion: 4,
    });
  });

  it('does not notify an absent or unchanged assignee', () => {
    const common = {
      actorUserId: 6,
      dueDate: null,
      env: { ENVIRONMENT: 'dev' } as Env,
      nextVersion: 5,
      taskKey: 'TASK-1',
      title: 'Prepare the event slide',
    };

    expect(
      taskAssignmentNotification({
        ...common,
        assignee: null,
        previousAssigneeUserId: 9,
      }),
    ).toBeNull();
    expect(
      taskAssignmentNotification({
        ...common,
        assignee: { id: 9 },
        previousAssigneeUserId: 9,
      }),
    ).toBeNull();
  });

  it('retains the task API compatibility exports', () => {
    expect(compatibilitySortKey).toBe(sortKey);
    expect(compatibilityTaskKeyForCreation).toBe(taskKeyForCreation);
    expect(compatibilityTaskAssignmentNotification).toBe(taskAssignmentNotification);
  });
});
