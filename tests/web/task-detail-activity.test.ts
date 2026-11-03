// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskDetail } from '../../web/src/tasks/TaskDetail';

async function settle(until: () => boolean) {
  for (let pass = 0; pass < 50; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (until()) return;
  }
  throw new Error('Timed out waiting for task details to render.');
}

describe('task detail metadata and activity', () => {
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

  it('shows the immutable creator and a readable change history', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        const body = url.startsWith('/api/bootstrap')
          ? {
              authConfigured: true,
              permissions: ['tasks.view', 'tasks.manage', 'tasks.comment'],
              user: {
                id: 1,
                email: 'admin@example.org',
                first_name: 'Alex',
                last_name: 'Admin',
                photo_url: null,
                task_creation_mode: 'guided',
              },
            }
          : url.startsWith('/api/projects/IT/assignees')
            ? { assignees: [{ email: 'admin@example.org', name: 'Alex Admin' }] }
            : url.startsWith('/api/projects')
              ? {
                  projects: [
                    {
                      key: 'IT',
                      name: 'Technology',
                      description: '',
                      visibility: 'workspace',
                      type: 'shared',
                      workspace: { key: 'EX', name: 'Example Organization' },
                      role: 'owner',
                      canCreateTask: true,
                      canEditTasks: true,
                    },
                  ],
                }
              : url.startsWith('/api/tasks/TASK-1')
                ? {
                    task: {
                      key: 'TASK-1',
                      reference: 'T-1',
                      seq: 1,
                      title: 'Prepare the event slide',
                      description: 'Use the approved event copy.',
                      status: 'in_progress',
                      priority: 'high',
                      effort: 'small',
                      dueDate: '2026-09-03',
                      completedAt: null,
                      assignee: { name: 'Alex Admin', email: 'admin@example.org' },
                      creator: {
                        name: 'Sam Ortiz',
                        email: 'owner2@example.org',
                        photoUrl: null,
                      },
                      taskTypes: ['Creative'],
                      attachments: [],
                      project: {
                        key: 'IT',
                        name: 'Technology',
                        workspace: { key: 'EX', name: 'Example Organization' },
                      },
                      createdAt: '2026-08-30T14:00:00Z',
                      updatedAt: '2026-08-30T15:00:00Z',
                      version: 2,
                      canEdit: true,
                      canComment: true,
                      comments: [],
                      activity: [
                        {
                          id: 2,
                          action: 'updated',
                          changes: {
                            status: { before: 'not_started', after: 'in_progress' },
                            assigneeEmail: {
                              before: 'owner2@example.org',
                              after: 'admin@example.org',
                            },
                          },
                          createdAt: '2026-08-30T15:00:00Z',
                          actor: { name: 'Sam Ortiz', email: 'owner2@example.org' },
                        },
                        {
                          id: 1,
                          action: 'created',
                          changes: {},
                          createdAt: '2026-08-30T14:00:00Z',
                          actor: { name: 'Sam Ortiz', email: 'owner2@example.org' },
                        },
                      ],
                    },
                  }
                : {};
        return new Response(JSON.stringify(body), { status: 200 });
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(TaskDetail, { onClose: vi.fn(), taskKey: 'TASK-1' }),
        ),
      );
    });
    await settle(() => document.body.textContent?.includes('Created by') ?? false);

    expect(document.body.textContent).toContain('Sam Ortiz');
    expect(document.body.textContent).toContain('Activity2');
    expect(document.body.textContent).toContain('Not started');
    expect(document.body.textContent).toContain('In progress');
    expect(document.body.textContent).toContain('owner2@example.org');
    expect(document.body.textContent).toContain('admin@example.org');
  });
});
