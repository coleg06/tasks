import { tenantProfile } from '../../../shared/tenant-profile';
import type { TaskPriority, TaskStatus, TaskSummary } from '../api/types';

export const AGENT_TASK_EMAIL = tenantProfile.agent.email.toLowerCase();

export type TaskFilterState = {
  status?: string | undefined;
  assignee?: string | undefined;
  priority?: string | undefined;
  due?: string | undefined;
};

export const dueFilters = ['overdue', 'today', 'week', 'none'] as const;
export type DueFilter = (typeof dueFilters)[number];

/** Comma-separated multi-select, e.g. `status=in_progress,blocked`. */
export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function toggleValue(current: string | undefined, value: string): string | undefined {
  const values = parseList(current);
  const next = values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
  return next.length ? next.join(',') : undefined;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function inDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function matchesDue(task: TaskSummary, filter: string): boolean {
  if (filter === 'none') return task.dueDate === null;
  if (!task.dueDate) return false;
  if (filter === 'overdue') return task.status !== 'done' && task.dueDate < today();
  if (filter === 'today') return task.dueDate === today();
  if (filter === 'week') return task.dueDate >= today() && task.dueDate <= inDays(7);
  return true;
}

/**
 * Applied in the browser rather than the query string: the list endpoint
 * already returns every row for the active view (298 tasks against a LIMIT of
 * 500), so filtering here is exact and repaints with no refetch.
 */
export function filterTasks(
  tasks: TaskSummary[],
  filters: TaskFilterState,
  currentEmail: string | undefined,
  hideAgentTasks = false,
): TaskSummary[] {
  const statuses = parseList(filters.status) as TaskStatus[];
  const priorities = parseList(filters.priority) as TaskPriority[];
  const assignees = parseList(filters.assignee);

  return tasks.filter((task) => {
    if (hideAgentTasks && task.assignee?.email?.toLowerCase() === AGENT_TASK_EMAIL) return false;
    if (statuses.length && !statuses.includes(task.status)) return false;
    if (priorities.length && !(task.priority && priorities.includes(task.priority))) return false;

    if (assignees.length) {
      const email = task.assignee?.email?.toLowerCase() ?? null;
      const matched = assignees.some((entry) => {
        if (entry === 'none') return email === null;
        if (entry === 'me') return Boolean(currentEmail) && email === currentEmail?.toLowerCase();
        return email === entry.toLowerCase();
      });
      if (!matched) return false;
    }

    if (filters.due && !matchesDue(task, filters.due)) return false;
    return true;
  });
}

export function activeFilterCount(filters: TaskFilterState): number {
  return (
    parseList(filters.status).length +
    parseList(filters.priority).length +
    parseList(filters.assignee).length +
    (filters.due ? 1 : 0)
  );
}
