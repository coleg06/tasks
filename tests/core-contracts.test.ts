import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type JsonValue,
  TASK_PRINCIPAL_KINDS,
  type TaskComment,
  type TaskNotificationIntent,
  type TaskPrincipal,
  type TaskRecord,
} from '../shared/task-domain';
import type {
  AssetProvider,
  CreateMutationOutcome,
  IdempotencyBeginResult,
  IdempotencyClaim,
  IdempotencyStore,
  IdentityProvider,
  NotificationProvider,
  ReadinessCheck,
  ReadinessProvider,
  ResolvedIdentity,
  TaskBackend,
  TaskMutationContext,
  TaskProjectView,
  TaskReadResult,
  TaskWorkspaceBackend,
  UpdateMutationOutcome,
} from '../src/core/contracts';

const agent = {
  reference: 'agent:tasks',
  kind: 'agent',
  name: 'Agent',
  email: null,
} as const satisfies TaskPrincipal;

const identity = {
  principal: agent,
  permissions: ['tasks.view', 'tasks.manage'],
} as const satisfies ResolvedIdentity;

const task = {
  reference: { native: 'task:1', display: 'TASK-1', aliases: ['1'] },
  revision: '7',
  title: 'Portable contract fixture',
  description: null,
  status: 'in_progress',
  priority: 'high',
  assignee: agent,
  createdBy: agent,
  dueDate: null,
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-08-30T12:00:00Z',
  updatedAt: '2026-08-30T13:00:00Z',
} as const satisfies TaskRecord;

const comment = {
  reference: 'comment:1',
  revision: '1',
  body: 'Progress recorded.',
  author: agent,
  createdAt: '2026-08-30T13:00:00Z',
} as const satisfies TaskComment;

const taskResult = {
  task,
  access: { canEdit: true, canComment: true },
  comments: [{ comment, access: { canDelete: true } }],
  history: [],
} as const satisfies TaskReadResult;

const notificationIntent = {
  reference: 'outbox:1',
  deduplicationKey: 'deadline:task:1:v7:agent:tasks',
  kind: 'deadline',
  task: task.reference,
  taskRevision: task.revision,
  recipient: agent,
  actor: null,
  occurredAt: '2026-08-30T14:00:00Z',
  dueDate: '2026-08-31',
} as const satisfies TaskNotificationIntent;

const mutationContext = {
  identity,
  auditPrincipal: agent,
  requestId: 'request:1',
  expectedRevision: task.revision,
} as const satisfies TaskMutationContext;

