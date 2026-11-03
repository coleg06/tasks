import { describe, expect, it } from 'vitest';
import type { TaskDomainCapabilities, TaskPrincipal, TaskRecord } from '../shared/task-domain';
import type {
  ResolvedIdentity,
  TaskBackend,
  TaskCreateInput,
  TaskDirectoryBackend,
  TaskListQuery,
  TaskMutationContext,
  TaskPatch,
  TaskReadBackend,
} from '../src/core/contracts';
import type { Env } from '../src/env';
import { createTaskServiceApi, enabledPrincipalKinds } from '../src/task-service/api';

const principal = {
  reference: 'user:7',
  kind: 'human',
  name: 'Test User',
  email: 'test@example.invalid',
} as const satisfies TaskPrincipal;

const identity = {
  principal,
  permissions: ['tasks.view'],
} as const satisfies ResolvedIdentity;

const writerIdentity = {
  principal,
  permissions: ['tasks.view', 'tasks.manage', 'tasks.comment'],
} as const satisfies ResolvedIdentity;

const task = {
  reference: { native: 'native:42', display: 'TASK-42', aliases: ['42'] },
  revision: '9',
  title: 'Portable service API',
  description: 'Uses the runtime-selected backend.',
  status: 'in_progress',
  priority: 'high',
  assignee: principal,
  createdBy: principal,
  dueDate: null,
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-08-31T00:00:00Z',
  updatedAt: '2026-08-31T01:00:00Z',
  projects: [
    {
      reference: 'project:hub',
      key: 'HUB',
      name: 'Hub',
      description: null,
    },
  ],
} as const satisfies TaskRecord;

function backend(onList?: (query: TaskListQuery) => void): TaskReadBackend {
  return {
    capabilities: {
      workflow: ['open', 'in_progress', 'done'],
      priorities: ['high', 'medium', 'low'],
      allowsUnprioritized: true,
      principalKinds: ['human', 'agent'],
      effort: false,
      taskTypes: false,
      tags: true,
      parentTasks: true,
      dependencies: false,
      sprints: false,
      projectCardinality: 'multiple',
      comments: true,
      history: true,
      optimisticConcurrency: true,
      durableIdempotency: true,
    },
    async resolveTaskReference(reference) {
      return ['42', 'TASK-42', task.reference.native].includes(reference)
        ? { outcome: 'resolved', reference: task.reference }
        : { outcome: 'not-found' };
    },
    async listTasks(query) {
      onList?.(query);
      return { tasks: [task], total: 1, nextCursor: null };
    },
    async getTask(reference, options) {
      if (reference !== task.reference.native) return null;
      return {
        task,
        access: { canEdit: false, canComment: true },
        ...(options.comments ? { comments: [] } : {}),
        ...(options.history ? { history: [] } : {}),
      };
    },
  };
}

function writeBackend(
  callbacks: {
    onCreate?: (input: TaskCreateInput, context: TaskMutationContext) => void;
    onUpdate?: (reference: string, patch: TaskPatch, context: TaskMutationContext) => void;
    onComment?: (reference: string, body: string, context: TaskMutationContext) => void;
  } = {},
  capabilityOverrides: Partial<TaskDomainCapabilities> = {},
): TaskBackend {
  const readBackend = backend();
  return {
    ...readBackend,
    capabilities: { ...readBackend.capabilities, ...capabilityOverrides },
    async createTask(input, context) {
      callbacks.onCreate?.(input, context);
      return {
        outcome: 'created',
        value: { task, access: { canEdit: true, canComment: true } },
        notificationIntents: [],
      };
    },
    async updateTask(reference, patch, context) {
      callbacks.onUpdate?.(reference, patch, context);
      return {
        outcome: 'updated',
        value: { task, access: { canEdit: true, canComment: true } },
        notificationIntents: [],
      };
    },
    async addComment(reference, body, context) {
      callbacks.onComment?.(reference, body, context);
      return {
        outcome: 'created',
        value: {
          comment: {
            reference: 'comment:1',
            revision: '1',
            body,
            author: principal,
            createdAt: '2026-08-31T02:00:00Z',
          },
          access: { canDelete: false },
        },
        notificationIntents: [],
      };
    },
    async deleteComment() {
      return { outcome: 'forbidden' };
    },
  };
}

const fakeEnv = {} as Env;

const directoryBackend: TaskDirectoryBackend = {
  async listTaskPrincipals(query) {
    return {
      values: [principal],
      total: 1,
      nextCursor: query.cursor ? null : 'principal-cursor',
    };
  },
  async listTaskProjects(query) {
    return {
      values: task.projects ?? [],
      total: 1,
      nextCursor: query.cursor ? null : 'project-cursor',
    };
  },
};

