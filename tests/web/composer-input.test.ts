import { describe, expect, it } from 'vitest';
import { parseComposerInput } from '../../web/src/tasks/composer-input';

const assignees = [
  { email: 'admin@example.org', name: 'Alex Admin' },
  { email: 'pmoreno@example.org', name: 'Pat Moreno' },
];

describe('composer input parsing', () => {
  it('keeps a plain title untouched', () => {
    expect(parseComposerInput('Replace the lobby display', assignees)).toEqual({
      title: 'Replace the lobby display',
      priority: null,
      dueDate: null,
      assigneeEmail: null,
    });
  });

  it('lifts priority, due date and assignee out of the title', () => {
    const parsed = parseComposerInput('Patch the UDM !high >2026-09-01 @alex', assignees);
    expect(parsed.title).toBe('Patch the UDM');
    expect(parsed.priority).toBe('high');
    expect(parsed.dueDate).toBe('2026-09-01');
    expect(parsed.assigneeEmail).toBe('admin@example.org');
  });

  it('matches an assignee on email as well as name', () => {
    expect(parseComposerInput('Ship it @pmoreno', assignees).assigneeEmail).toBe(
      'pmoreno@example.org',
    );
  });

  it('leaves unrecognised tokens in the title rather than dropping them', () => {
    const parsed = parseComposerInput('Email @nobody about !urgent >someday', assignees);
    expect(parsed.title).toBe('Email @nobody about !urgent >someday');
    expect(parsed.priority).toBeNull();
    expect(parsed.dueDate).toBeNull();
    expect(parsed.assigneeEmail).toBeNull();
  });

  it('resolves relative days to an ISO date', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(parseComposerInput('Check backups >today', assignees).dueDate).toBe(today);
    expect(parseComposerInput('Check backups >friday', assignees).dueDate).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});