describe('portable core contracts', () => {
  it('lets an identity adapter choose transport-neutral evidence', async () => {
    type Evidence = { readonly session: string };
    const provider: IdentityProvider<Evidence> = {
      async resolve(input) {
        return input.session === 'valid' ? identity : null;
      },
    };

    await expect(provider.resolve({ session: 'valid' })).resolves.toEqual(identity);
    await expect(provider.resolve({ session: 'invalid' })).resolves.toBeNull();
  });

  it('keeps audit and request attribution required while idempotency remains opt-in', () => {
    expect(mutationContext.auditPrincipal.kind).toBe('agent');
    expect(mutationContext.requestId).toBe('request:1');
    expect(mutationContext).not.toHaveProperty('idempotencyKey');

    const idempotentContext = {
      ...mutationContext,
      idempotencyKey: 'task-update:request-1',
    } satisfies TaskMutationContext;
    expect(idempotentContext.idempotencyKey).toBe('task-update:request-1');
  });

  it('defines reference resolution, access decisions, comment deletion, and explicit outcomes', async () => {
    const backend: TaskBackend = {
      capabilities: {
        workflow: ['open', 'in_progress', 'blocked', 'review', 'done', 'cancelled'],
        priorities: ['critical', 'high', 'medium', 'low'],
        allowsUnprioritized: false,
        principalKinds: TASK_PRINCIPAL_KINDS,
        effort: false,
        taskTypes: false,
        tags: true,
        parentTasks: true,
        dependencies: true,
        sprints: true,
        projectCardinality: 'multiple',
        comments: true,
        history: true,
        optimisticConcurrency: true,
        durableIdempotency: true,
      },
      async resolveTaskReference(reference) {
        return reference === 'TASK-1'
          ? { outcome: 'resolved', reference: task.reference }
          : { outcome: 'not-found' };
      },
      async listTasks() {
        return { tasks: [task], total: 1 };
      },
      async getTask() {
        return taskResult;
      },
      async createTask() {
        return { outcome: 'created', value: taskResult, notificationIntents: [] };
      },
      async updateTask(_reference, _patch, context) {
        return context.expectedRevision === task.revision
          ? { outcome: 'unchanged', value: taskResult, notificationIntents: [] }
          : { outcome: 'conflict', current: taskResult };
      },
      async addComment() {
        return {
          outcome: 'created',
          value: { comment, access: { canDelete: true } },
          notificationIntents: [],
        };
      },
      async deleteComment() {
        return { outcome: 'deleted', value: 'comment:1', notificationIntents: [] };
      },
    };

    await expect(backend.resolveTaskReference('TASK-1', { identity })).resolves.toMatchObject({
      outcome: 'resolved',
    });
    expect((await backend.getTask('task:1', { comments: true }, { identity }))?.access).toEqual({
      canEdit: true,
      canComment: true,
    });
    expect(taskResult.comments?.[0]?.access.canDelete).toBe(true);
    await expect(backend.updateTask('task:1', {}, mutationContext)).resolves.toMatchObject({
      outcome: 'unchanged',
    });
    await expect(
      backend.updateTask('task:1', {}, { ...mutationContext, expectedRevision: '6' }),
    ).resolves.toMatchObject({ outcome: 'conflict', current: taskResult });
    await expect(
      backend.deleteComment('task:1', 'comment:1', mutationContext),
    ).resolves.toMatchObject({ outcome: 'deleted' });
  });

  it('models project administration, members, assignees, and project access decisions', async () => {
    const projectResult = {
      project: {
        reference: 'project:tasks',
        key: 'TASKS',
        name: 'Tasks',
        description: 'Shared task work.',
        visibility: 'workspace',
        kind: 'shared',
      },
      access: { role: 'owner', canCreateTask: true, canEditTasks: true },
    } as const satisfies TaskProjectView;
    const member = { principal: agent, role: 'owner' } as const;
    const workspace: TaskWorkspaceBackend = {
      async listProjects() {
        return [projectResult];
      },
      async createProject() {
        return { outcome: 'created', value: projectResult, notificationIntents: [] };
      },
      async updateProject() {
        return { outcome: 'unchanged', value: projectResult, notificationIntents: [] };
      },
      async listProjectMembers() {
        return { outcome: 'found', value: [member] };
      },
      async upsertProjectMember() {
        return { outcome: 'updated', value: member, notificationIntents: [] };
      },
      async listProjectAssignees() {
        return { outcome: 'found', value: [agent] };
      },
    };

    const projects = await workspace.listProjects({ identity });
    expect(projects[0]?.access).toEqual({
      role: 'owner',
      canCreateTask: true,
      canEditTasks: true,
    });
    await expect(workspace.listProjectMembers('project:tasks', { identity })).resolves.toEqual({
      outcome: 'found',
      value: [member],
    });
    await expect(workspace.listProjectAssignees('project:tasks', { identity })).resolves.toEqual({
      outcome: 'found',
      value: [agent],
    });
  });

  it('makes committed notification intents and mutation outcome states explicit', async () => {
    const created = {
      outcome: 'created',
      value: taskResult,
      notificationIntents: [notificationIntent],
    } as const satisfies CreateMutationOutcome<TaskReadResult>;
    const replayed = {
      outcome: 'replayed',
      value: taskResult,
      notificationIntents: [],
    } as const satisfies CreateMutationOutcome<TaskReadResult>;
    const updated = {
      outcome: 'updated',
      value: taskResult,
      notificationIntents: [notificationIntent],
    } as const satisfies UpdateMutationOutcome<TaskReadResult>;
    const unchanged = {
      outcome: 'unchanged',
      value: taskResult,
      notificationIntents: [],
    } as const satisfies UpdateMutationOutcome<TaskReadResult>;
    const invalidAssignee = {
      outcome: 'invalid-assignee',
      assignee: 'principal:missing',
    } as const satisfies CreateMutationOutcome<TaskReadResult>;
    const otherRejections = [
      { outcome: 'not-found' },
      { outcome: 'forbidden' },
      { outcome: 'invariant', invariant: 'personal-project-assignee' },
    ] as const satisfies readonly CreateMutationOutcome<TaskReadResult>[];

    expect([created.outcome, replayed.outcome, updated.outcome, unchanged.outcome]).toEqual([
      'created',
      'replayed',
      'updated',
      'unchanged',
    ]);
    expect(invalidAssignee.outcome).toBe('invalid-assignee');
    expect(otherRejections.map(({ outcome }) => outcome)).toEqual([
      'not-found',
      'forbidden',
      'invariant',
    ]);

    const notifications: NotificationProvider = {
      async publish(intent) {
        expect(intent.reference).toBe('outbox:1');
      },
    };
    await notifications.publish(created.notificationIntents[0]);
  });

  it('makes idempotency replay, conflicts, and uncertain writes explicit', async () => {
    const completed = new Map<string, JsonValue>();
    const store: IdempotencyStore = {
      async begin(claim) {
        const result = completed.get(`${claim.scope}:${claim.key}`);
        return result === undefined ? { state: 'acquired' } : { state: 'replay', result };
      },
      async complete(claim, result) {
        completed.set(`${claim.scope}:${claim.key}`, result);
      },
      async markUncertain() {},
    };
    const claim = {
      scope: 'task.create',
      key: 'request-1',
      fingerprint: 'sha256:example',
    } as const satisfies IdempotencyClaim;

    expect(await store.begin(claim)).toEqual({ state: 'acquired' });
    await store.complete(claim, { taskReference: 'task:1' });
    expect(await store.begin(claim)).toEqual({
      state: 'replay',
      result: { taskReference: 'task:1' },
    });

    const conflict = { state: 'conflict' } as const satisfies IdempotencyBeginResult;
    const uncertain = { state: 'uncertain' } as const satisfies IdempotencyBeginResult;
    expect(conflict.state).toBe('conflict');
    expect(uncertain.state).toBe('uncertain');
  });

  it('keeps assets and readiness independent of a hosting runtime', async () => {
    type AssetRequest = { readonly path: string };
    type AssetResult = { readonly bytes: Uint8Array; readonly contentType: string };
    const assets: AssetProvider<AssetRequest, AssetResult> = {
      async getAsset(request) {
        return request.path === '/app.js'
          ? { bytes: new Uint8Array([1]), contentType: 'text/javascript' }
          : null;
      },
    };
    expect((await assets.getAsset({ path: '/app.js' }))?.contentType).toBe('text/javascript');

    const databaseCheck: ReadinessCheck = {
      name: 'task-backend',
      async check() {
        return { ready: true };
      },
    };
    const readiness: ReadinessProvider = {
      async checkReadiness() {
        const result = await databaseCheck.check();
        return {
          ready: result.ready,
          checkedAt: '2026-08-30T14:00:00Z',
          checks: [{ name: databaseCheck.name, ...result }],
        };
      },
    };
    await expect(readiness.checkReadiness()).resolves.toMatchObject({ ready: true });
    expectTypeOf(readiness).toMatchTypeOf<ReadinessProvider>();
  });
});
