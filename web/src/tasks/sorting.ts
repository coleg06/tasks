import type { TaskSummary } from '../api/types';

export const taskSorts = [
  'smart',
  'due_asc',
  'due_desc',
  'created_desc',
  'created_asc',
  'owner_asc',
  'owner_desc',
  'updated_desc',
  'title_asc',
  'title_desc',
] as const;

export type TaskSort = (typeof taskSorts)[number];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareNullable(left: string | null, right: string | null, direction: 'asc' | 'desc') {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  const compared = collator.compare(left, right);
  return direction === 'asc' ? compared : -compared;
}

function owner(task: TaskSummary) {
  const value = task.assignee?.name.trim() || task.assignee?.email?.trim();
  return value || null;
}

function tieBreak(left: TaskSummary, right: TaskSummary) {
  const title = collator.compare(left.title, right.title);
  return title || right.seq - left.seq;
}

/** Sort a copy so React Query's cached API response is never mutated. */
export function sortTasks(tasks: TaskSummary[], sort: TaskSort): TaskSummary[] {
  if (sort === 'smart') return [...tasks];

  return [...tasks].sort((left, right) => {
    let compared = 0;
    if (sort === 'due_asc') compared = compareNullable(left.dueDate, right.dueDate, 'asc');
    if (sort === 'due_desc') compared = compareNullable(left.dueDate, right.dueDate, 'desc');
    if (sort === 'created_desc')
      compared = compareNullable(left.createdAt, right.createdAt, 'desc');
    if (sort === 'created_asc') compared = compareNullable(left.createdAt, right.createdAt, 'asc');
    if (sort === 'owner_asc') compared = compareNullable(owner(left), owner(right), 'asc');
    if (sort === 'owner_desc') compared = compareNullable(owner(left), owner(right), 'desc');
    if (sort === 'updated_desc')
      compared = compareNullable(left.updatedAt, right.updatedAt, 'desc');
    if (sort === 'title_asc') compared = collator.compare(left.title, right.title);
    if (sort === 'title_desc') compared = collator.compare(right.title, left.title);
    return compared || tieBreak(left, right);
  });
}
