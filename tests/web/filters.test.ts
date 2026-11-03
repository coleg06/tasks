import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import type { TaskStatus, TaskSummary } from '../../web/src/api/types';
import { activeFilterCount, filterTasks, toggleValue } from '../../web/src/tasks/filters';

function isoDate(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function task(overrides: Partial<TaskSummary> & { key: string }): TaskSummary {
  return {
    reference: `T-${overrides.key}`,
    seq: 1,
    title: overrides.key,
    description: '',
    status: 'not_started' as TaskStatus,
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
    createdAt: '2026-08-16T00:00:00Z',
    updatedAt: '2026-08-17T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

const me = 'admin@example.org';

const tasks = [
  task({ key: 'a', status: 'done', assignee: { name: 'Alex Admin', email: me } }),
  task({
    key: 'b',
    status: 'in_progress',
    priority: 'high',
    assignee: { name: 'Alex Admin', email: me },
  }),
  task({ key: 'c', status: 'blocked', priority: 'low', dueDate: isoDate(-2) }),
  task({ key: 'd', status: 'not_started', dueDate: isoDate(0) }),
  task({ key: 'e', status: 'backlog', dueDate: isoDate(3) }),
];

function keys(result: TaskSummary[]) {
  return result.map((entry) => entry.key);
}

describe('task filtering', () => {
  it('returns everything when nothing is selected', () => {
    expect(keys(filterTasks(tasks, {}, me))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('hides completed work when a status is chosen — the My Tasks case', () => {
    const open = filterTasks(tasks, { status: 'in_progress,blocked,not_started,backlog' }, me);
    expect(keys(open)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('combines several statuses', () => {
    expect(keys(filterTasks(tasks, { status: 'done,blocked' }, me))).toEqual(['a', 'c']);
  });

  it('resolves the "me" assignee against the signed-in address', () => {
    expect(keys(filterTasks(tasks, { assignee: 'me' }, me))).toEqual(['a', 'b']);
  });

  it('matches unassigned separately from a named assignee', () => {
    expect(keys(filterTasks(tasks, { assignee: 'none' }, me))).toEqual(['c', 'd', 'e']);
  });

  it('treats overdue as past due and not yet done', () => {
    expect(keys(filterTasks(tasks, { due: 'overdue' }, me))).toEqual(['c']);
  });

  it('scopes today and this week to real dates', () => {
    expect(keys(filterTasks(tasks, { due: 'today' }, me))).toEqual(['d']);
    expect(keys(filterTasks(tasks, { due: 'week' }, me))).toEqual(['d', 'e']);
    expect(keys(filterTasks(tasks, { due: 'none' }, me))).toEqual(['a', 'b']);
  });

  it('intersects filters rather than unioning them', () => {
    expect(keys(filterTasks(tasks, { status: 'in_progress,blocked', assignee: 'me' }, me))).toEqual(
      ['b'],
    );
  });

  it('drops tasks with no priority when a priority is selected', () => {
    expect(keys(filterTasks(tasks, { priority: 'high' }, me))).toEqual(['b']);
  });

  it('hides only tasks assigned to the system Agent account', () => {
    const withAgent = [
      ...tasks,
      task({
        key: 'agent',
        title: 'Agent work',
        assignee: tenantProfile.agent,
      }),
      task({ key: 'mention', title: 'Ask the agent about this' }),
    ];
    expect(keys(filterTasks(withAgent, {}, me, true))).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'mention',
    ]);
  });
});

describe('filter helpers', () => {
  it('toggles values in and out of a comma list', () => {
    expect(toggleValue(undefined, 'done')).toBe('done');
    expect(toggleValue('done', 'blocked')).toBe('done,blocked');
    expect(toggleValue('done,blocked', 'done')).toBe('blocked');
    expect(toggleValue('done', 'done')).toBeUndefined();
  });

  it('counts each selected value, with due as one', () => {
    expect(activeFilterCount({})).toBe(0);
    expect(activeFilterCount({ status: 'done,blocked', due: 'today' })).toBe(3);
  });
});
