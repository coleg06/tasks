import * as Dialog from '@radix-ui/react-dialog';
import { CornerDownLeft, Folder, ListTodo, Search } from 'lucide-react';
import { type KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { useProjects, useTasks } from '../api/queries';
import type { TaskView } from '../api/types';
import { viewLabels } from '../api/types';
import { useTasksSearch, useUpdateSearch } from '../router';
import { StatusGlyph } from '../ui/fields';

type Command =
  | {
      kind: 'task';
      id: string;
      label: string;
      hint: string;
      taskKey: string;
      status: never | string;
    }
  | { kind: 'view'; id: string; label: string; hint: string; view: TaskView }
  | { kind: 'project'; id: string; label: string; hint: string; projectKey: string | undefined };

export function CommandPalette({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const search = useTasksSearch();
  const updateSearch = useUpdateSearch();
  const projects = useProjects(open);

  // Search the whole workspace, not just the active view.
  const results = useTasks(
    { view: 'open', ...(query.trim() ? { q: query.trim() } : {}) },
    open && query.trim().length > 1,
  );

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const needle = query.trim().toLowerCase();
    const list: Command[] = [];

    for (const task of results.data ?? []) {
      list.push({
        kind: 'task',
        id: `task-${task.key}`,
        label: task.title,
        hint: task.project.name,
        taskKey: task.key,
        status: task.status,
      });
    }

    for (const view of Object.keys(viewLabels) as TaskView[]) {
      if (!needle || viewLabels[view].toLowerCase().includes(needle)) {
        list.push({
          kind: 'view',
          id: `view-${view}`,
          label: viewLabels[view],
          hint: 'View',
          view,
        });
      }
    }

    if (!needle || 'all projects'.includes(needle)) {
      list.push({
        kind: 'project',
        id: 'project-all',
        label: 'All projects',
        hint: 'Project',
        projectKey: undefined,
      });
    }
    for (const project of projects.data ?? []) {
      if (!needle || project.name.toLowerCase().includes(needle)) {
        list.push({
          kind: 'project',
          id: `project-${project.key}`,
          label: project.name,
          hint: 'Project',
          projectKey: project.key,
        });
      }
    }

    return list.slice(0, 40);
  }, [projects.data, query, results.data]);

  function run(command: Command | undefined) {
    if (!command) return;
    if (command.kind === 'task') updateSearch({ task: command.taskKey });
    if (command.kind === 'view') updateSearch({ view: command.view, task: undefined });
    if (command.kind === 'project') updateSearch({ project: command.projectKey, task: undefined });
    onOpenChange(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((current) => Math.min(current + 1, commands.length - 1));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((current) => Math.max(current - 1, 0));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(commands[index]);
    }
  }

  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content aria-describedby={undefined} className="palette">
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <div className="palette-input">
            <Search aria-hidden="true" />
            <input
              // biome-ignore lint/a11y/noAutofocus: the user deliberately opened this surface, so focusing its field is expected rather than a jump.
              autoFocus
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              onKeyDown={onKeyDown}
              placeholder="Search tasks, jump to a view or project"
              value={query}
            />
          </div>
          <div className="palette-results">
            {commands.map((command, position) => (
              <button
                className={position === index ? 'palette-item is-active' : 'palette-item'}
                key={command.id}
                onClick={() => run(command)}
                onMouseEnter={() => setIndex(position)}
                type="button"
              >
                <span className="palette-icon">
                  {command.kind === 'task' ? (
                    <StatusGlyph status={command.status as never} />
                  ) : command.kind === 'view' ? (
                    <ListTodo />
                  ) : (
                    <Folder />
                  )}
                </span>
                <span className="palette-label">{command.label}</span>
                <span className="palette-hint">{command.hint}</span>
              </button>
            ))}
            {commands.length === 0 ? <p className="palette-empty">No matches.</p> : null}
          </div>
          <div className="palette-footer">
            <CornerDownLeft aria-hidden="true" /> to open · esc to dismiss
            {search.project ? ` · scoped search ignores project filter` : ''}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
