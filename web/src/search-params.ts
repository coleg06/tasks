import type { TaskView } from './api/types';
import { type TaskSort, taskSorts } from './tasks/sorting';

export type TasksSearch = {
  project?: string | undefined;
  view: TaskView;
  q?: string | undefined;
  task?: string | undefined;
  /** Comma-separated multi-selects; `due` is single-valued. */
  status?: string | undefined;
  assignee?: string | undefined;
  priority?: string | undefined;
  due?: string | undefined;
  sort?: TaskSort | undefined;
  hideAgent?: '1' | undefined;
};

const views: TaskView[] = ['open', 'mine', 'backlog', 'completed', 'all'];

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Search params are the application's state. Everything that changes what the
 * screen shows lives here so it survives reload, back, and a pasted link.
 */
export function validateSearch(search: Record<string, unknown>): TasksSearch {
  const view = views.includes(search.view as TaskView) ? (search.view as TaskView) : 'open';
  const project = text(search.project);
  const q = text(search.q);
  const task = text(search.task);
  const status = text(search.status);
  const assignee = text(search.assignee);
  const priority = text(search.priority);
  const due = text(search.due);
  const requestedSort = text(search.sort);
  const sort = taskSorts.includes(requestedSort as TaskSort)
    ? (requestedSort as TaskSort)
    : undefined;
  const hideAgent = search.hideAgent === '1' ? '1' : undefined;
  return {
    view,
    ...(project ? { project } : {}),
    ...(q ? { q } : {}),
    ...(task ? { task } : {}),
    ...(status ? { status } : {}),
    ...(assignee ? { assignee } : {}),
    ...(priority ? { priority } : {}),
    ...(due ? { due } : {}),
    ...(sort ? { sort } : {}),
    ...(hideAgent ? { hideAgent } : {}),
  };
}
