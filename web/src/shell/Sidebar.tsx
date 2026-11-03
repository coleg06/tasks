import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link, useMatchRoute } from '@tanstack/react-router';
import {
  Archive,
  ArrowLeft,
  BarChart3,
  CalendarDays,
  CheckCircle2,
  ChevronsUpDown,
  Folder,
  ListTodo,
  LockKeyhole,
  LogOut,
  Plus,
  Settings,
  SlidersHorizontal,
  UserRound,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { defaultRuntimeFeatures } from '../../../shared/runtime-features';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useBootstrap, useProjects } from '../api/queries';
import type { TaskView } from '../api/types';
import { viewLabels } from '../api/types';
import { CreateProjectDialog } from '../projects/CreateProjectDialog';
import { mergeSearch, useTasksSearch } from '../router';
import { TaskPreferencesDialog } from '../tasks/TaskPreferencesDialog';
import { Avatar } from '../ui/fields';

const viewIcons: Record<TaskView, typeof ListTodo> = {
  open: ListTodo,
  mine: UserRound,
  backlog: Archive,
  completed: CheckCircle2,
};

export function Sidebar() {
  const bootstrap = useBootstrap();
  const search = useTasksSearch();
  const matchRoute = useMatchRoute();
  const [createOpen, setCreateOpen] = useState(false);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [sidebarScrolling, setSidebarScrolling] = useState(false);
  const signOutForm = useRef<HTMLFormElement>(null);
  const sidebarScrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const user = bootstrap.data?.user;
  const features = bootstrap.data?.features ?? defaultRuntimeFeatures;
  const displayName =
    `${user?.first_name ?? ''} ${user?.last_name ?? ''}`.trim() || (user?.email ?? null);

  const canManage = bootstrap.data?.permissions.includes('tasks.manage') ?? false;
  const canViewTasks =
    bootstrap.data?.permissions.some((permission) =>
      ['tasks.view', 'tasks.personal'].includes(permission),
    ) ?? false;
  const canViewEvents =
    features.events && (bootstrap.data?.permissions.includes('events.view') ?? false);
  const canViewAnalytics =
    features.workflowAnalytics &&
    (bootstrap.data?.permissions.some((permission) =>
      ['events.manage', 'tasks.manage'].includes(permission),
    ) ??
      false);
  const onTasks = Boolean(matchRoute({ to: '/' }));
  const onEvents = Boolean(matchRoute({ to: '/events', fuzzy: true }));
  const showTaskWorkspace = canViewTasks && (canManage || !onEvents);
  const projects = useProjects(showTaskWorkspace && features.projects);

  useEffect(
    () => () => {
      if (sidebarScrollIdleTimer.current) clearTimeout(sidebarScrollIdleTimer.current);
    },
    [],
  );

  const markSidebarScrolling = () => {
    setSidebarScrolling(true);
    if (sidebarScrollIdleTimer.current) clearTimeout(sidebarScrollIdleTimer.current);
    sidebarScrollIdleTimer.current = setTimeout(() => {
      setSidebarScrolling(false);
      sidebarScrollIdleTimer.current = null;
    }, 700);
  };

  return (
    <aside className="tasks-sidebar">
      <div
        className={`tasks-sidebar-top${sidebarScrolling ? ' is-scrolling' : ''}`}
        onScroll={markSidebarScrolling}
      >
        <div className="tasks-brand">
          <span>{tenantProfile.organizationName}</span>
          <strong>{tenantProfile.productName}</strong>
        </div>

        {showTaskWorkspace ? (
          <nav className="tasks-nav" aria-label="Task views">
            {(Object.keys(viewLabels) as TaskView[]).map((view) => {
              const Icon = viewIcons[view];
              return (
                <Link
                  activeOptions={{ exact: true, includeSearch: false }}
                  className={onTasks && search.view === view ? 'is-active' : ''}
                  key={view}
                  search={mergeSearch({ view, task: undefined })}
                  to="/"
                >
                  <Icon aria-hidden="true" />
                  {viewLabels[view]}
                </Link>
              );
            })}
          </nav>
        ) : null}

        {canViewEvents ? (
          <section className="tasks-projects tasks-workspaces">
            <div className="tasks-projects-heading">
              <span>Workspaces</span>
            </div>
            {!canViewTasks ? (
              <Link activeOptions={{ exact: true }} search={{ view: 'mine' }} to="/">
                <UserRound aria-hidden="true" /> My Tasks
              </Link>
            ) : null}
            <Link activeOptions={{ exact: false }} search={{ view: 'open' }} to="/events">
              <CalendarDays aria-hidden="true" /> Events & promotion
            </Link>
            {canViewAnalytics ? (
              <Link activeOptions={{ exact: true }} search={{ view: 'open' }} to="/analytics">
                <BarChart3 aria-hidden="true" /> Workflow analytics
              </Link>
            ) : null}
          </section>
        ) : null}

        {showTaskWorkspace && features.projects ? (
          <section className="tasks-projects">
            <div className="tasks-projects-heading">
              <span>Projects</span>
              {canManage && tenantProfile.tasks.projectAdministration ? (
                <button
                  aria-label="Create project"
                  onClick={() => setCreateOpen(true)}
                  type="button"
                >
                  <Plus />
                </button>
              ) : null}
            </div>

            <Link
              className={onTasks && !search.project ? 'is-active' : ''}
              search={mergeSearch({ project: undefined, task: undefined })}
              to="/"
            >
              <Folder aria-hidden="true" /> All projects
            </Link>

            {(projects.data ?? []).map((project) => (
              <Link
                className={onTasks && search.project === project.key ? 'is-active' : ''}
                key={project.key}
                search={mergeSearch({ project: project.key, task: undefined })}
                title={
                  project.type === 'personal'
                    ? 'Private to you'
                    : `${project.workspace.name} · ${project.visibility}`
                }
                to="/"
              >
                {project.type === 'personal' ? (
                  <LockKeyhole aria-hidden="true" />
                ) : (
                  <Folder aria-hidden="true" />
                )}{' '}
                {project.name}
              </Link>
            ))}
          </section>
        ) : null}
      </div>

      {/* One control rather than three stacked blocks. Everything about the
          person, rather than the work, lives behind the account row, and it
          shares the navigation's inset so the avatar lines up with the icons
          above it. */}
      <div className="tasks-account">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className="account-trigger">
            <Avatar email={user?.email} name={displayName} photoUrl={user?.photo_url} />
            <span className="account-identity">
              <strong>{displayName}</strong>
              <small>{user?.email}</small>
            </span>
            <ChevronsUpDown aria-hidden="true" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="menu account-menu"
              side="top"
              sideOffset={6}
            >
              {canManage && tenantProfile.tasks.userAdministration ? (
                <DropdownMenu.Item asChild className="menu-item">
                  <Link search={mergeSearch({})} to="/admin">
                    <span className="menu-item-icon">
                      <Settings aria-hidden="true" />
                    </span>
                    <span className="menu-item-label">Administration</span>
                  </Link>
                </DropdownMenu.Item>
              ) : null}
              {tenantProfile.tasks.accountPreferences && (canViewTasks || canViewEvents) ? (
                <DropdownMenu.Item className="menu-item" onSelect={() => setPreferencesOpen(true)}>
                  <span className="menu-item-icon">
                    <SlidersHorizontal aria-hidden="true" />
                  </span>
                  <span className="menu-item-label">Task preferences</span>
                </DropdownMenu.Item>
              ) : null}
              {tenantProfile.capabilities.portal ? (
                <DropdownMenu.Item asChild className="menu-item">
                  <a href={tenantProfile.links.portal}>
                    <span className="menu-item-icon">
                      <ArrowLeft aria-hidden="true" />
                    </span>
                    <span className="menu-item-label">Back to Portal</span>
                  </a>
                </DropdownMenu.Item>
              ) : null}
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item
                className="menu-item"
                onSelect={() => signOutForm.current?.submit()}
              >
                <span className="menu-item-icon">
                  <LogOut aria-hidden="true" />
                </span>
                <span className="menu-item-label">Sign out</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>

        {/* Sign-out stays a browser navigation so the active identity provider
            owns session invalidation rather than the UI imitating it. */}
        <form
          action={tenantProfile.identity.logoutPath}
          className="sr-only"
          method={tenantProfile.identity.logoutMethod}
          ref={signOutForm}
        >
          <button tabIndex={-1} type="submit">
            Sign out
          </button>
        </form>
      </div>

      {features.projects && tenantProfile.tasks.projectAdministration ? (
        <CreateProjectDialog onOpenChange={setCreateOpen} open={createOpen} />
      ) : null}
      <TaskPreferencesDialog
        onOpenChange={setPreferencesOpen}
        open={preferencesOpen}
        showTaskCreation={canViewTasks}
      />
    </aside>
  );
}
