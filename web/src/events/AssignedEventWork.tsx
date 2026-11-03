import { Link } from '@tanstack/react-router';
import { CheckCircle2, Circle, CircleDot } from 'lucide-react';
import { usePatchEventWorkItem } from '../api/queries';
import type { AssignedEventWorkItem, EventWorkItemStatus } from '../api/types';
import { Avatar, DuePicker, formatDue, formatDueLong, isOverdue } from '../ui/fields';

const statusLabels: Record<EventWorkItemStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  not_needed: 'Not needed',
};

const statusDescriptions: Record<EventWorkItemStatus, string> = {
  not_started: 'Ready, but work has not started.',
  in_progress: 'Work is actively underway.',
  blocked: 'Waiting on something before work can continue.',
  done: 'Work is complete.',
  not_needed: 'This work is intentionally skipped for the event.',
};

const eventSkeletons = ['event-skeleton-a', 'event-skeleton-b', 'event-skeleton-c'];

function EventWorkStatus({ status }: { status: EventWorkItemStatus }) {
  if (status === 'done' || status === 'not_needed') return <CheckCircle2 aria-hidden="true" />;
  if (status === 'in_progress' || status === 'blocked') return <CircleDot aria-hidden="true" />;
  return <Circle aria-hidden="true" />;
}

function AssignedEventWorkRow({
  canEditDates,
  item,
}: {
  canEditDates: boolean;
  item: AssignedEventWorkItem;
}) {
  const patch = usePatchEventWorkItem(item.event_key);
  const statusDescription = statusDescriptions[item.status];
  const overdue = isOverdue(
    item.due_at,
    item.status === 'done' || item.status === 'not_needed' ? 'done' : 'not_started',
  );
  const dueLabel = item.due_at ? `Due ${formatDueLong(item.due_at)}` : 'No due date';

  return (
    <div className={`task-row event-task-row ${item.status === 'done' ? 'is-done' : ''}`}>
      <label
        className="task-row-status event-task-status status-hint hover-hint"
        data-hint-description={statusDescription}
        data-hint-label={statusLabels[item.status]}
        data-status-description={statusDescription}
        data-status-label={statusLabels[item.status]}
      >
        <span className="sr-only">Status for {item.title}</span>
        <EventWorkStatus status={item.status} />
        <select
          aria-label={`Status for ${item.title}: ${statusLabels[item.status]}. ${statusDescription}`}
          disabled={patch.isPending}
          onChange={(event) =>
            patch.mutate({
              key: item.work_item_key,
              status: event.target.value as EventWorkItemStatus,
            })
          }
          value={item.status}
        >
          {(Object.keys(statusLabels) as EventWorkItemStatus[]).map((status) => (
            <option key={status} value={status}>
              {statusLabels[status]}
            </option>
          ))}
        </select>
      </label>
      <Link
        className="task-row-open"
        params={{ eventKey: item.event_key }}
        search={{ view: 'mine' }}
        to="/events/$eventKey"
      >
        <span className="task-row-title">{item.title}</span>
        {item.dependency_blockers ? (
          <span className="task-row-meta">{item.dependency_blockers} dependencies incomplete</span>
        ) : null}
      </Link>
      <span
        className="task-row-project hover-hint hint-align-end"
        data-hint-description="Event project"
        data-hint-label={item.event_title}
      >
        {item.eventReference} · {item.event_title}
      </span>
      <span className="task-row-assignee">
        <Avatar email={item.owner_email} name={item.owner_name} photoUrl={item.owner_photo_url} />
      </span>
      <span
        className={`${overdue ? 'task-row-due is-overdue' : 'task-row-due'} hover-hint hint-align-end`}
        data-hint-description={overdue ? 'This event task is overdue.' : 'Event task deadline'}
        data-hint-label={dueLabel}
      >
        {canEditDates ? (
          <DuePicker
            align="end"
            ariaLabel={`Due date for ${item.title}`}
            disabled={patch.isPending}
            emptyLabel="Add date"
            onSelect={(dueDate) => patch.mutate({ key: item.work_item_key, dueDate })}
            value={item.due_at}
          />
        ) : item.due_at ? (
          formatDue(item.due_at)
        ) : null}
      </span>
      <span
        aria-label="Event project task"
        className="task-row-priority hover-hint hint-align-end"
        data-hint-description="This task belongs to an event workflow."
        data-hint-label="Event project task"
        role="img"
      >
        <span className="priority-dot event-project-dot" />
      </span>
    </div>
  );
}

export function AssignedEventWork({
  canEditDates,
  items,
  loading,
}: {
  canEditDates: boolean;
  items: AssignedEventWorkItem[];
  loading: boolean;
}) {
  if (!loading && items.length === 0) return null;
  return (
    <section aria-label="Assigned event project tasks" className="task-group">
      <header className="task-group-heading">
        <strong>Event projects</strong>
        <span>{items.length} assigned</span>
      </header>
      {loading
        ? eventSkeletons.map((key) => <div className="task-row is-skeleton" key={key} />)
        : items.map((item) => (
            <AssignedEventWorkRow
              canEditDates={canEditDates}
              item={item}
              key={item.work_item_key}
            />
          ))}
    </section>
  );
}
