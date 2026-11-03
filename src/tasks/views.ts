export type TaskView = 'open' | 'mine' | 'backlog' | 'completed';

export const taskViewKeys: TaskView[] = ['open', 'mine', 'backlog', 'completed'];

export function normalizeTaskView(value: string | undefined): TaskView {
  return taskViewKeys.includes(value as TaskView) ? (value as TaskView) : 'open';
}

export function taskViewFilter(view: TaskView) {
  if (view === 'completed') return { sql: "t.status = 'done'", assignedToCurrentUser: false };
  if (view === 'backlog') {
    return {
      sql: "t.status IN ('backlog', 'not_started')",
      assignedToCurrentUser: false,
    };
  }
  if (view === 'mine') return { sql: 't.assignee_user_id = ?', assignedToCurrentUser: true };
  return {
    sql: "t.status IN ('in_progress', 'blocked')",
    assignedToCurrentUser: false,
  };
}
