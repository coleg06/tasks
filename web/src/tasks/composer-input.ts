import type { TaskPriority } from '../api/types';

const priorityTokens: Record<string, TaskPriority> = {
  high: 'high',
  medium: 'medium',
  med: 'medium',
  low: 'low',
};

const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function resolveDate(token: string): string | null {
  const value = token.toLowerCase();
  const today = new Date();
  if (value === 'today') return isoDate(today);
  if (value === 'tomorrow') {
    today.setDate(today.getDate() + 1);
    return isoDate(today);
  }
  const weekday = weekdays.indexOf(value);
  if (weekday >= 0) {
    const delta = (weekday - today.getDay() + 7) % 7 || 7;
    today.setDate(today.getDate() + delta);
    return isoDate(today);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

/**
 * Parses inline tokens out of the title as it is typed:
 *   !high      priority
 *   >friday    due date
 *   @name      assignee, matched against the project's members
 */
export function parseComposerInput(
  raw: string,
  assignees: { email: string; name: string }[],
): {
  title: string;
  priority: TaskPriority | null;
  dueDate: string | null;
  assigneeEmail: string | null;
} {
  let priority: TaskPriority | null = null;
  let dueDate: string | null = null;
  let assigneeEmail: string | null = null;

  const words = raw.split(/\s+/);
  const kept: string[] = [];

  for (const word of words) {
    if (word.startsWith('!') && priorityTokens[word.slice(1).toLowerCase()]) {
      priority = priorityTokens[word.slice(1).toLowerCase()] as TaskPriority;
      continue;
    }
    if (word.startsWith('>')) {
      const parsed = resolveDate(word.slice(1));
      if (parsed) {
        dueDate = parsed;
        continue;
      }
    }
    if (word.startsWith('@') && word.length > 1) {
      const needle = word.slice(1).toLowerCase();
      const match = assignees.find(
        (assignee) =>
          assignee.name.toLowerCase().replace(/\s+/g, '').startsWith(needle) ||
          assignee.email.toLowerCase().startsWith(needle),
      );
      if (match) {
        assigneeEmail = match.email;
        continue;
      }
    }
    kept.push(word);
  }

  return { title: kept.join(' ').trim(), priority, dueDate, assigneeEmail };
}