describe('versioned task-service API', () => {
  it('can remove Agent principals from a tenant directory', () => {
    expect(enabledPrincipalKinds(undefined, false)).toEqual(['human', 'system']);
    expect(enabledPrincipalKinds(['human', 'agent'], false)).toEqual(['human']);
    expect(enabledPrincipalKinds(['agent'], false)).toEqual([]);
    expect(enabledPrincipalKinds(['human', 'agent'], true)).toEqual(['human', 'agent']);
  });

  it('requires a runtime-resolved identity without assuming its provider', async () => {
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return null;
      },
      createTaskReadBackend: () => backend(),
    });

    const response = await api.request('/tasks', {}, fakeEnv);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('publishes the active backend capabilities behind authentication', async () => {
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return identity;
      },
      createTaskReadBackend: () => backend(),
    });

    const response = await api.request('/capabilities', {}, fakeEnv);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({
      apiVersion: 'task-service/v1',
      capabilities: { projectCardinality: 'multiple', tags: true },
      mutations: { create: false, update: false, comment: false },
    });
  });

  it('normalizes bounded filters and preserves opaque cursors and references', async () => {
    let received: TaskListQuery | undefined;
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return identity;
      },
      createTaskReadBackend: () => backend((query) => (received = query)),
    });

    const response = await api.request(
      '/tasks?status=open,in_progress&priority=high,none&assignee=unassigned&excludeAssigneeKind=agent&project=project%3Ahub&tag=api,shared&parent=none&cursor=opaque%3Anext&includeArchived=false&limit=40',
      {},
      fakeEnv,
    );
    expect(response.status).toBe(200);
    expect(received).toEqual({
      statuses: ['open', 'in_progress'],
      priorities: ['high', null],
      assignee: null,
      excludeAssigneeKinds: ['agent'],
      project: 'project:hub',
      tags: ['api', 'shared'],
      parent: null,
      cursor: 'opaque:next',
      includeArchived: false,
      limit: 40,
    });
    expect(await response.json()).toMatchObject({
      apiVersion: 'task-service/v1',
      total: 1,
      tasks: [{ reference: { native: 'native:42', display: 'TASK-42' } }],
    });
  });

  it('resolves the reserved My Tasks filter to the authenticated principal reference', async () => {
    let received: TaskListQuery | undefined;
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return identity;
      },
      createTaskReadBackend: () => backend((query) => (received = query)),
    });

    expect((await api.request('/tasks?assignee=me', {}, fakeEnv)).status).toBe(200);
    expect(received?.assignee).toBe(principal.reference);
  });

  it('rejects invalid filters before calling the backend', async () => {
    let calls = 0;
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return identity;
      },
      createTaskReadBackend: () => backend(() => (calls += 1)),
    });

    const response = await api.request('/tasks?status=unknown&limit=5000', {}, fakeEnv);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_query' });
    expect(calls).toBe(0);
  });

  it('resolves display aliases and loads optional comments and history', async () => {
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return identity;
      },
      createTaskReadBackend: () => backend(),
    });

    const response = await api.request('/tasks/TASK-42?comments=true&history=true', {}, fakeEnv);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      apiVersion: 'task-service/v1',
      access: { canEdit: false, canComment: true },
      comments: [],
      history: [],
      task: { title: 'Portable service API' },
    });
    const missing = await api.request('/tasks/unknown', {}, fakeEnv);
    expect(missing.status).toBe(404);
  });

  it('exposes bounded principal and project directories only when supplied by the tenant', async () => {
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return identity;
      },
      createTaskReadBackend: () => backend(),
      createTaskDirectoryBackend: () => directoryBackend,
    });

    const principals = await api.request('/principals?kind=human&limit=25', {}, fakeEnv);
    expect(principals.status).toBe(200);
    expect(await principals.json()).toMatchObject({
      apiVersion: 'task-service/v1',
      principals: [{ reference: 'user:7' }],
      total: 1,
      nextCursor: 'principal-cursor',
    });
    const projects = await api.request('/projects?limit=25', {}, fakeEnv);
    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({
      projects: [{ reference: 'project:hub', key: 'HUB' }],
      nextCursor: 'project-cursor',
    });
    expect((await api.request('/principals?kind=unknown', {}, fakeEnv)).status).toBe(400);
  });

  it('keeps mutations unavailable when a tenant supplies only the read seam', async () => {
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return writerIdentity;
      },
      createTaskReadBackend: () => backend(),
    });
    const response = await api.request('/tasks', { method: 'POST' }, fakeEnv);
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({ error: 'mutation_unsupported' });
  });

  it('passes bounded create input and authenticated audit context to the write seam', async () => {
    let received: { input: TaskCreateInput; context: TaskMutationContext } | undefined;
    const writable = writeBackend(
      {
        onCreate(input, context) {
          received = { input, context };
        },
      },
      { dependencies: true, sprints: true },
    );
    const api = createTaskServiceApi({
      async resolveIdentity(_context, permission) {
        expect(permission).toBe('tasks.manage');
        return writerIdentity;
      },
      createTaskReadBackend: () => writable,
      createTaskBackend: () => writable,
    });
    const response = await api.request(
      '/tasks',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'create-portable-1',
          'x-request-id': 'request-portable-1',
        },
        body: JSON.stringify({
          title: 'Portable mutation',
          description: null,
          status: 'open',
          priority: 'high',
          assignee: 'principal:2',
          projects: ['project:hub'],
          dependencies: [{ task: 'native:41', kind: 'blocks' }],
          sprints: [{ reference: 'sprint:10', role: 'carryover' }],
        }),
      },
      fakeEnv,
    );
    expect(response.status).toBe(201);
    expect(received?.input).toMatchObject({
      title: 'Portable mutation',
      dependencies: [{ task: { native: 'native:41' }, kind: 'blocks', direction: 'outbound' }],
      sprints: [{ reference: 'sprint:10', role: 'carryover' }],
    });
    expect(received?.context).toMatchObject({
      identity: writerIdentity,
      auditPrincipal: principal,
      idempotencyKey: 'create-portable-1',
      requestId: 'request-portable-1',
    });
  });

  it.each(['tags', 'dependencies'] as const)(
    'preserves the 32-entry %s boundary for portable mutations',
    async (field) => {
      let mutationCalls = 0;
      const writable = writeBackend(
        {
          onCreate: () => mutationCalls++,
          onUpdate: () => mutationCalls++,
        },
        { dependencies: true },
      );
      const api = createTaskServiceApi({
        async resolveIdentity() {
          return writerIdentity;
        },
        createTaskReadBackend: () => writable,
        createTaskBackend: () => writable,
      });
      const values = Array.from({ length: 32 }, (_, index) =>
        field === 'tags' ? `tag-${index}` : { task: `native:${index}`, kind: 'blocks' },
      );
      for (const method of ['POST', 'PATCH']) {
        for (const oversized of [false, true]) {
          const response = await api.request(
            method === 'POST' ? '/tasks' : '/tasks/TASK-42',
            {
              method,
              headers: {
                'content-type': 'application/json',
                'idempotency-key': `collection-${field}-${method}-${oversized}`,
                'X-Task-Revision': '9',
              },
              body: JSON.stringify({
                ...(method === 'POST'
                  ? {
                      title: 'Collection boundary',
                      description: null,
                      status: 'open',
                      priority: null,
                    }
                  : {}),
                [field]: oversized ? [...values, values[0]] : values,
              }),
            },
            fakeEnv,
          );
          expect(response.status).toBe(oversized ? 400 : method === 'POST' ? 201 : 200);
          if (oversized) expect(await response.json()).toEqual({ error: 'invalid_task' });
        }
      }
      expect(mutationCalls).toBe(2);
    },
  );

  it('rejects mutation fields that the active backend cannot represent', async () => {
    let createCalls = 0;
    const writable = writeBackend({
      onCreate() {
        createCalls += 1;
      },
    });
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return writerIdentity;
      },
      createTaskReadBackend: () => writable,
      createTaskBackend: () => writable,
    });

    const response = await api.request(
      '/tasks',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'unsupported-1' },
        body: JSON.stringify({
          title: 'Unsupported effort',
          description: null,
          status: 'open',
          priority: 'high',
          effort: 'medium',
        }),
      },
      fakeEnv,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unsupported_feature', feature: 'effort' });
    expect(createCalls).toBe(0);
  });

  it('requires opaque revision and idempotency evidence for updates and comments', async () => {
    const observations: Array<Record<string, unknown>> = [];
    const writable = writeBackend({
      onUpdate(reference, patch, context) {
        observations.push({ reference, patch, context });
      },
      onComment(reference, body, context) {
        observations.push({ reference, body, context });
      },
    });
    const api = createTaskServiceApi({
      async resolveIdentity() {
        return writerIdentity;
      },
      createTaskReadBackend: () => writable,
      createTaskBackend: () => writable,
    });

    const missingRevision = await api.request(
      '/tasks/TASK-42',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'update-1' },
        body: JSON.stringify({ status: 'done' }),
      },
      fakeEnv,
    );
    expect(missingRevision.status).toBe(428);

    const updated = await api.request(
      '/tasks/TASK-42',
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'update-1',
          'x-task-revision': 'opaque:revision:9',
        },
        body: JSON.stringify({ status: 'done', archived: false }),
      },
      fakeEnv,
    );
    expect(updated.status).toBe(200);
    expect(observations[0]).toMatchObject({
      reference: 'native:42',
      patch: { status: 'done', archived: false },
      context: { expectedRevision: 'opaque:revision:9', idempotencyKey: 'update-1' },
    });

    const commented = await api.request(
      '/tasks/42/comments',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'comment-1' },
        body: JSON.stringify({ body: 'Portable comment' }),
      },
      fakeEnv,
    );
    expect(commented.status).toBe(201);
    expect(observations[1]).toMatchObject({
      reference: 'native:42',
      body: 'Portable comment',
      context: { idempotencyKey: 'comment-1' },
    });
  });
});
