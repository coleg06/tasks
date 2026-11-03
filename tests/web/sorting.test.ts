import { describe, expect, it } from 'vitest';
import type { TaskSummary } from '../../web/src/api/types';
import { sortTasks } from '../../web/src/tasks/sorting';

function task(key: string, overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    key,
    reference: `T-${key}`,
    seq: Number(key) || 1,
    title: `Task ${key}`,
    description: '',
    status: 'not_started',
    priority: null,
    effort: null,
    dueDate: null,
    completedAt: null,
    assignee: null,
    creator: { name: 'Alex Admin', email: 'admin@example.org', photoUrl: null },
    taskTypes: [],
    attachments: [],
    project: {
      key: 'IT',
      name: 'Technology',
      workspace: { key: 'EX', name: 'Example Organization' },
    },
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

function keys(tasks: TaskSummary[]) {
  return tasks.map((entry) => entry.key);
}

describe('task sorting', () => {
  const tasks = [
    task('1', {
      title: 'Lighting',
      dueDate: '2026-09-10',
      createdAt: '2026-08-03T00:00:00Z',
      updatedAt: '2026-08-04T00:00:00Z',
      assignee: { name: 'Sam Ortiz', email: 'owner2@example.org' },
    }),
    task('2', {
      title: 'Audio',
      dueDate: '2026-09-01',
      createdAt: '2026-08-05T00:00:00Z',
      updatedAt: '2026-08-02T00:00:00Z',
      assignee: { name: 'Alex Admin', email: 'admin@example.org' },
    }),
    task('3', {
      title: 'Unassigned',
      createdAt: '2026-08-04T00:00:00Z',
      updatedAt: '2026-08-06T00:00:00Z',
    }),
  ];

  it('sorts due dates in either direction and always leaves undated tasks last', () => {
    expect(keys(sortTasks(tasks, 'due_asc'))).toEqual(['2', '1', '3']);
    expect(keys(sortTasks(tasks, 'due_desc'))).toEqual(['1', '2', '3']);
  });

  it('sorts by date added and last update', () => {
    expect(keys(sortTasks(tasks, 'created_desc'))).toEqual(['2', '3', '1']);
    expect(keys(sortTasks(tasks, 'created_asc'))).toEqual(['1', '3', '2']);
    expect(keys(sortTasks(tasks, 'updated_desc'))).toEqual(['3', '1', '2']);
  });

  it('sorts owners and leaves unassigned tasks last', () => {
    expect(keys(sortTasks(tasks, 'owner_asc'))).toEqual(['2', '1', '3']);
    expect(keys(sortTasks(tasks, 'owner_desc'))).toEqual(['1', '2', '3']);
  });

  it('does not mutate the API response', () => {
    const original = [...tasks];
    expect(keys(sortTasks(tasks, 'title_asc'))).toEqual(['2', '1', '3']);
    expect(keys(sortTasks(tasks, 'title_desc'))).toEqual(['3', '1', '2']);
    expect(tasks).toEqual(original);
  });
});
