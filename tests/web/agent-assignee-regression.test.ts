// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultRuntimeFeatures } from '../../shared/runtime-features';
import { tenantProfile } from '../../shared/tenant-profile';
import { keys } from '../../web/src/api/queries';
import type {
  Assignee,
  Bootstrap,
  Project,
  TaskDetail as TaskDetailData,
} from '../../web/src/api/types';
import { TaskCreateSheet } from '../../web/src/tasks/TaskCreateSheet';
import { TaskDetail } from '../../web/src/tasks/TaskDetail';

const agent = tenantProfile.agent satisfies Assignee;
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const project = {
  key: tenantProfile.defaultProjectKey,
  name: 'Technology',
  description: '',
  visibility: 'workspace',
  type: 'shared',
  workspace: { key: tenantProfile.workspaceKey, name: tenantProfile.organizationName },
  role: 'owner',
  canCreateTask: true,
  canEditTasks: true,
} satisfies Project;

const bootstrap = {
  authConfigured: true,
  features: defaultRuntimeFeatures,
  permissions: ['tasks.view', 'tasks.manage'],
  user: null,
} satisfies Bootstrap;

const task = {
  key: 'TASK-AGENT-REGRESSION',
  reference: 'T-1868',
  seq: 1868,
  title: 'Keep Agent assignable',
  description: '',
  status: 'not_started',
  priority: null,
  effort: null,
  dueDate: null,
  completedAt: null,
  assignee: null,
  creator: { name: 'Alex Admin', email: 'admin@example.org', photoUrl: null },
  taskTypes: [],
  attachments: [],
  project: {
    key: project.key,
    name: project.name,
    workspace: project.workspace,
  },
  createdAt: '2026-08-30T00:00:00Z',
  updatedAt: '2026-08-30T00:00:00Z',
  version: 1,
  comments: [],
  activity: [],
  canEdit: true,
  canComment: true,
} satisfies TaskDetailData;

const mountedRoots: Root[] = [];
const mountedContainers: HTMLElement[] = [];

function mount(element: ReactElement, queryClient: QueryClient) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, element));
  });
  mountedRoots.push(root);
  mountedContainers.push(container);
  return container;
}

function unmountLatest() {
  const root = mountedRoots.pop();
  if (root) act(() => root.unmount());
  mountedContainers.pop()?.remove();
}

async function settle(until: () => boolean) {
  for (let pass = 0; pass < 30; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (until()) return;
  }
  throw new Error('Timed out waiting for Agent assignee UI.');
}

function changeFormValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Form control value setter is unavailable.');
  setter.call(element, value);
  element.dispatchEvent(
    new Event(element instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true }),
  );
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  for (const container of mountedContainers.splice(0)) container.remove();
  vi.unstubAllGlobals();
});

describe('Agent assignee regression', () => {
  it('shows Agent in the create and detail assignment controls', async () => {
    const assignees = [agent];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/tasks' && init?.method === 'POST') {
        return new Response(JSON.stringify({ task: { ...task, assignee: agent } }), {
          status: 201,
        });
      }
      if (path === `/api/tasks/${task.key}` && init?.method === 'PATCH') {
        return new Response(JSON.stringify({ task: { ...task, assignee: agent, version: 2 } }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected Agent regression request: ${init?.method ?? 'GET'} ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const createClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    createClient.setQueryData(keys.assignees(project.key), assignees);
    mount(
      createElement(TaskCreateSheet, {
        initialProjectKey: project.key,
        onCreated: () => undefined,
        onOpenChange: () => undefined,
        open: true,
        projects: [project],
      }),
      createClient,
    );
    await settle(() => document.querySelector('.task-create-sheet') !== null);

    const assigneeLabel = [
      ...document.querySelectorAll<HTMLLabelElement>('.task-create-sheet label'),
    ].find((label) => label.querySelector('span')?.textContent === 'Assignee');
    const agentOption = assigneeLabel?.querySelector<HTMLOptionElement>(
      `option[value="${agent.email}"]`,
    );
    expect(agentOption?.textContent).toBe(agent.name);

    const titleInput = document.querySelector<HTMLInputElement>(
      '.task-create-sheet input[placeholder="What needs to be done?"]',
    );
    const assigneeSelect = assigneeLabel?.querySelector<HTMLSelectElement>('select');
    const createForm = document.querySelector<HTMLFormElement>('.task-create-sheet form');
    act(() => {
      if (titleInput) changeFormValue(titleInput, 'Assign creation to Agent');
      if (assigneeSelect) changeFormValue(assigneeSelect, agent.email);
    });
    await settle(
      () =>
        assigneeSelect?.value === agent.email &&
        document.querySelector<HTMLButtonElement>('.task-create-sheet button[type="submit"]')
          ?.disabled === false,
    );
    await act(async () => {
      createForm?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle(() =>
      fetchMock.mock.calls.some(
        ([input, init]) => String(input) === '/api/tasks' && init?.method === 'POST',
      ),
    );
    const createRequest = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === '/api/tasks' && init?.method === 'POST',
    )?.[1];
    expect(JSON.parse(String(createRequest?.body))).toMatchObject({
      title: 'Assign creation to Agent',
      assigneeEmail: agent.email,
    });
    unmountLatest();

    const detailClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    detailClient.setQueryData(keys.bootstrap, bootstrap);
    detailClient.setQueryData(keys.projects, [project]);
    detailClient.setQueryData(keys.task(task.key), task);
    detailClient.setQueryData(keys.assignees(project.key), assignees);
    mount(createElement(TaskDetail, { onClose: () => undefined, taskKey: task.key }), detailClient);
    await settle(() => document.querySelector('.detail-sheet') !== null);

    const assigneeTrigger = document.querySelector<HTMLButtonElement>(
      '.detail-sheet button[aria-label="Assignee"]',
    );
    expect(assigneeTrigger).not.toBeNull();
    await act(async () => assigneeTrigger?.click());
    await settle(() =>
      [...document.querySelectorAll<HTMLElement>('.menu-item-label')].some(
        (label) => label.textContent?.trim() === agent.name,
      ),
    );
    expect(
      [...document.querySelectorAll<HTMLElement>('.menu-item-label')].some(
        (label) => label.textContent?.trim() === agent.name,
      ),
    ).toBe(true);
    const agentMenuItem = [...document.querySelectorAll<HTMLElement>('.menu-item-label')]
      .find((label) => label.textContent?.trim() === agent.name)
      ?.closest<HTMLButtonElement>('button');
    await act(async () => agentMenuItem?.click());
    await settle(() =>
      fetchMock.mock.calls.some(
        ([input, init]) => String(input) === `/api/tasks/${task.key}` && init?.method === 'PATCH',
      ),
    );
    const patchRequest = fetchMock.mock.calls.find(
      ([input, init]) => String(input) === `/api/tasks/${task.key}` && init?.method === 'PATCH',
    )?.[1];
    expect(JSON.parse(String(patchRequest?.body))).toEqual({ assigneeEmail: agent.email });
  });
});
