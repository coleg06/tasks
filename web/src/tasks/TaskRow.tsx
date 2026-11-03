import { usePatchTask } from '../api/queries';
import type { TaskStatus, TaskSummary } from '../api/types';
import { priorityLabels, statusLabels, statusOrder } from '../api/types';
import {
  Avatar,
  DuePicker,
  formatDue,
  formatDueLong,
  isOverdue,
  PriorityDot,
  StatusGlyph,
} from '../ui/fields';
import { PropertyMenu } from '../ui/PropertyMenu';
import { taskStatusHelp } from '../ui/statusHelp';

const statusOptions = statusOrder.map((status) => ({
  value: status,
  label: statusLabels[status],
  icon: <StatusGlyph status={status} />,
}));

/**
 * The single row implementation. At rest it shows information only; controls
 * appear on hover or when used. Everything here is one line, 40px tall.
 */
export function TaskRow({
  canEdit,
  isFocused,
  isOpen,
  onOpen,
  task,
}: {
  canEdit: boolean;
  isFocused: boolean;
  isOpen: boolean;
  onOpen: (key: string) => void;
  task: TaskSummary;
}) {
  const patch = usePatchTask();
  const overdue = isOverdue(task.dueDate, task.status);
  const statusHelp = taskStatusHelp[task.status];
  const dueLabel = task.dueDate ? `Due ${formatDueLong(task.dueDate)}` : 'No due date';
  const priorityLabel = task.priority ? `${priorityLabels[task.priority]} priority` : 'No priority';
  const priorityDescription = task.priority
    ? task.priority === 'critical'
      ? 'Needs immediate attention before other work.'
      : task.priority === 'high'
        ? 'Needs attention before medium and low priority work.'
        : task.priority === 'medium'
          ? 'Normal priority.'
          : 'Can follow higher-priority work.'
    : 'No priority has been set.';

  const className = [
    'task-row',
    isOpen ? 'is-open' : '',
    isFocused ? 'is-focused' : '',
    task.status === 'done' || task.status === 'cancelled' ? 'is-done' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} data-task-key={task.key}>
      <span
        className="task-row-status status-hint hover-hint"
        data-hint-description={statusHelp.description}
        data-hint-label={statusHelp.label}
        data-status-description={statusHelp.description}
        data-status-label={statusHelp.label}
      >
        {canEdit ? (
          <PropertyMenu<TaskStatus>
            ariaLabel={`Status for ${task.title}: ${statusHelp.label}. ${statusHelp.description}`}
            onSelect={(status) => patch.mutate({ key: task.key, patch: { status } })}
            options={statusOptions}
            trigger={<StatusGlyph status={task.status} />}
            value={task.status}
          />
        ) : (
          <span
            aria-label={`Status for ${task.title}: ${statusHelp.label}. ${statusHelp.description}`}
            role="img"
          >
            <StatusGlyph status={task.status} />
          </span>
        )}
      </span>

      <button className="task-row-open" onClick={() => onOpen(task.key)} type="button">
        <span className="task-row-title">{task.title}</span>
        {task.taskTypes.length ? (
          <span className="task-row-meta">{task.taskTypes.join(' · ')}</span>
        ) : null}
      </button>

      <span
        className="task-row-project hover-hint hint-align-end"
        data-hint-description={`Project in ${task.project.workspace.name}`}
        data-hint-label={task.project.name}
      >
        {task.project.name}
      </span>

      <span className="task-row-assignee">
        <Avatar email={task.assignee?.email} name={task.assignee?.name ?? null} />
      </span>

      <span
        className={`${overdue ? 'task-row-due is-overdue' : 'task-row-due'} hover-hint hint-align-end`}
        data-hint-description={overdue ? 'This task is overdue.' : 'Task deadline'}
        data-hint-label={dueLabel}
      >
        {canEdit ? (
          <DuePicker
            align="end"
            ariaLabel={`Due date for ${task.title}`}
            disabled={patch.isPending}
            emptyLabel="Add date"
            onSelect={(dueDate) => patch.mutate({ key: task.key, patch: { dueDate } })}
            value={task.dueDate}
          />
        ) : task.dueDate ? (
          formatDue(task.dueDate)
        ) : null}
      </span>

      <span
        aria-label={`${priorityLabel}. ${priorityDescription}`}
        className="task-row-priority hover-hint hint-align-end"
        data-hint-description={priorityDescription}
        data-hint-label={priorityLabel}
        role="img"
      >
        <PriorityDot priority={task.priority} />
      </span>
    </div>
  );
}
