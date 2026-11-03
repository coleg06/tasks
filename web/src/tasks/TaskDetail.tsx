import * as Dialog from '@radix-ui/react-dialog';
import { Check, History, MessageSquare, Trash2, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import {
  useAssignees,
  useBootstrap,
  useCreateComment,
  useDeleteComment,
  usePatchTask,
  useProjects,
  useTask,
} from '../api/queries';
import type { TaskActivity, TaskEffort, TaskPriority, TaskStatus } from '../api/types';
import { effortLabels, priorityLabels, statusLabels, statusOrder } from '../api/types';
import { AssigneePicker, Avatar, DuePicker, PriorityDot, StatusGlyph } from '../ui/fields';
import { MentionTextarea } from '../ui/MentionTextarea';
import { PropertyMenu } from '../ui/PropertyMenu';
import { InlineText } from './InlineText';

const statusOptions = statusOrder.map((status) => ({
  value: status,
  label: statusLabels[status],
  icon: <StatusGlyph status={status} />,
}));

const priorityOptions: { value: TaskPriority | ''; label: string }[] = [
  ...(tenantProfile.tasks.allowsUnprioritized ? [{ value: '' as const, label: 'None' }] : []),
  ...tenantProfile.tasks.priorities.map((value) => ({ value, label: priorityLabels[value] })),
];

const effortOptions: { value: TaskEffort | ''; label: string }[] = [
  { value: '', label: 'None' },
  ...tenantProfile.tasks.effort.map((value) => ({ value, label: effortLabels[value] })),
];

function timestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

const activityFieldLabels: Record<string, string> = {
  assigneeEmail: 'Assignee',
  description: 'Description',
  dueDate: 'Due date',
  effort: 'Effort',
  priority: 'Priority',
  projectKey: 'Project',
  status: 'Status',
  taskTypes: 'Type',
  title: 'Title',
};

function activityValue(field: string, value: unknown) {
  if (value === null || value === '') {
    if (field === 'assigneeEmail') return 'Unassigned';
    if (field === 'dueDate') return 'No due date';
    return 'None';
  }
  if (field === 'status' && typeof value === 'string' && value in statusLabels) {
    return statusLabels[value as TaskStatus];
  }
  if (field === 'priority' && typeof value === 'string' && value in priorityLabels) {
    return priorityLabels[value as TaskPriority];
  }
  if (field === 'effort' && typeof value === 'string' && value in effortLabels) {
    return effortLabels[value as TaskEffort];
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'None';
  const display = String(value);
  return display.length > 100 ? `${display.slice(0, 97)}…` : display;
}

function activityChanges(event: TaskActivity) {
  if (event.action !== 'updated') return [];
  return Object.entries(event.changes).flatMap(([field, rawChange]) => {
    if (!rawChange || typeof rawChange !== 'object') return [];
    const change = rawChange as { before?: unknown; after?: unknown };
    return [
      {
        field: activityFieldLabels[field] ?? field,
        before: activityValue(field, change.before),
        after: activityValue(field, change.after),
      },
    ];
  });
}

function activityAction(action: string) {
  if (action === 'created') return 'created this task';
  if (action === 'commented') return 'commented';
  if (action === 'comment_deleted') return 'deleted a comment';
  return 'updated this task';
}

export function TaskDetail({ onClose, taskKey }: { onClose: () => void; taskKey: string }) {
  const bootstrap = useBootstrap();
  const task = useTask(taskKey);
  const projects = useProjects(true);
  const patch = usePatchTask();
  const detail = task.data;
  const assignees = useAssignees(detail?.project.key);
  const createComment = useCreateComment(taskKey);
  const deleteComment = useDeleteComment(taskKey);
  const [commentBody, setCommentBody] = useState('');

  const canEdit = detail?.canEdit ?? false;
  const permissions = bootstrap.data?.permissions ?? [];
  const editableProjects = (projects.data ?? []).filter(
    (project) =>
      permissions.includes('tasks.manage') || ['owner', 'admin', 'editor'].includes(project.role),
  );

  function apply(
    next: Parameters<typeof patch.mutate>[0]['patch'],
    optimistic?: Parameters<typeof patch.mutate>[0]['optimistic'],
  ) {
    patch.mutate({ key: taskKey, patch: next, ...(optimistic ? { optimistic } : {}) });
  }

  function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!commentBody.trim()) return;
    createComment.mutate(commentBody, { onSuccess: () => setCommentBody('') });
  }

  return (
    <Dialog.Root onOpenChange={(open) => !open && onClose()} open>
      <Dialog.Portal>
        <Dialog.Overlay className="detail-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="detail-sheet"
          onEscapeKeyDown={(event) => {
            // Radix handles Escape during capture, before the textarea can dismiss suggestions.
            if (
              event.target instanceof HTMLElement &&
              event.target.dataset.mentionOpen === 'true'
            ) {
              event.preventDefault();
            }
          }}
        >
          <div className="detail-topbar">
            <span className="detail-key">{detail?.reference ?? ''}</span>
            <span className="detail-saved" aria-live="polite">
              {patch.isPending
                ? 'Saving…'
                : patch.isError
                  ? 'Could not save. Try again.'
                  : patch.isSuccess
                    ? 'Saved'
                    : ''}
            </span>
            {canEdit ? (
              <button
                className="button-primary"
                disabled={patch.isPending || detail?.status === 'done'}
                onClick={() => apply({ status: 'done' })}
                type="button"
              >
                <Check aria-hidden="true" />
                {detail?.status === 'done' ? 'Completed' : 'Complete'}
              </button>
            ) : null}
            <Dialog.Close aria-label="Close" className="icon-button" type="button">
              <X />
            </Dialog.Close>
          </div>

          {!detail ? (
            <div className="detail-loading">Loading…</div>
          ) : (
            <div className="detail-body">
              <Dialog.Title asChild>
                <InlineText
                  ariaLabel="Task title"
                  className="detail-title"
                  onCommit={(title) => apply({ title })}
                  readOnly={!canEdit}
                  value={detail.title}
                />
              </Dialog.Title>

              <dl className="detail-properties">
                <div>
                  <dt>Status</dt>
                  <dd>
                    <PropertyMenu<TaskStatus>
                      ariaLabel="Status"
                      disabled={!canEdit}
                      onSelect={(status) => apply({ status })}
                      options={statusOptions}
                      trigger={
                        <>
                          <StatusGlyph status={detail.status} />
                          {statusLabels[detail.status]}
                        </>
                      }
                      value={detail.status}
                    />
                  </dd>
                </div>

                <div>
                  <dt>Assignee</dt>
                  <dd>
                    <AssigneePicker
                      assignees={assignees.data ?? []}
                      disabled={!canEdit}
                      onSelect={(assignee) =>
                        apply(
                          { assigneeEmail: assignee?.email ?? null },
                          {
                            assignee: assignee
                              ? { name: assignee.name, email: assignee.email }
                              : null,
                          },
                        )
                      }
                      value={detail.assignee}
                    />
                  </dd>
                </div>

                <div>
                  <dt>Priority</dt>
                  <dd>
                    <PropertyMenu
                      ariaLabel="Priority"
                      disabled={!canEdit}
                      onSelect={(value) => apply({ priority: value === '' ? null : value })}
                      options={priorityOptions}
                      trigger={
                        <>
                          <PriorityDot priority={detail.priority} />
                          {detail.priority ? priorityLabels[detail.priority] : 'None'}
                        </>
                      }
                      value={detail.priority ?? ''}
                    />
                  </dd>
                </div>

                <div>
                  <dt>Due</dt>
                  <dd>
                    <DuePicker
                      disabled={!canEdit}
                      onSelect={(dueDate) => apply({ dueDate })}
                      value={detail.dueDate}
                    />
                  </dd>
                </div>

                {tenantProfile.tasks.effort.length ? (
                  <div>
                    <dt>Effort</dt>
                    <dd>
                      <PropertyMenu
                        ariaLabel="Effort"
                        disabled={!canEdit}
                        onSelect={(value) => apply({ effort: value === '' ? null : value })}
                        options={effortOptions}
                        trigger={detail.effort ? effortLabels[detail.effort] : 'None'}
                        value={detail.effort ?? ''}
                      />
                    </dd>
                  </div>
                ) : null}

                <div>
                  <dt>Project</dt>
                  <dd>
                    <PropertyMenu
                      ariaLabel="Project"
                      disabled={!canEdit || editableProjects.length === 0}
                      onSelect={(projectKey) => apply({ projectKey })}
                      options={editableProjects.map((project) => ({
                        value: project.key,
                        label: project.name,
                      }))}
                      trigger={detail.project.name}
                      value={detail.project.key}
                    />
                  </dd>
                </div>

                <div>
                  <dt>Created by</dt>
                  <dd>
                    <span className="property-value is-readonly">
                      <Avatar
                        email={detail.creator.email}
                        name={detail.creator.name}
                        photoUrl={detail.creator.photoUrl}
                      />
                      {detail.creator.name}
                    </span>
                  </dd>
                </div>

                <div>
                  <dt>Created</dt>
                  <dd>
                    <time className="property-value is-readonly" dateTime={detail.createdAt}>
                      {timestamp(detail.createdAt)}
                    </time>
                  </dd>
                </div>

                {detail.taskTypes.length ? (
                  <div>
                    <dt>Type</dt>
                    <dd>
                      <span className="property-value is-readonly">
                        {detail.taskTypes.join(', ')}
                      </span>
                    </dd>
                  </div>
                ) : null}
              </dl>

              <section className="detail-section">
                <h2>Description</h2>
                <InlineText
                  ariaLabel="Description"
                  className="detail-description"
                  multiline
                  onCommit={(description) => apply({ description })}
                  placeholder={canEdit ? 'Add context, links, acceptance criteria…' : '—'}
                  readOnly={!canEdit}
                  value={detail.description}
                />
              </section>

              {detail.content?.plainText || detail.content?.plain_text ? (
                <section className="detail-section">
                  <h2>Imported details</h2>
                  <pre className="detail-source">
                    {detail.content.plainText ?? detail.content.plain_text}
                  </pre>
                </section>
              ) : null}

              <section className="detail-section">
                <h2>
                  <History aria-hidden="true" /> Activity
                  <span className="count">{detail.activity.length}</span>
                </h2>

                {detail.activity.map((event) => {
                  const changes = activityChanges(event);
                  return (
                    <article className="task-activity" key={event.id}>
                      <Avatar email={event.actor.email} name={event.actor.name} />
                      <div>
                        <p>
                          <strong>{event.actor.name}</strong> {activityAction(event.action)}
                        </p>
                        <time dateTime={event.createdAt}>{timestamp(event.createdAt)}</time>
                        {changes.length ? (
                          <ul>
                            {changes.map((change) => (
                              <li key={change.field}>
                                <strong>{change.field}</strong>
                                <span>{change.before}</span>
                                <span aria-hidden="true">→</span>
                                <span>{change.after}</span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </article>
                  );
                })}

                {detail.activity.length === 0 ? (
                  <p className="detail-empty">No activity recorded yet.</p>
                ) : null}
              </section>

              <section className="detail-section">
                <h2>
                  <MessageSquare aria-hidden="true" /> Comments
                  <span className="count">{detail.comments.length}</span>
                </h2>

                {detail.comments.map((comment) => (
                  <article className="comment" key={comment.id}>
                    <header>
                      <strong>{comment.author.name}</strong>
                      <time dateTime={comment.createdAt}>{timestamp(comment.createdAt)}</time>
                      {comment.canDelete || permissions.includes('tasks.manage') ? (
                        <button
                          aria-label="Delete comment"
                          className="icon-button"
                          onClick={() => deleteComment.mutate(comment.id)}
                          type="button"
                        >
                          <Trash2 />
                        </button>
                      ) : null}
                    </header>
                    <p>{comment.body}</p>
                  </article>
                ))}

                {detail.comments.length === 0 ? (
                  <p className="detail-empty">No comments yet.</p>
                ) : null}

                {permissions.includes('tasks.comment') ? (
                  <form className="comment-form" onSubmit={submitComment}>
                    <MentionTextarea
                      onChange={setCommentBody}
                      people={assignees.data ?? []}
                      value={commentBody}
                    />
                    <button
                      className="button-primary"
                      disabled={createComment.isPending || !commentBody.trim()}
                      type="submit"
                    >
                      {createComment.isPending ? 'Posting…' : 'Comment'}
                    </button>
                  </form>
                ) : null}
              </section>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
