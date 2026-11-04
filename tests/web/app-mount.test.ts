// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { tenantEventVocabulary } from '../../shared/tenant-profile-support';
import { TASKS_RELEASE_VERSION } from '../../shared/version';
import { router } from '../../web/src/router';

/**
 * Mounts the real provider stack and route tree. Typecheck and bundling both
 * pass on an app that throws on first render, so this is the check that the
 * page is not blank.
 */
function mount(container: HTMLElement): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
      ),
    );
  });
  return root;
}

/**
 * Flushes until the DOM satisfies `until`, rather than a fixed number of
 * passes. Mounting takes at least two — one to resolve the router's initial
 * match, one for the queries that match kicks off — but a loaded CI runner
 * needs more, and a fixed count turns that into a flake.
 */
async function settle(until?: () => boolean) {
  for (let pass = 0; pass < 50; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (until?.()) return;
  }
  if (until && !until()) {
    throw new Error(
      `Timed out waiting for the app to settle: ${document.body.textContent?.slice(0, 600)}`,
    );
  }
}

describe('application mount', () => {
  let container: HTMLElement;
  let root: Root | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('renders the sign-in prompt when there is no session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })),
    );

    root = mount(container);
    await settle(() => container.textContent?.includes('Continue with Google') ?? false);

    expect(container.textContent).toContain('Continue with Google');
    expect(container.querySelector('a[href^="/auth/login?returnTo="]')).not.toBeNull();
  });

  it('shows a retryable task-service error instead of an empty list', async () => {
    let taskAttempts = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/bootstrap')) {
          return Response.json({
            authConfigured: true,
            permissions: ['tasks.view'],
            user: {
              id: 1,
              email: 'admin@example.org',
              first_name: 'Alex',
              last_name: 'Admin',
              photo_url: null,
              task_creation_mode: 'guided',
            },
          });
        }
        if (url.startsWith('/api/projects')) return Response.json({ projects: [] });
        if (url.startsWith('/api/tasks')) {
          taskAttempts += 1;
          return Response.json({ error: 'request_failed' }, { status: 500 });
        }
        return Response.json({});
      }),
    );

    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/', search: { view: 'open' } });
    });
    await settle(() => container.textContent?.includes('Unable to load tasks') ?? false);

    expect(container.textContent).not.toContain('No tasks here');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Try again'))
        ?.click();
    });
    await settle(() => taskAttempts >= 2);
    expect(taskAttempts).toBe(2);
  });

  it('renders the shell and a task row for a signed-in user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith('/api/bootstrap')
          ? {
              authConfigured: true,
              permissions: ['tasks.view', 'tasks.manage'],
              release: '638b9a6f0e1d2c3b4a5968778695a4b3c2d1e0f9',
              user: {
                id: 1,
                email: 'admin@example.org',
                first_name: 'Alex',
                last_name: 'Admin',
                photo_url: null,
                task_creation_mode: 'guided',
              },
            }
          : url.startsWith('/api/projects')
            ? {
                projects: [
                  {
                    key: 'IT',
                    name: 'Technology',
                    description: '',
                    visibility: 'workspace',
                    workspace: { key: 'EX', name: 'Example Organization' },
                    role: 'owner',
                  },
                ],
              }
            : url.startsWith('/api/tasks')
              ? {
                  tasks: [
                    {
                      key: 'TASK-1',
                      reference: 'T-1',
                      seq: 1,
                      title: 'Replace the conference room projector lamp',
                      description: '',
                      status: 'in_progress',
                      priority: 'high',
                      effort: null,
                      dueDate: null,
                      completedAt: null,
                      assignee: { name: 'Alex Admin', email: 'admin@example.org' },
                      taskTypes: [],
                      attachments: [],
                      project: {
                        key: 'IT',
                        name: 'Technology',
                        workspace: { key: 'EX', name: 'Example Organization' },
                      },
                      createdAt: '2026-08-16T00:00:00Z',
                      updatedAt: '2026-08-17T00:00:00Z',
                    },
                  ],
                }
              : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );
    const fetchMock = vi.mocked(fetch);

    root = mount(container);
    // Skeleton placeholders also carry .task-row, so wait for real content.
    await settle(() => container.querySelector('.task-row:not(.is-skeleton)') !== null);

    expect(container.textContent).toContain('Replace the conference room projector lamp');
    expect(container.querySelector('.tasks-sidebar')).not.toBeNull();
    expect(document.querySelector('.account-version')).toBeNull();
    const sidebarNavigation = container.querySelector<HTMLElement>('.tasks-sidebar-top');
    expect(sidebarNavigation?.classList.contains('is-scrolling')).toBe(false);
    await act(async () => sidebarNavigation?.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(sidebarNavigation?.classList.contains('is-scrolling')).toBe(true);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 750)));
    expect(sidebarNavigation?.classList.contains('is-scrolling')).toBe(false);
    expect(container.querySelector('.task-row')).not.toBeNull();
    const statusHint = container.querySelector<HTMLElement>('.task-row-status.status-hint');
    expect(statusHint?.dataset.statusLabel).toBe('In progress');
    expect(statusHint?.dataset.statusDescription).toBe('Work is actively underway.');
    const assigneeHint = container.querySelector<HTMLElement>('.task-row-assignee .avatar');
    expect(assigneeHint?.dataset.hintLabel).toBe('Alex Admin');
    expect(assigneeHint?.dataset.hintDescription).toBe('admin@example.org');
    expect(container.querySelector<HTMLElement>('.task-row-project')?.dataset.hintDescription).toBe(
      'Project in Example Organization',
    );
    expect(container.querySelector<HTMLElement>('.task-row-due')?.dataset.hintLabel).toBe(
      'No due date',
    );
    expect(container.querySelector<HTMLElement>('.task-row-priority')?.dataset.hintLabel).toBe(
      'High priority',
    );
    const hideAgentToggle = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Hide Agent tasks'),
    );
    expect(hideAgentToggle?.getAttribute('aria-pressed')).toBe('false');
    await act(async () => hideAgentToggle?.click());
    await settle(() =>
      fetchMock.mock.calls.some(([input]) => String(input).includes('hideAgent=1')),
    );
    expect(hideAgentToggle?.getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      await router.navigate({
        to: '/',
        search: { view: 'open', project: 'IT' },
      });
    });
    await settle(() => container.textContent?.includes('Project settings') ?? false);
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('Project settings'))
        ?.click();
    });
    await settle(() => document.body.textContent?.includes('Save project details') ?? false);
    expect(document.body.textContent).toContain('Add or update member');
    expect(document.querySelector<HTMLInputElement>('#project-settings-name')?.value).toBe(
      'Technology',
    );
    expect(document.querySelector('#project-settings-description')).not.toBeNull();
    expect(document.querySelector('#project-settings-visibility')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(() => !document.body.textContent?.includes('Save project details'));
    await act(async () => {
      await router.navigate({ to: '/', search: { view: 'open' } });
    });

    // Account actions live behind the account row now, so they are absent
    // until it is opened — and Radix portals the menu to document.body.
    const portalSelector = `a[href="${tenantProfile.links.portal}"]`;
    const hasPortalLink = tenantProfile.capabilities.portal;
    expect(document.querySelector(portalSelector)).toBeNull();
    const account = container.querySelector<HTMLElement>('.account-trigger');
    expect(account?.textContent).toContain('admin@example.org');

    await act(async () => {
      account?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      account?.click();
    });
    if (hasPortalLink) {
      await settle(() => document.querySelector(portalSelector) !== null);
      expect(document.querySelector(portalSelector)?.textContent).toContain('Back to Portal');
    } else {
      await settle(() => document.querySelector('form[action="/auth/logout"]') !== null);
      expect(document.querySelector(portalSelector)).toBeNull();
    }
    expect(document.querySelector('form[action="/auth/logout"]')).not.toBeNull();

    await settle(() => document.querySelector('.account-menu .account-version') !== null);
    const versionLine = document.querySelector<HTMLElement>('.account-menu .account-version');
    expect(versionLine?.textContent).toBe(
      `${tenantProfile.productName} ${TASKS_RELEASE_VERSION} · 638b9a6`,
    );
    expect(versionLine?.title).toContain('638b9a6f0e1d2c3b4a5968778695a4b3c2d1e0f9');

    // Radix portals to document.body and locks interaction outside the menu;
    // leaving it open would follow this test into the next one.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle(() => document.querySelector(portalSelector) === null);
    // The list must not be letterboxed — the original complaint.
    expect(container.querySelector('[style*="max-width"]')).toBeNull();
  });

  it('opens the guided task sheet by default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith('/api/bootstrap')
          ? {
              authConfigured: true,
              permissions: ['tasks.view', 'tasks.manage'],
              user: {
                id: 1,
                email: 'admin@example.org',
                first_name: 'Alex',
                last_name: 'Admin',
                photo_url: null,
                task_creation_mode: 'guided',
              },
            }
          : url.includes('/assignees')
            ? { assignees: [{ email: 'admin@example.org', name: 'Alex Admin' }] }
            : url.startsWith('/api/projects')
              ? {
                  projects: [
                    {
                      key: 'IT',
                      name: 'Technology',
                      description: '',
                      visibility: 'workspace',
                      workspace: { key: 'EX', name: 'Example Organization' },
                      role: 'owner',
                    },
                  ],
                }
              : url.startsWith('/api/tasks')
                ? { tasks: [] }
                : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/', search: { view: 'open' } });
    });
    await settle(() => container.textContent?.includes('New task') ?? false);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('New task'))
        ?.click();
    });
    await settle(() => document.querySelector('.task-create-sheet') !== null);

    expect(document.querySelector('.task-create-sheet')).not.toBeNull();
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="What needs to be done?"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('Capture the owner, timing, and importance');
  });

  it('keeps the one-line composer for accounts using Quick add', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith('/api/bootstrap')
          ? {
              authConfigured: true,
              permissions: ['tasks.view', 'tasks.manage'],
              user: {
                id: 1,
                email: 'admin@example.org',
                first_name: 'Alex',
                last_name: 'Admin',
                photo_url: null,
                task_creation_mode: 'quick',
              },
            }
          : url.includes('/assignees')
            ? { assignees: [] }
            : url.startsWith('/api/projects')
              ? {
                  projects: [
                    {
                      key: 'IT',
                      name: 'Technology',
                      description: '',
                      visibility: 'workspace',
                      workspace: { key: 'EX', name: 'Example Organization' },
                      role: 'owner',
                    },
                  ],
                }
              : url.startsWith('/api/tasks')
                ? { tasks: [] }
                : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/', search: { view: 'open' } });
    });
    await settle(() => container.textContent?.includes('New task') ?? false);

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent?.includes('New task'))
        ?.click();
    });
    await settle(() => container.querySelector('.task-composer') !== null);

    expect(container.querySelector('.task-composer')).not.toBeNull();
    expect(document.querySelector('.task-create-sheet')).toBeNull();
  });

  it('renders the separate event workspace without replacing the task list', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/bootstrap')
        ? {
            authConfigured: true,
            permissions: ['events.view', 'events.create'],
            user: {
              id: 1,
              email: 'admin@example.org',
              first_name: 'Alex',
              last_name: 'Admin',
              photo_url: null,
            },
          }
        : url.startsWith('/api/projects')
          ? { projects: [] }
          : url.startsWith('/api/events')
            ? {
                events: [
                  {
                    key: 'EVT-DEMO',
                    reference: 'E-1',
                    title: 'Spring picnic',
                    purpose: 'Celebrate community stories.',
                    ministry: 'All Sites',
                    startAt: '2026-10-18T16:00:00',
                    endAt: '2026-10-18T19:00:00',
                    timezone: 'UTC',
                    location: 'North Hall',
                    stage: 'planning',
                    readiness: 'blocked',
                    progress: 28,
                    blockers: 12,
                    owner: { name: 'Alex Admin', email: 'admin@example.org' },
                    template: { key: 'standard', name: 'Standard event' },
                    source: null,
                    updatedAt: '2026-08-18T00:00:00Z',
                  },
                ],
              }
            : {};
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/events', search: { view: 'open' } });
    });
    await settle(() => container.textContent?.includes('Spring picnic') ?? false);

    expect(container.textContent).toContain('Events & promotion');
    expect(container.textContent).toContain('All stages');
    expect(container.textContent).toContain('Scheduled / live');
    expect(container.textContent).toContain('Spring picnic');
    expect(container.querySelector('.events-stats')).toBeNull();
    expect(container.querySelector('.tasks-sidebar')).not.toBeNull();
    expect(container.querySelector('.tasks-list')).toBeNull();
    expect(container.querySelector('nav[aria-label="Task views"]')).toBeNull();
    expect(container.textContent).not.toContain('All projects');

    const stageFilter = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Filter by stage"]',
    );
    act(() => {
      if (!stageFilter) return;
      stageFilter.value = 'approval';
      stageFilter.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle(() =>
      fetchMock.mock.calls.some(([input]) => String(input).includes('stage=approval')),
    );
    expect(stageFilter?.value).toBe('approval');
  });

  it('renders the simplified event request with conditional creative and facility details', async () => {
    class IntersectionObserverStub {
      disconnect() {
        return undefined;
      }

      observe() {
        return undefined;
      }

      takeRecords() {
        return [];
      }

      unobserve() {
        return undefined;
      }
    }

    vi.stubGlobal('IntersectionObserver', IntersectionObserverStub);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.startsWith('/api/bootstrap')
        ? {
            authConfigured: true,
            permissions: ['events.view', 'events.create'],
            user: {
              id: 1,
              email: 'admin@example.org',
              first_name: 'Alex',
              last_name: 'Admin',
              photo_url: 'https://lh3.googleusercontent.com/example',
            },
          }
        : url.startsWith('/api/event-options')
          ? {
              ministries: ['Operations', 'Outreach', 'Education'],
              staff: [
                {
                  id: 1,
                  email: 'admin@example.org',
                  name: 'Alex Admin',
                  photoUrl: 'https://lh3.googleusercontent.com/example',
                },
              ],
            }
          : {};
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/events/new', search: { view: 'open' } });
    });
    await settle(() => container.textContent?.includes('Event Request Form') ?? false);

    expect(container.textContent).toContain('This event has been approved');
    expect(container.textContent).toContain('Leave it unchecked while approval is pending');
    expect(container.textContent).toContain('What is this event?');
    expect(container.textContent).toContain('What creative things do you need?');
    expect(container.textContent).toContain('Facilities and special requests');
    expect(container.textContent).toContain('Review and send');
    expect(container.textContent).toContain(
      '16:9 announcement slide that can run in the scrolling announcements.',
    );
    expect(container.textContent).toContain('Event Photography');
    expect(container.textContent).toContain('Photography coverage during the event.');
    expect(container.textContent).not.toContain('These details stay connected to every task');
    expect(container.textContent).not.toContain('human-designed');
    expect(container.querySelectorAll('.event-request-stage.is-revealed')).toHaveLength(1);
    expect(container.querySelectorAll('.event-request-stage.is-pending')).toHaveLength(2);
    expect(container.querySelector('.event-request-final-stage.is-pending')).not.toBeNull();
    expect(container.textContent).toContain('Event owner');
    expect(container.textContent).toContain(
      `Coordinating ${tenantEventVocabulary(tenantProfile).ministryLabel.toLowerCase()}`,
    );
    expect(container.textContent).toContain(
      `Has ${tenantProfile.organizationName} done this before?`,
    );
    expect(container.textContent).not.toContain('Campus / destination');
    expect(container.textContent).not.toContain('Marketing & communication tier');
    expect(container.textContent).not.toContain('Build my draft');
    expect(container.textContent).not.toContain('Review the generated plan');
    expect(container.textContent).not.toContain('Step 1 of');
    expect(container.textContent).not.toContain('Interpretation');

    await act(async () => {
      container
        .querySelector<HTMLInputElement>('input[aria-label="Registration required"]')
        ?.click();
    });
    expect(container.textContent).toContain('Sign-up deadline');
    expect(container.textContent).toContain('Scholarship or fundraising is available');
    expect(container.textContent).toContain('Additional sign-up fields');
    expect(container.textContent).toContain('Liability waiver');

    await act(async () => {
      const facilitiesLabel = [...container.querySelectorAll<HTMLLabelElement>('label')].find(
        (label) => label.textContent?.includes('Rooms, setup, or building resources'),
      );
      facilitiesLabel?.querySelector<HTMLInputElement>('input')?.click();
    });
    expect(container.textContent).toContain('Rooms and spaces');
    expect(container.textContent).toContain(tenantEventVocabulary(tenantProfile).rooms[0] ?? '');
    expect(container.textContent).toContain('Building resources');

    await act(async () => {
      const productionLabel = [...container.querySelectorAll<HTMLLabelElement>('label')].find(
        (label) => label.textContent?.includes('Technology or production'),
      );
      productionLabel?.querySelector<HTMLInputElement>('input')?.click();
    });
    const technologyResources = [...container.querySelectorAll('fieldset')].find(
      (fieldset) => fieldset.querySelector('legend')?.textContent === 'Technology resources',
    );
    expect(technologyResources?.textContent).not.toContain('Photography');

    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/events/intake-assist')),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/events/plan-preview')),
    ).toBe(false);
  });

  it('shows assigned event-project work in the existing My Tasks list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith('/api/bootstrap')
          ? {
              authConfigured: true,
              permissions: ['tasks.view', 'tasks.manage', 'events.view'],
              user: {
                id: 1,
                email: 'admin@example.org',
                first_name: 'Alex',
                last_name: 'Admin',
                photo_url: null,
              },
            }
          : url.startsWith('/api/projects')
            ? { projects: [] }
            : url.startsWith('/api/event-work-items')
              ? {
                  workItems: [
                    {
                      work_item_key: 'EWI-1',
                      phase: 'copy',
                      title: 'Write source promotional copy',
                      description: '',
                      status: 'not_started',
                      due_at: '2026-09-01',
                      critical: 1,
                      updated_at: '2026-08-18T00:00:00Z',
                      event_key: 'EVT-1',
                      eventReference: 'E-1',
                      event_title: 'Community Picnic',
                      ministry: 'North',
                      stage: 'planning',
                      owner_name: 'Alex Admin',
                      owner_email: 'admin@example.org',
                      owner_photo_url: null,
                      dependency_blockers: 0,
                    },
                  ],
                }
              : url.startsWith('/api/tasks')
                ? { tasks: [] }
                : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/', search: { view: 'mine' } });
    });
    await settle(() => container.textContent?.includes('Write source promotional copy') ?? false);

    expect(container.textContent).toContain('Event projects');
    expect(container.textContent).toContain('E-1 · Community Picnic');
    expect(container.querySelector('.tasks-search')).not.toBeNull();
    expect(container.querySelector('a[href^="/events/EVT-1"]')).not.toBeNull();
    const eventStatusHint = container.querySelector<HTMLElement>('.event-task-status.status-hint');
    expect(eventStatusHint?.dataset.statusLabel).toBe('Not started');
    expect(eventStatusHint?.dataset.statusDescription).toBe('Ready, but work has not started.');
    expect(
      container.querySelector<HTMLElement>('.event-task-row .avatar')?.dataset.hintDescription,
    ).toBe('admin@example.org');
  });

  it('renders lifecycle and revision analytics for managers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith('/api/bootstrap')
          ? {
              authConfigured: true,
              permissions: ['tasks.view', 'tasks.manage', 'events.view', 'events.manage'],
              user: {
                id: 1,
                email: 'admin@example.org',
                first_name: 'Alex',
                last_name: 'Admin',
                photo_url: null,
              },
            }
          : url.startsWith('/api/analytics/workflows')
            ? {
                periodDays: 90,
                trackingStartedAt: '2026-08-18T00:00:00Z',
                metrics: {
                  eventLeadTime: { averageHours: 240, medianHours: 240, sampleSize: 2 },
                  eventTaskLeadTime: { averageHours: 36, medianHours: 32, sampleSize: 12 },
                  standardTaskLeadTime: { averageHours: 48, medianHours: 40, sampleSize: 8 },
                  deliverableApprovalTime: { averageHours: 72, medianHours: 60, sampleSize: 6 },
                  averageAssetVersions: 1.8,
                  revisionRate: 50,
                },
                phases: [{ phase: 'design', averageHours: 48, medianHours: 44, sampleSize: 4 }],
                stages: [{ stage: 'planning', count: 3 }],
                recentEvents: [
                  {
                    key: 'EVT-1',
                    reference: 'E-1',
                    title: 'Community Picnic',
                    completedAt: '2026-08-18T00:00:00Z',
                    elapsedHours: 240,
                  },
                ],
              }
            : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/analytics', search: { view: 'open' } });
    });
    // Wait for rendered data, not the static heading: "Workflow analytics" is
    // in the page header and is present while the metrics are still loading.
    await settle(() => container.textContent?.includes('Event request to ready') ?? false);

    expect(container.textContent).toContain('Event request to ready');
    expect(container.textContent).toContain('10 days');
    expect(container.textContent).toContain('1.8 versions per deliverable');
    expect(container.textContent).toContain('Community Picnic');
  });

  it.runIf(
    tenantProfile.capabilities.emailNotifications || tenantProfile.capabilities.portalAlerts,
  )('shows notification delivery health to administrators', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith('/api/bootstrap')
          ? {
              authConfigured: true,
              permissions: ['tasks.view', 'tasks.manage', 'platform.admin'],
              user: {
                id: 1,
                email: 'admin@example.org',
                first_name: 'Alex',
                last_name: 'Admin',
                photo_url: null,
              },
            }
          : url.startsWith('/api/admin?')
            ? {
                stats: { users: 2, projects: 1, tasks: 12, comments: 3 },
                users: [],
                projects: [],
                events: [],
                notificationHealth: {
                  environment: 'production',
                  emailConfigured: true,
                  portalAlertsConfigured: false,
                  email: {
                    accepted24h: 4,
                    failed24h: 1,
                    unresolvedFailed: 1,
                    stalledPending: 0,
                    lastAcceptedAt: '2026-08-28T13:00:00Z',
                    lastFailedAt: '2026-08-28T12:00:00Z',
                  },
                  portalAlerts: {
                    delivered24h: 0,
                    readyToRetry: 0,
                    stalledProcessing: 0,
                    deadLetter: 0,
                    lastDeliveredAt: null,
                  },
                  recentEmailDeliveries: [
                    {
                      id: 10,
                      kind: 'deadline',
                      entityType: 'deadline_digest',
                      entityKey: '2026-08-28',
                      status: 'accepted',
                      errorCode: null,
                      requestId: 'tasks-request',
                      createdAt: '2026-08-28T13:00:00Z',
                      updatedAt: '2026-08-28T13:00:01Z',
                      recipient: { name: 'Alex Admin', email: 'admin@example.org' },
                    },
                  ],
                },
                operationalHealth: {
                  errors24h: 1,
                  warnings24h: 0,
                  lastEventAt: '2026-08-28T13:05:00Z',
                  recentEvents: [
                    {
                      id: 4,
                      severity: 'error',
                      event: 'ui.render_error',
                      source: 'browser',
                      requestId: 'request-123',
                      method: 'CLIENT',
                      path: '/events/EVT-1',
                      statusCode: null,
                      message: 'Event workspace failed to render',
                      details: { errorName: 'TypeError' },
                      createdAt: '2026-08-28T13:05:00Z',
                      actor: { name: 'Alex Admin', email: 'admin@example.org' },
                    },
                  ],
                },
              }
            : url.startsWith('/api/projects')
              ? { projects: [] }
              : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    // Delivery health lives on the Overview tab of the administration page.
    root = mount(container);
    await act(async () => {
      await router.navigate({ to: '/admin', search: { view: 'open' } });
    });
    await settle(() => container.querySelector('[role="tab"]') !== null);
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'))
        .find((tab) => tab.textContent === 'Overview')
        ?.click();
    });
    await settle(() => container.textContent?.includes('Notification delivery') ?? false);

    expect(container.textContent).toContain('Email accepted');
    expect(container.textContent).toContain('1 need attention');
    expect(container.textContent).toContain('deadline digest');
    expect(container.textContent).toContain('admin@example.org');
    expect(container.textContent).toContain('Email enabled · Portal disabled');
    expect(container.textContent).toContain('Operational logs');
    expect(container.textContent).toContain('Event workspace failed to render');
    expect(container.textContent).toContain('Request request-123');
    window.history.replaceState(null, '', '#');
  });
});
