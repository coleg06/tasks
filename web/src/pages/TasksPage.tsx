import { EyeOff, ListTodo, Plus, Search, Settings } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { defaultRuntimeFeatures } from '../../../shared/runtime-features';
import { tenantProfile } from '../../../shared/tenant-profile';
import {
  useAssignedEventWorkItems,
  useAssignees,
  useBootstrap,
  usePatchTask,
  useProjects,
  useTasks,
} from '../api/queries';
import type { TaskStatus } from '../api/types';
import { statusOrder, viewLabels } from '../api/types';
import { AssignedEventWork } from '../events/AssignedEventWork';
import { useHotkeys } from '../hooks/useHotkeys';
import { ProjectSettingsDialog } from '../projects/ProjectSettingsDialog';
import { useTasksSearch, useUpdateSearch } from '../router';
import { CommandPalette } from '../tasks/CommandPalette';
import { Composer } from '../tasks/Composer';
import { filterTasks } from '../tasks/filters';
import { sortTasks } from '../tasks/sorting';
import { TaskCreateSheet } from '../tasks/TaskCreateSheet';
import { TaskDetail } from '../tasks/TaskDetail';
import { AddFilterMenu, TaskFilterChips } from '../tasks/TaskFilterBar';
import { TaskRow } from '../tasks/TaskRow';
import { TaskSortMenu } from '../tasks/TaskSortMenu';

const skeletonRows = Array.from({ length: 8 }, (_, index) => `skeleton-${index}`);

