export function dueTiming(value: string | null, now = new Date()) {
  if (!value) return 'No due date';
  const due = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  const todayAtNoon = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12),
  );
  const days = Math.round((due.getTime() - todayAtNoon.getTime()) / 86_400_000);
  if (days < 0) return 'Overdue';
  if (days === 0) return 'Due today';
  if (days <= 7) return `Due in ${days} day${days === 1 ? '' : 's'}`;
  if (days <= 30) return `Due in ${Math.ceil(days / 7)} weeks`;
  return 'Upcoming';
}
