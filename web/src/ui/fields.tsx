import * as Popover from '@radix-ui/react-popover';
import { Ban, CheckCircle2, Circle, CircleDashed, CircleDot } from 'lucide-react';
import { useState } from 'react';
import type { Assignee, TaskPriority, TaskStatus } from '../api/types';
import { statusLabels } from '../api/types';

export function StatusGlyph({ status }: { status: TaskStatus }) {
  const className = `status-glyph status-${status}`;
  if (status === 'done') return <CheckCircle2 aria-hidden="true" className={className} />;
  if (status === 'blocked') return <Ban aria-hidden="true" className={className} />;
  if (status === 'in_progress') return <CircleDot aria-hidden="true" className={className} />;
  if (status === 'backlog') return <CircleDashed aria-hidden="true" className={className} />;
  return <Circle aria-hidden="true" className={className} />;
}

export function StatusLabel({ status }: { status: TaskStatus }) {
  return (
    <>
      <StatusGlyph status={status} />
      {statusLabels[status]}
    </>
  );
}

export function PriorityDot({ priority }: { priority: TaskPriority | null }) {
  if (!priority) return <span className="priority-dot is-empty" />;
  return <span className={`priority-dot priority-${priority}`} />;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function Avatar({
  email,
  name,
  photoUrl,
}: {
  email?: string | null | undefined;
  name: string | null;
  photoUrl?: string | null | undefined;
}) {
  if (!name) {
    return (
      <span
        aria-label="Unassigned. No staff account is selected."
        className="avatar is-empty hover-hint hint-align-end"
        data-hint-description="No staff account is selected."
        data-hint-label="Unassigned"
        role="img"
      />
    );
  }
  return (
    <span
      aria-label={`${name}${email ? `. ${email}` : ''}`}
      className="avatar hover-hint hint-align-end"
      data-hint-description={email ?? 'Staff account'}
      data-hint-label={name}
      role="img"
    >
      {photoUrl ? <img alt="" referrerPolicy="no-referrer" src={photoUrl} /> : initials(name)}
    </span>
  );
}

/** Assignee needs type-ahead, which a menu of radio items cannot give. */
export function AssigneePicker({
  assignees,
  disabled = false,
  onSelect,
  value,
}: {
  assignees: Assignee[];
  disabled?: boolean;
  onSelect: (assignee: Assignee | null) => void;
  value: { name: string; email: string | null } | null;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const label = value?.name ?? 'Unassigned';
  if (disabled) {
    return (
      <span className="property-value is-readonly">
        <Avatar email={value?.email} name={value?.name ?? null} />
        {label}
      </span>
    );
  }

  const needle = filter.trim().toLowerCase();
  const matches = needle
    ? assignees.filter(
        (assignee) =>
          assignee.name.toLowerCase().includes(needle) ||
          assignee.email.toLowerCase().includes(needle),
      )
    : assignees;

  function choose(assignee: Assignee | null) {
    onSelect(assignee);
    setOpen(false);
    setFilter('');
  }

  return (
    <Popover.Root
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setFilter('');
      }}
      open={open}
    >
      <Popover.Trigger aria-label="Assignee" className="property-value" type="button">
        <Avatar email={value?.email} name={value?.name ?? null} />
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" className="menu menu-filterable" sideOffset={4}>
          <input
            // biome-ignore lint/a11y/noAutofocus: the user deliberately opened this surface, so focusing its field is expected rather than a jump.
            autoFocus
            className="menu-filter"
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find someone"
            value={filter}
          />
          <div className="menu-scroll">
            <button className="menu-item" onClick={() => choose(null)} type="button">
              <span className="menu-item-icon">
                <Avatar name={null} />
              </span>
              <span className="menu-item-label">Unassigned</span>
            </button>
            {matches.map((assignee) => (
              <button
                className="menu-item"
                key={assignee.email}
                onClick={() => choose(assignee)}
                type="button"
              >
                <span className="menu-item-icon">
                  <Avatar email={assignee.email} name={assignee.name} />
                </span>
                <span className="menu-item-label">{assignee.name}</span>
              </button>
            ))}
            {matches.length === 0 ? <p className="menu-empty">No one matches.</p> : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function isoDate(offsetDays: number) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export function DuePicker({
  align = 'start',
  ariaLabel = 'Due date',
  disabled = false,
  emptyLabel = 'No due date',
  onSelect,
  value,
}: {
  align?: 'start' | 'center' | 'end';
  ariaLabel?: string;
  disabled?: boolean;
  emptyLabel?: string;
  onSelect: (value: string | null) => void;
  value: string | null;
}) {
  const [open, setOpen] = useState(false);
  const label = value ? formatDue(value) : emptyLabel;

  if (disabled) return <span className="property-value is-readonly">{label}</span>;

  function choose(next: string | null) {
    onSelect(next);
    setOpen(false);
  }

  return (
    <Popover.Root onOpenChange={setOpen} open={open}>
      <Popover.Trigger aria-label={ariaLabel} className="property-value" type="button">
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={align} className="menu" sideOffset={4}>
          <button className="menu-item" onClick={() => choose(isoDate(0))} type="button">
            <span className="menu-item-label">Today</span>
          </button>
          <button className="menu-item" onClick={() => choose(isoDate(1))} type="button">
            <span className="menu-item-label">Tomorrow</span>
          </button>
          <button className="menu-item" onClick={() => choose(isoDate(7))} type="button">
            <span className="menu-item-label">Next week</span>
          </button>
          <label className="menu-date">
            <span>Pick a date</span>
            <input
              onChange={(event) => choose(event.target.value || null)}
              type="date"
              value={value ?? ''}
            />
          </label>
          {value ? (
            <button className="menu-item is-danger" onClick={() => choose(null)} type="button">
              <span className="menu-item-label">Clear due date</span>
            </button>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function formatDue(value: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
    new Date(`${value}T12:00:00`),
  );
}

export function formatDueLong(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${value}T12:00:00`));
}

export function isOverdue(dueDate: string | null, status: TaskStatus) {
  if (!dueDate || status === 'done' || status === 'cancelled') return false;
  return dueDate < new Date().toISOString().slice(0, 10);
}