export function TasksPage() {
  const search = useTasksSearch();
  const updateSearch = useUpdateSearch();
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const features = bootstrap.data?.features ?? defaultRuntimeFeatures;
  const canManage = permissions.includes('tasks.manage');
  const canManageEvents = features.events && permissions.includes('events.manage');
  const canViewTasks = permissions.some((permission) =>
    ['tasks.view', 'tasks.personal'].includes(permission),
  );
  const canViewEvents = features.events && permissions.includes('events.view');
  const effectiveView = canViewTasks ? search.view : 'mine';
  const hideAgentTasks =
    tenantProfile.agent.enabled &&
    tenantProfile.capabilities.hideAgentTasks &&
    search.hideAgent === '1';
  const projects = useProjects(canViewTasks);
  const patch = usePatchTask();

  const [draftQuery, setDraftQuery] = useState(search.q ?? '');
  const [quickComposerOpen, setQuickComposerOpen] = useState(false);
  const [guidedCreateOpen, setGuidedCreateOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);

  // Debounce the search box into the URL so history stays usable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: must fire on the typed value only; including search.q or updateSearch would re-arm the timer from the navigation it just caused.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if ((search.q ?? '') !== draftQuery) updateSearch({ q: draftQuery || undefined });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [draftQuery]);

  const queryFilters = useMemo(
    () => ({
      view: effectiveView,
      ...(search.project ? { project: search.project } : {}),
      ...(search.q ? { q: search.q } : {}),
      ...(search.sort ? { sort: search.sort } : {}),
      ...(hideAgentTasks ? { hideAgent: true } : {}),
    }),
    [effectiveView, hideAgentTasks, search.project, search.q, search.sort],
  );

  const tasks = useTasks(queryFilters, canViewTasks);
  const assignedEventWork = useAssignedEventWorkItems(
    { ...(search.q ? { q: search.q } : {}) },
    canViewEvents && effectiveView === 'mine',
  );
  const currentEmail = bootstrap.data?.user?.email;
  const activeProject = (projects.data ?? []).find((project) => project.key === search.project);
  const canConfigureProject =
    features.projects &&
    activeProject &&
    activeProject.type !== 'personal' &&
    canManage &&
    ['owner', 'admin'].includes(activeProject.role);
  const editableProjects = (projects.data ?? []).filter(
    (project) => canManage || ['owner', 'admin', 'editor'].includes(project.role),
  );
  const composerProject = activeProject?.key ?? editableProjects[0]?.key;
  const taskCreationMode = bootstrap.data?.user?.task_creation_mode ?? 'guided';

  function openTaskCreation() {
    if (!composerProject) return;
    if (taskCreationMode === 'quick') setQuickComposerOpen(true);
    else setGuidedCreateOpen(true);
  }

  // Loaded for the filter bar as well as the composer, so the assignee filter
  // has real names to offer.
  const assignees = useAssignees(composerProject);

  const filters = useMemo(
    () => ({
      ...(search.status ? { status: search.status } : {}),
      ...(search.assignee ? { assignee: search.assignee } : {}),
      ...(search.priority ? { priority: search.priority } : {}),
      ...(search.due ? { due: search.due } : {}),
    }),
    [search.assignee, search.due, search.priority, search.status],
  );

  const filteredRows = useMemo(
    () => filterTasks(tasks.data ?? [], filters, currentEmail, hideAgentTasks),
    [currentEmail, filters, hideAgentTasks, tasks.data],
  );
  const rows = useMemo(
    () => sortTasks(filteredRows, search.sort ?? 'smart'),
    [filteredRows, search.sort],
  );

  useEffect(() => {
    setFocusIndex((current) => Math.min(current, Math.max(rows.length - 1, 0)));
  }, [rows.length]);

  const focused = rows[focusIndex];

  useHotkeys([
    { key: 'mod+k', run: () => setPaletteOpen(true), whileTyping: true },
    { key: 'j', run: () => setFocusIndex((i) => Math.min(i + 1, rows.length - 1)) },
    { key: 'k', run: () => setFocusIndex((i) => Math.max(i - 1, 0)) },
    { key: 'Enter', run: () => focused && updateSearch({ task: focused.key }) },
    {
      key: 'Escape',
      run: () => {
        if (search.task) updateSearch({ task: undefined });
        else setQuickComposerOpen(false);
      },
    },
    { key: 'c', run: openTaskCreation },
    { key: '/', run: () => document.getElementById('task-search')?.focus() },
    ...statusOrder.map((status, position) => ({
      key: String(position + 1),
      run: () => {
        const target = search.task ? rows.find((row) => row.key === search.task) : focused;
        if (target) patch.mutate({ key: target.key, patch: { status: status as TaskStatus } });
      },
    })),
  ]);

  const heading = !canViewTasks
    ? 'My Tasks'
    : activeProject
      ? `${activeProject.name} · ${viewLabels[search.view]}`
      : viewLabels[search.view];
  const eventRows = assignedEventWork.data ?? [];
  const total = (tasks.data?.length ?? 0) + eventRows.length;

  return (
    <>
      {/* Keep page identity and page actions in the header. Search and filters
          live with the list they affect in the toolbar immediately below. */}
      <header className="tasks-topbar">
        <div className="tasks-heading">
          <strong className="tasks-page-title">{heading}</strong>
          <span className="tasks-count">
            {tasks.isLoading ? '…' : rows.length === total ? total : `${rows.length} of ${total}`}
          </span>
        </div>

        <div className="tasks-topbar-actions">
          {canConfigureProject ? (
            <button className="button-quiet" onClick={() => setSettingsOpen(true)} type="button">
              <Settings aria-hidden="true" /> Project settings
            </button>
          ) : null}

          {composerProject ? (
            <button className="button-primary" onClick={openTaskCreation} type="button">
              <Plus aria-hidden="true" /> New task
            </button>
          ) : null}
        </div>
      </header>

      <div className="tasks-list-toolbar">
        <div className="tasks-query-group">
          <label className="tasks-search">
            <Search aria-hidden="true" />
            <span className="sr-only">Search tasks and event projects</span>
            <input
              id="task-search"
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder="Search tasks and event projects…"
              type="search"
              value={draftQuery}
            />
          </label>

          {canViewTasks ? (
            <>
              <AddFilterMenu
                assignees={assignees.data ?? []}
                filters={filters}
                onChange={(patchFilters) => updateSearch(patchFilters)}
              />
              <TaskSortMenu
                onChange={(sort) => updateSearch({ sort: sort === 'smart' ? undefined : sort })}
                value={search.sort ?? 'smart'}
              />
            </>
          ) : null}
        </div>

        {canViewTasks &&
        tenantProfile.agent.enabled &&
        tenantProfile.capabilities.hideAgentTasks ? (
          <button
            aria-pressed={hideAgentTasks}
            className={`button-quiet tasks-agent-toggle${hideAgentTasks ? ' is-active' : ''}`}
            onClick={() => updateSearch({ hideAgent: search.hideAgent === '1' ? undefined : '1' })}
            type="button"
          >
            <EyeOff aria-hidden="true" />
            Hide Agent tasks
          </button>
        ) : null}

        {canViewTasks ? (
          <TaskFilterChips
            assignees={assignees.data ?? []}
            filters={filters}
            onChange={(patchFilters) => updateSearch(patchFilters)}
            onClear={() =>
              updateSearch({
                status: undefined,
                assignee: undefined,
                priority: undefined,
                due: undefined,
              })
            }
          />
        ) : null}
      </div>

      <section className="tasks-list">
        {quickComposerOpen && composerProject ? (
          <Composer
            assignees={assignees.data ?? []}
            onClose={() => setQuickComposerOpen(false)}
            onCreated={(key) => {
              // Hand straight off to the detail sheet so the rest of the task
              // can be filled in without a second trip.
              setQuickComposerOpen(false);
              updateSearch({ task: key });
            }}
            projectKey={composerProject}
          />
        ) : null}

        <AssignedEventWork
          canEditDates={canManageEvents}
          items={eventRows}
          loading={assignedEventWork.isLoading}
        />

        {tasks.isError ? (
          <div className="tasks-empty" role="alert">
            <ListTodo aria-hidden="true" />
            <strong>Unable to load tasks</strong>
            <span>The task service rejected or could not complete this filter.</span>
            <button className="button-quiet" onClick={() => void tasks.refetch()} type="button">
              Try again
            </button>
          </div>
        ) : tasks.isLoading ? (
          skeletonRows.map((id) => <div className="task-row is-skeleton" key={id} />)
        ) : rows.length === 0 && eventRows.length === 0 && !assignedEventWork.isLoading ? (
          <div className="tasks-empty">
            <ListTodo aria-hidden="true" />
            <strong>{total === 0 ? 'No tasks here' : 'No tasks match these filters'}</strong>
            <span>
              {total === 0
                ? canViewTasks
                  ? 'Press c to add one.'
                  : 'Assigned event-project tasks will appear here.'
                : 'Try clearing a filter.'}
            </span>
          </div>
        ) : rows.length ? (
          <section aria-label="Task projects" className="task-group">
            {eventRows.length ? (
              <header className="task-group-heading">
                <strong>Task projects</strong>
                <span>{rows.length} tasks</span>
              </header>
            ) : null}
            {rows.map((task, position) => (
              <TaskRow
                canEdit={canManage || editableProjects.some((p) => p.key === task.project.key)}
                isFocused={position === focusIndex}
                isOpen={search.task === task.key}
                key={task.key}
                onOpen={(key) => updateSearch({ task: key })}
                task={task}
              />
            ))}
          </section>
        ) : null}
      </section>

      {canViewTasks && search.task ? (
        <TaskDetail onClose={() => updateSearch({ task: undefined })} taskKey={search.task} />
      ) : null}

      {composerProject ? (
        <TaskCreateSheet
          initialProjectKey={composerProject}
          onCreated={(key) => {
            setGuidedCreateOpen(false);
            updateSearch({ task: key });
          }}
          onOpenChange={setGuidedCreateOpen}
          open={guidedCreateOpen}
          projects={editableProjects}
        />
      ) : null}

      {canViewTasks ? <CommandPalette onOpenChange={setPaletteOpen} open={paletteOpen} /> : null}
      {features.projects && activeProject ? (
        <ProjectSettingsDialog
          onOpenChange={setSettingsOpen}
          open={settingsOpen}
          project={activeProject}
        />
      ) : null}
    </>
  );
}
