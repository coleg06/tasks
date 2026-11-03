import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useAssignees, useCreateTask } from '../api/queries';
import type { Project, TaskEffort, TaskPriority, TaskStatus } from '../api/types';
import { effortLabels, priorityLabels, statusLabels, statusOrder } from '../api/types';

export function TaskCreateSheet({
  initialProjectKey,
  onCreated,
  onOpenChange,
  open,
  projects,
}: {
  initialProjectKey: string;
  onCreated: (key: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  projects: Project[];
}) {
  const availableInitialProject = useMemo(
    () =>
      projects.find((project) => project.key === initialProjectKey)?.key ?? projects[0]?.key ?? '',
    [initialProjectKey, projects],
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [projectKey, setProjectKey] = useState(availableInitialProject);
  const [status, setStatus] = useState<TaskStatus>(statusOrder[0] ?? 'not_started');
  const [priority, setPriority] = useState<TaskPriority | ''>(
    tenantProfile.tasks.allowsUnprioritized ? '' : (tenantProfile.tasks.priorities[0] ?? ''),
  );
  const [effort, setEffort] = useState<TaskEffort | ''>('');
  const [assigneeEmail, setAssigneeEmail] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [mutationKey, setMutationKey] = useState(() => crypto.randomUUID());
  const assignees = useAssignees(projectKey || undefined);
  const createTask = useCreateTask();

  function resetForm() {
    setTitle('');
    setDescription('');
    setProjectKey(availableInitialProject);
    setStatus(statusOrder[0] ?? 'not_started');
    setPriority(
      tenantProfile.tasks.allowsUnprioritized ? '' : (tenantProfile.tasks.priorities[0] ?? ''),
    );
    setEffort('');
    setAssigneeEmail('');
    setDueDate('');
    setMutationKey(crypto.randomUUID());
  }

  useEffect(() => {
    if (!projectKey && availableInitialProject) setProjectKey(availableInitialProject);
  }, [availableInitialProject, projectKey]);

  function changeProject(nextProjectKey: string) {
    setProjectKey(nextProjectKey);
    setAssigneeEmail('');
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim() || !projectKey) return;
    createTask.mutate(
      {
        title: title.trim(),
        mutationKey,
        description: description.trim(),
        projectKey,
        status,
        priority: priority || null,
        effort: effort || null,
        assigneeEmail: assigneeEmail || null,
        dueDate: dueDate || null,
        taskTypes: [],
      },
      {
        onSuccess: (task) => {
          resetForm();
          onCreated(task.key);
        },
      },
    );
  }

  function changeOpen(nextOpen: boolean) {
    if (!nextOpen && !createTask.isPending) resetForm();
    onOpenChange(nextOpen);
  }

  return (
    <Dialog.Root onOpenChange={changeOpen} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="detail-overlay" />
        <Dialog.Content className="task-create-sheet">
          <div className="detail-topbar task-create-topbar">
            <Dialog.Title className="task-create-heading">New task</Dialog.Title>
            <Dialog.Close aria-label="Close" className="icon-button" type="button">
              <X />
            </Dialog.Close>
          </div>

          <form className="task-create-form" onSubmit={submit}>
            <p className="task-create-intro">
              Capture the owner, timing, and importance now so the task is ready to work.
            </p>

            <label className="task-create-title">
              <span>Task name</span>
              <input
                // biome-ignore lint/a11y/noAutofocus: opening the creation sheet is an explicit request to enter a task.
                autoFocus
                maxLength={240}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What needs to be done?"
                required
                value={title}
              />
            </label>

            <label>
              <span>Description</span>
              <textarea
                maxLength={10_000}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Add context, links, or what done looks like…"
                rows={5}
                value={description}
              />
            </label>

            <div className="task-create-grid">
              <label>
                <span>Project</span>
                <select
                  onChange={(event) => changeProject(event.target.value)}
                  required
                  value={projectKey}
                >
                  {projects.map((project) => (
                    <option key={project.key} value={project.key}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Assignee</span>
                <select
                  onChange={(event) => setAssigneeEmail(event.target.value)}
                  value={assigneeEmail}
                >
                  <option value="">Unassigned</option>
                  {(assignees.data ?? []).map((assignee) => (
                    <option key={assignee.email} value={assignee.email}>
                      {assignee.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Status</span>
                <select
                  onChange={(event) => setStatus(event.target.value as TaskStatus)}
                  value={status}
                >
                  {statusOrder.map((value) => (
                    <option key={value} value={value}>
                      {statusLabels[value]}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>Due date</span>
                <input
                  onChange={(event) => setDueDate(event.target.value)}
                  type="date"
                  value={dueDate}
                />
              </label>

              <label>
                <span>Priority</span>
                <select
                  onChange={(event) => setPriority(event.target.value as TaskPriority | '')}
                  value={priority}
                >
                  {tenantProfile.tasks.allowsUnprioritized ? <option value="">None</option> : null}
                  {tenantProfile.tasks.priorities.map((value) => (
                    <option key={value} value={value}>
                      {priorityLabels[value]}
                    </option>
                  ))}
                </select>
              </label>

              {tenantProfile.tasks.effort.length ? (
                <label>
                  <span>Effort</span>
                  <select
                    onChange={(event) => setEffort(event.target.value as TaskEffort | '')}
                    value={effort}
                  >
                    <option value="">None</option>
                    {tenantProfile.tasks.effort.map((value) => (
                      <option key={value} value={value}>
                        {effortLabels[value]}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            {createTask.error ? (
              <p className="form-error" role="alert">
                {createTask.error.message}
              </p>
            ) : null}

            <div className="task-create-actions">
              <Dialog.Close className="button-quiet" type="button">
                Cancel
              </Dialog.Close>
              <button
                className="button-primary"
                disabled={createTask.isPending || !title.trim() || !projectKey}
                type="submit"
              >
                {createTask.isPending ? 'Creating…' : 'Create task'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
