import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useNavigate,
  useSearch,
} from '@tanstack/react-router';
import { tenantProfile } from '../../shared/tenant-profile';

export type { TasksSearch } from './search-params';

import { AdminPage } from './pages/AdminPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { EventDetailPage } from './pages/EventDetailPage';
import { EventsPage } from './pages/EventsPage';
import { NewEventPage } from './pages/NewEventPage';
import { TasksPage } from './pages/TasksPage';
import { type TasksSearch, validateSearch } from './search-params';
import { AppShell } from './shell/AppShell';

function WorkspaceIndex() {
  return <TasksPage />;
}

const rootRoute = createRootRoute({
  validateSearch,
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: WorkspaceIndex,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin',
  component: AdminPage,
});

const analyticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/analytics',
  component: AnalyticsPage,
});

const eventsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events',
  component: EventsPage,
});

const newEventRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events/new',
  component: NewEventPage,
});

const eventDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/events/$eventKey',
  component: EventDetailPage,
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    indexRoute,
    ...(tenantProfile.capabilities.events
      ? [
          eventsRoute,
          ...(tenantProfile.capabilities.eventPlanning ? [newEventRoute] : []),
          eventDetailRoute,
        ]
      : []),
    ...(tenantProfile.capabilities.workflowAnalytics ? [analyticsRoute] : []),
    adminRoute,
  ]),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

/** Read the shared search params from anywhere in the tree. */
export function useTasksSearch(): TasksSearch {
  return useSearch({ strict: false }) as TasksSearch;
}

/**
 * Builds a search reducer that merges a partial change and drops empty keys, so
 * a cleared filter leaves the URL rather than lingering as `?q=`.
 *
 * The cast is deliberate: TanStack derives an exact search type per route, and
 * under `exactOptionalPropertyTypes` a reducer that sets keys to `undefined` to
 * remove them cannot satisfy it. The runtime contract is correct.
 */
export function mergeSearch(patch: Partial<TasksSearch>) {
  return ((previous: Partial<TasksSearch>) => {
    const next = { ...previous, ...patch } as TasksSearch;
    for (const key of Object.keys(next) as (keyof TasksSearch)[]) {
      if (next[key] === undefined || next[key] === '') delete next[key];
    }
    return next;
  }) as never;
}

/** Merge a partial change into the search params without losing the rest. */
export function useUpdateSearch() {
  const navigate = useNavigate();
  return (patch: Partial<TasksSearch>) => {
    void navigate({ to: '.', search: mergeSearch(patch) });
  };
}
