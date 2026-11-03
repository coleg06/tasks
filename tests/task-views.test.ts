import { describe, expect, it } from 'vitest';
import { normalizeTaskView, taskViewFilter } from '../src/tasks/views';

describe('task views', () => {
  it('matches the saved status groups', () => {
    expect(taskViewFilter('open').sql).toContain("'in_progress', 'blocked'");
    expect(taskViewFilter('backlog').sql).toContain("'backlog', 'not_started'");
    expect(taskViewFilter('completed').sql).toContain("'done'");
  });

  it('scopes My Tasks to the signed-in user', () => {
    expect(taskViewFilter('mine')).toEqual({
      sql: 't.assignee_user_id = ?',
      assignedToCurrentUser: true,
    });
  });

  it('falls back to All Open Tasks for unknown view names', () => {
    expect(normalizeTaskView('unexpected')).toBe('open');
  });
});
