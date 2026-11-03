// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetail } from '../../web/src/tasks/TaskDetail';

const state = vi.hoisted(() => ({
  canEdit: true,
  status: 'in_progress',
  pending: false,
  error: false,
  mutate: vi.fn(),
  onClose: vi.fn(),
}));
vi.mock('../../web/src/api/queries', () => ({
  useBootstrap: () => ({ data: { permissions: ['tasks.comment'] } }),
  useTask: () => ({
    data: {
      key: 'TASK-1',
      reference: 'T-1',
      title: 'Example',
      description: '',
      creator: { name: 'Example', email: 'user@example.test', photoUrl: null },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      status: state.status,
      canEdit: state.canEdit,
      priority: null,
      effort: null,
      assignee: null,
      dueDate: null,
      taskTypes: [],
      attachments: [],
      comments: [],
      activity: [],
      project: { key: 'EX', name: 'Example' },
    },
  }),
  useProjects: () => ({ data: [] }),
  useAssignees: () => ({ data: [{ name: 'Alice', email: 'alice@example.test' }] }),
  usePatchTask: () => ({ mutate: state.mutate, isPending: state.pending, isError: state.error }),
  useCreateComment: () => ({}),
  useDeleteComment: () => ({}),
}));

describe('task header Complete action', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.assign(state, { canEdit: true, status: 'in_progress', pending: false, error: false });
    state.mutate.mockReset();
    state.onClose.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function render() {
    act(() =>
      root.render(createElement(TaskDetail, { taskKey: 'TASK-1', onClose: state.onClose })),
    );
    return document.querySelector<HTMLButtonElement>('.detail-topbar .button-primary');
  }
  it('appears immediately before Close and sets the existing done status', () => {
    const button = render();
    if (!button) throw new Error('Complete button missing');
    expect(button.textContent).toBe('Complete');
    expect(button.nextElementSibling?.getAttribute('aria-label')).toBe('Close');
    act(() => button.click());
    expect(state.mutate).toHaveBeenCalledExactlyOnceWith({
      key: 'TASK-1',
      patch: { status: 'done' },
    });
  });
  it('dismisses mention suggestions before allowing Escape to close the task dialog', () => {
    render();
    const input = document.querySelector<HTMLTextAreaElement>('[aria-label="Add a comment"]');
    if (!input) throw new Error('Comment input missing');
    act(() => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        input,
        '@',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(document.querySelector('[role=listbox]')).not.toBeNull();
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(state.onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role=listbox]')).toBeNull();
    act(() =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      ),
    );
    expect(state.onClose).toHaveBeenCalledOnce();
  });
  it('respects edit permissions', () => {
    state.canEdit = false;
    expect(render()).toBeNull();
  });
  it('prevents duplicate updates while saving and for completed tasks', () => {
    state.pending = true;
    expect(render()?.disabled).toBe(true);
    state.pending = false;
    state.status = 'done';
    expect(render()?.disabled).toBe(true);
    expect(render()?.textContent).toBe('Completed');
  });
  it('shows failed saves and permits retry', () => {
    state.error = true;
    expect(render()?.disabled).toBe(false);
    expect(document.querySelector('.detail-saved')?.textContent).toContain('Could not save');
  });
});
