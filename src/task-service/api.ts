import { type Context, Hono } from 'hono';
import { z } from 'zod';
import {
  TASK_DEPENDENCY_KINDS,
  TASK_EFFORTS,
  TASK_PRIORITIES,
  TASK_WORKFLOW_STATES,
  type TaskPrincipalKind,
  type TaskPriority,
  type TaskWorkflowState,
} from '../../shared/task-domain';
import { tenantProfile } from '../../shared/tenant-profile';
import type { TaskAppEnv } from '../app-env';
import type {
  ResolvedIdentity,
  TaskAccessContext,
  TaskBackend,
  TaskCreateInput,
  TaskDirectoryBackend,
  TaskDirectoryQuery,
  TaskListQuery,
  TaskMutationContext,
  TaskPatch,
  TaskPrincipalDirectoryQuery,
  TaskReadBackend,
} from '../core/contracts';
import type { Env } from '../env';
import { resolveTasksIdentity } from '../identity/context';
import { tenantRuntimeAdapters } from '../runtime/tenant-adapters';

const API_VERSION = 'task-service/v1' as const;
const workflowStates = new Set<string>(TASK_WORKFLOW_STATES);
const priorities = new Set<string>(TASK_PRIORITIES);

export type TaskServiceApiDependencies = {
  resolveIdentity(
    context: Context<TaskAppEnv>,
    permission: string,
  ): Promise<ResolvedIdentity | null>;
  createTaskReadBackend(env: Env): TaskReadBackend;
  createTaskBackend?(env: Env): TaskBackend;
  createTaskDirectoryBackend?(env: Env): TaskDirectoryBackend;
};

const defaultDependencies: TaskServiceApiDependencies = {
  resolveIdentity: resolveTasksIdentity,
  createTaskReadBackend: tenantRuntimeAdapters.createTaskReadBackend,
  ...(tenantRuntimeAdapters.createTaskBackend === undefined
    ? {}
    : { createTaskBackend: tenantRuntimeAdapters.createTaskBackend }),
  ...(tenantRuntimeAdapters.createTaskDirectoryBackend === undefined
    ? {}
    : { createTaskDirectoryBackend: tenantRuntimeAdapters.createTaskDirectoryBackend }),
};

class InvalidQueryError extends Error {}

const jsonObjectSchema = z
  .record(z.string(), z.json())
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 32_000);
const dependencyMutationSchema = z.strictObject({
  task: z.string().trim().min(1).max(512),
  kind: z.enum(TASK_DEPENDENCY_KINDS),
});
const sprintMutationSchema = z.strictObject({
  reference: z.string().trim().min(1).max(512),
  role: z.enum(['committed', 'carryover', 'stretch']).optional(),
});
const taskCreateSchema = z.strictObject({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(32_000).nullable(),
  status: z.enum(TASK_WORKFLOW_STATES),
  priority: z.enum(TASK_PRIORITIES).nullable(),
  assignee: z.string().trim().min(1).max(512).nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  effort: z.enum(TASK_EFFORTS).nullable().optional(),
  taskTypes: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  tags: z.array(z.string().trim().min(1).max(128)).max(32).optional(),
  parent: z.string().trim().min(1).max(512).nullable().optional(),
  dependencies: z.array(dependencyMutationSchema).max(32).optional(),
  sprints: z.array(sprintMutationSchema).max(32).optional(),
  projects: z.array(z.string().trim().min(1).max(512)).max(32).optional(),
  metadata: jsonObjectSchema.optional(),
});
const taskPatchMutationSchema = taskCreateSchema
  .partial()
  .extend({ archived: z.boolean().optional() })
  .refine((value) => Object.keys(value).length > 0);
const commentMutationSchema = z.strictObject({ body: z.string().trim().min(1).max(32_000) });

function mutationHeaders(context: Context<TaskAppEnv>) {
  const idempotencyKey = context.req.header('Idempotency-Key')?.trim();
  if (!idempotencyKey || idempotencyKey.length > 128) return null;
  const requestId =
    context.get('requestId') ??
    context.req.header('cf-ray') ??
    context.req.header('x-request-id') ??
    crypto.randomUUID();
  return { idempotencyKey, requestId };
}

function mutationContext(
  identity: ResolvedIdentity,
  headers: { idempotencyKey: string; requestId: string },
  expectedRevision?: string,
): TaskMutationContext {
  return {
    identity,
    auditPrincipal: identity.principal,
    requestId: headers.requestId,
    idempotencyKey: headers.idempotencyKey,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  };
}

function createInput(value: z.infer<typeof taskCreateSchema>): TaskCreateInput {
  const { dependencies, sprints, ...fields } = value;
  return {
    title: fields.title,
    description: fields.description,
    status: fields.status,
    priority: fields.priority,
    ...(fields.assignee === undefined ? {} : { assignee: fields.assignee }),
    ...(fields.dueDate === undefined ? {} : { dueDate: fields.dueDate }),
    ...(fields.effort === undefined ? {} : { effort: fields.effort }),
    ...(fields.taskTypes === undefined ? {} : { taskTypes: fields.taskTypes }),
    ...(fields.tags === undefined ? {} : { tags: fields.tags }),
    ...(fields.parent === undefined ? {} : { parent: fields.parent }),
    ...(fields.projects === undefined ? {} : { projects: fields.projects }),
    ...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
    ...(dependencies === undefined
      ? {}
      : {
          dependencies: dependencies.map((dependency) => ({
            task: { native: dependency.task, display: dependency.task, aliases: [] },
            kind: dependency.kind,
            direction: 'outbound' as const,
          })),
        }),
    ...(sprints === undefined
      ? {}
      : {
          sprints: sprints.map((sprint) => ({
            reference: sprint.reference,
            key: sprint.reference,
            name: sprint.reference,
            ...(sprint.role === undefined ? {} : { role: sprint.role }),
          })),
        }),
  };
}

function patchInput(value: z.infer<typeof taskPatchMutationSchema>): TaskPatch {
  const { dependencies, sprints, ...fields } = value;
  return {
    ...(fields.title === undefined ? {} : { title: fields.title }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.status === undefined ? {} : { status: fields.status }),
    ...(fields.priority === undefined ? {} : { priority: fields.priority }),
    ...(fields.assignee === undefined ? {} : { assignee: fields.assignee }),
    ...(fields.dueDate === undefined ? {} : { dueDate: fields.dueDate }),
    ...(fields.effort === undefined ? {} : { effort: fields.effort }),
    ...(fields.taskTypes === undefined ? {} : { taskTypes: fields.taskTypes }),
    ...(fields.tags === undefined ? {} : { tags: fields.tags }),
    ...(fields.parent === undefined ? {} : { parent: fields.parent }),
    ...(fields.projects === undefined ? {} : { projects: fields.projects }),
    ...(fields.archived === undefined ? {} : { archived: fields.archived }),
    ...(fields.metadata === undefined ? {} : { metadata: fields.metadata }),
    ...(dependencies === undefined
      ? {}
      : {
          dependencies: dependencies.map((dependency) => ({
            task: { native: dependency.task, display: dependency.task, aliases: [] },
            kind: dependency.kind,
            direction: 'outbound' as const,
          })),
        }),
    ...(sprints === undefined
      ? {}
      : {
          sprints: sprints.map((sprint) => ({
            reference: sprint.reference,
            key: sprint.reference,
            name: sprint.reference,
            ...(sprint.role === undefined ? {} : { role: sprint.role }),
          })),
        }),
  };
}

function unsupportedMutationFeature(
  value: z.infer<typeof taskCreateSchema> | z.infer<typeof taskPatchMutationSchema>,
  backend: TaskBackend,
) {
  const capabilities = backend.capabilities;
  if (value.status !== undefined && !capabilities.workflow.includes(value.status)) return 'status';
  if (
    value.priority !== undefined &&
    ((value.priority === null && !capabilities.allowsUnprioritized) ||
      (value.priority !== null && !capabilities.priorities.includes(value.priority)))
  ) {
    return 'priority';
  }
  if ('effort' in value && value.effort !== undefined && !capabilities.effort) return 'effort';
  if ('taskTypes' in value && value.taskTypes !== undefined && !capabilities.taskTypes) {
    return 'taskTypes';
  }
  if ('tags' in value && value.tags !== undefined && !capabilities.tags) return 'tags';
  if ('parent' in value && value.parent !== undefined && !capabilities.parentTasks) return 'parent';
  if ('dependencies' in value && value.dependencies !== undefined && !capabilities.dependencies) {
    return 'dependencies';
  }
  if ('sprints' in value && value.sprints !== undefined && !capabilities.sprints) return 'sprints';
  if ('projects' in value && value.projects !== undefined) {
    if (capabilities.projectCardinality === 'none' && value.projects.length > 0) return 'projects';
    if (capabilities.projectCardinality === 'single' && value.projects.length > 1)
      return 'projects';
  }
  return null;
}

function singleValue(value: string | undefined, maximum: number) {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new InvalidQueryError();
  return normalized;
}

function commaValues(value: string | undefined, maximumItems: number, maximumLength: number) {
  if (value === undefined) return undefined;
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (
    values.length === 0 ||
    values.length > maximumItems ||
    values.some((item) => item.length > maximumLength)
  ) {
    throw new InvalidQueryError();
  }
  return [...new Set(values)];
}

function booleanValue(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new InvalidQueryError();
}

function listQuery(context: Context<TaskAppEnv>): TaskListQuery {
  const statuses = commaValues(context.req.query('status'), 16, 32);
  if (statuses?.some((status) => !workflowStates.has(status))) throw new InvalidQueryError();
  const priorityValues = commaValues(context.req.query('priority'), 8, 32);
  if (priorityValues?.some((priority) => priority !== 'none' && !priorities.has(priority))) {
    throw new InvalidQueryError();
  }
  const limitValue = context.req.query('limit');
  const limit = limitValue === undefined ? 100 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new InvalidQueryError();
  const search = singleValue(context.req.query('search'), 256);
  const assignee = singleValue(context.req.query('assignee'), 512);
  const project = singleValue(context.req.query('project'), 512);
  const tags = commaValues(context.req.query('tag'), 50, 128);
  const excludedKinds = commaValues(context.req.query('excludeAssigneeKind'), 3, 16);
  if (excludedKinds?.some((kind) => !['human', 'agent', 'system'].includes(kind))) {
    throw new InvalidQueryError();
  }
  const parent = singleValue(context.req.query('parent'), 512);
  const cursor = singleValue(context.req.query('cursor'), 1024);
  const includeArchived = booleanValue(context.req.query('includeArchived'));
  return {
    ...(search ? { search } : {}),
    ...(statuses ? { statuses: statuses as TaskWorkflowState[] } : {}),
    ...(priorityValues
      ? {
          priorities: priorityValues.map((priority) =>
            priority === 'none' ? null : (priority as TaskPriority),
          ),
        }
      : {}),
    ...(assignee ? { assignee: assignee === 'unassigned' ? null : assignee } : {}),
    ...(project ? { project } : {}),
    ...(tags ? { tags } : {}),
    ...(excludedKinds ? { excludeAssigneeKinds: excludedKinds as TaskPrincipalKind[] } : {}),
    ...(parent ? { parent: parent === 'none' ? null : parent } : {}),
    ...(cursor ? { cursor } : {}),
    ...(includeArchived !== undefined ? { includeArchived } : {}),
    limit,
  };
}

function directoryQuery(context: Context<TaskAppEnv>): TaskDirectoryQuery {
  const limitValue = context.req.query('limit');
  const limit = limitValue === undefined ? 100 : Number(limitValue);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new InvalidQueryError();
  const cursor = singleValue(context.req.query('cursor'), 1024);
  return { limit, ...(cursor ? { cursor } : {}) };
}

export function enabledPrincipalKinds(
  kinds: readonly TaskPrincipalKind[] | undefined,
  agentEnabled = tenantProfile.agent.enabled,
): readonly TaskPrincipalKind[] | undefined {
  if (agentEnabled) return kinds;
  return kinds ? kinds.filter((kind) => kind !== 'agent') : ['human', 'system'];
}

function principalDirectoryQuery(context: Context<TaskAppEnv>): TaskPrincipalDirectoryQuery {
  const query = directoryQuery(context);
  const kinds = commaValues(context.req.query('kind'), 3, 16);
  if (kinds?.some((kind) => !['human', 'agent', 'system'].includes(kind))) {
    throw new InvalidQueryError();
  }
  const email = singleValue(context.req.query('email'), 254);
  const enabledKinds = enabledPrincipalKinds(kinds as TaskPrincipalKind[] | undefined);
  return {
    ...query,
    ...(enabledKinds
      ? { kinds: enabledKinds as NonNullable<TaskPrincipalDirectoryQuery['kinds']> }
      : tenantProfile.agent.enabled
        ? {}
        : { kinds: ['human', 'system'] }),
    ...(email ? { email } : {}),
  };
}

async function accessContext(
  context: Context<TaskAppEnv>,
  dependencies: TaskServiceApiDependencies,
) {
  const identity = await dependencies.resolveIdentity(context, 'tasks.view');
  return identity ? ({ identity } satisfies TaskAccessContext) : null;
}

export function createTaskServiceApi(
  dependencies: TaskServiceApiDependencies = defaultDependencies,
) {
  const api = new Hono<TaskAppEnv>();

  api.use('*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });

  api.get('/capabilities', async (context) => {
    const access = await accessContext(context, dependencies);
    if (!access) return context.json({ error: 'unauthorized' }, 401);
    const backend = dependencies.createTaskReadBackend(context.env);
    const hasWriteBackend = dependencies.createTaskBackend !== undefined;
    return context.json({
      apiVersion: API_VERSION,
      capabilities: backend.capabilities,
      mutations: {
        create: hasWriteBackend && backend.capabilities.durableIdempotency,
        update:
          hasWriteBackend &&
          backend.capabilities.durableIdempotency &&
          backend.capabilities.optimisticConcurrency,
        comment:
          hasWriteBackend &&
          backend.capabilities.durableIdempotency &&
          backend.capabilities.comments,
      },
    });
  });

  api.get('/tasks', async (context) => {
    const access = await accessContext(context, dependencies);
    if (!access) return context.json({ error: 'unauthorized' }, 401);
    let query: TaskListQuery;
    try {
      query = listQuery(context);
    } catch (error) {
      if (error instanceof InvalidQueryError) {
        return context.json({ error: 'invalid_query' }, 400);
      }
      throw error;
    }
    if (query.assignee === 'me') {
      query = { ...query, assignee: access.identity.principal.reference };
    }
    const page = await dependencies.createTaskReadBackend(context.env).listTasks(query, access);
    return context.json({ apiVersion: API_VERSION, ...page });
  });

  api.get('/tasks/:reference', async (context) => {
    const access = await accessContext(context, dependencies);
    if (!access) return context.json({ error: 'unauthorized' }, 401);
    let comments: boolean | undefined;
    let history: boolean | undefined;
    try {
      comments = booleanValue(context.req.query('comments'));
      history = booleanValue(context.req.query('history'));
    } catch (error) {
      if (error instanceof InvalidQueryError) {
        return context.json({ error: 'invalid_query' }, 400);
      }
      throw error;
    }
    const backend = dependencies.createTaskReadBackend(context.env);
    const resolution = await backend.resolveTaskReference(context.req.param('reference'), access);
    if (resolution.outcome === 'not-found') return context.json({ error: 'not_found' }, 404);
    const result = await backend.getTask(
      resolution.reference.native,
      {
        ...(comments !== undefined ? { comments } : {}),
        ...(history !== undefined ? { history } : {}),
      },
      access,
    );
    return result
      ? context.json({ apiVersion: API_VERSION, ...result })
      : context.json({ error: 'not_found' }, 404);
  });

  api.get('/principals', async (context) => {
    const access = await accessContext(context, dependencies);
    if (!access) return context.json({ error: 'unauthorized' }, 401);
    if (!dependencies.createTaskDirectoryBackend) {
      return context.json({ error: 'directory_unsupported' }, 405);
    }
    let query: TaskPrincipalDirectoryQuery;
    try {
      query = principalDirectoryQuery(context);
    } catch (error) {
      if (error instanceof InvalidQueryError) return context.json({ error: 'invalid_query' }, 400);
      throw error;
    }
    if (query.kinds?.length === 0) {
      return context.json({ apiVersion: API_VERSION, principals: [], total: 0, nextCursor: null });
    }
    const page = await dependencies
      .createTaskDirectoryBackend(context.env)
      .listTaskPrincipals(query, access);
    return context.json({
      apiVersion: API_VERSION,
      principals: page.values,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  api.get('/projects', async (context) => {
    const access = await accessContext(context, dependencies);
    if (!access) return context.json({ error: 'unauthorized' }, 401);
    if (!dependencies.createTaskDirectoryBackend) {
      return context.json({ error: 'directory_unsupported' }, 405);
    }
    let query: TaskDirectoryQuery;
    try {
      query = directoryQuery(context);
    } catch (error) {
      if (error instanceof InvalidQueryError) return context.json({ error: 'invalid_query' }, 400);
      throw error;
    }
    const page = await dependencies
      .createTaskDirectoryBackend(context.env)
      .listTaskProjects(query, access);
    return context.json({
      apiVersion: API_VERSION,
      projects: page.values,
      ...(page.total === undefined ? {} : { total: page.total }),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
  });

  api.post('/tasks', async (context) => {
    if (dependencies.createTaskBackend === undefined) {
      return context.json({ error: 'mutation_unsupported' }, 405);
    }
    const identity = await dependencies.resolveIdentity(context, 'tasks.manage');
    if (!identity) return context.json({ error: 'forbidden' }, 403);
    const headers = mutationHeaders(context);
    if (!headers) return context.json({ error: 'idempotency_key_required' }, 428);
    let parsed: ReturnType<typeof taskCreateSchema.safeParse>;
    try {
      parsed = taskCreateSchema.safeParse(await context.req.json());
    } catch {
      return context.json({ error: 'invalid_task' }, 400);
    }
    if (!parsed.success) return context.json({ error: 'invalid_task' }, 400);
    const backend = dependencies.createTaskBackend(context.env);
    if (!backend.capabilities.durableIdempotency) {
      return context.json({ error: 'mutation_unsupported' }, 405);
    }
    const unsupportedFeature = unsupportedMutationFeature(parsed.data, backend);
    if (unsupportedFeature) {
      return context.json({ error: 'unsupported_feature', feature: unsupportedFeature }, 400);
    }
    const outcome = await backend.createTask(
      createInput(parsed.data),
      mutationContext(identity, headers),
    );
    if (outcome.outcome === 'created' || outcome.outcome === 'replayed') {
      return context.json(
        { apiVersion: API_VERSION, ...outcome },
        outcome.outcome === 'created' ? 201 : 200,
      );
    }
    if (outcome.outcome === 'forbidden') return context.json({ error: 'forbidden' }, 403);
    if (outcome.outcome === 'not-found') return context.json({ error: 'not_found' }, 404);
    if (outcome.outcome === 'invalid-assignee') {
      return context.json({ error: 'invalid_assignee' }, 400);
    }
    if (outcome.outcome === 'invariant') {
      return context.json({ error: 'invariant', invariant: outcome.invariant }, 400);
    }
    return context.json({ error: 'mutation_failed' }, 500);
  });

  api.patch('/tasks/:reference', async (context) => {
    if (dependencies.createTaskBackend === undefined) {
      return context.json({ error: 'mutation_unsupported' }, 405);
    }
    const identity = await dependencies.resolveIdentity(context, 'tasks.manage');
    if (!identity) return context.json({ error: 'forbidden' }, 403);
    const headers = mutationHeaders(context);
    if (!headers) return context.json({ error: 'idempotency_key_required' }, 428);
    const expectedRevision = context.req.header('X-Task-Revision')?.trim();
    if (!expectedRevision || expectedRevision.length > 512) {
      return context.json({ error: 'revision_required' }, 428);
    }
    let parsed: ReturnType<typeof taskPatchMutationSchema.safeParse>;
    try {
      parsed = taskPatchMutationSchema.safeParse(await context.req.json());
    } catch {
      return context.json({ error: 'invalid_task' }, 400);
    }
    if (!parsed.success) return context.json({ error: 'invalid_task' }, 400);
    const backend = dependencies.createTaskBackend(context.env);
    if (!backend.capabilities.durableIdempotency || !backend.capabilities.optimisticConcurrency) {
      return context.json({ error: 'mutation_unsupported' }, 405);
    }
    const unsupportedFeature = unsupportedMutationFeature(parsed.data, backend);
    if (unsupportedFeature) {
      return context.json({ error: 'unsupported_feature', feature: unsupportedFeature }, 400);
    }
    const access = { identity } satisfies TaskAccessContext;
    const resolution = await backend.resolveTaskReference(context.req.param('reference'), access);
    if (resolution.outcome === 'not-found') return context.json({ error: 'not_found' }, 404);
    const outcome = await backend.updateTask(
      resolution.reference.native,
      patchInput(parsed.data),
      mutationContext(identity, headers, expectedRevision),
    );
    if (outcome.outcome === 'updated' || outcome.outcome === 'unchanged') {
      return context.json({ apiVersion: API_VERSION, ...outcome });
    }
    if (outcome.outcome === 'conflict') {
      return context.json({ error: 'revision_conflict', current: outcome.current }, 409);
    }
    if (outcome.outcome === 'forbidden') return context.json({ error: 'forbidden' }, 403);
    if (outcome.outcome === 'not-found') return context.json({ error: 'not_found' }, 404);
    if (outcome.outcome === 'invalid-assignee') {
      return context.json({ error: 'invalid_assignee' }, 400);
    }
    if (outcome.outcome === 'invariant') {
      return context.json({ error: 'invariant', invariant: outcome.invariant }, 400);
    }
    return context.json({ error: 'mutation_failed' }, 500);
  });

  api.post('/tasks/:reference/comments', async (context) => {
    if (dependencies.createTaskBackend === undefined) {
      return context.json({ error: 'mutation_unsupported' }, 405);
    }
    const identity = await dependencies.resolveIdentity(context, 'tasks.comment');
    if (!identity) return context.json({ error: 'forbidden' }, 403);
    const headers = mutationHeaders(context);
    if (!headers) return context.json({ error: 'idempotency_key_required' }, 428);
    let parsed: ReturnType<typeof commentMutationSchema.safeParse>;
    try {
      parsed = commentMutationSchema.safeParse(await context.req.json());
    } catch {
      return context.json({ error: 'invalid_comment' }, 400);
    }
    if (!parsed.success) return context.json({ error: 'invalid_comment' }, 400);
    const backend = dependencies.createTaskBackend(context.env);
    if (!backend.capabilities.durableIdempotency || !backend.capabilities.comments) {
      return context.json({ error: 'mutation_unsupported' }, 405);
    }
    const access = { identity } satisfies TaskAccessContext;
    const resolution = await backend.resolveTaskReference(context.req.param('reference'), access);
    if (resolution.outcome === 'not-found') return context.json({ error: 'not_found' }, 404);
    const outcome = await backend.addComment(
      resolution.reference.native,
      parsed.data.body,
      mutationContext(identity, headers),
    );
    if (outcome.outcome === 'created' || outcome.outcome === 'replayed') {
      return context.json(
        { apiVersion: API_VERSION, ...outcome },
        outcome.outcome === 'created' ? 201 : 200,
      );
    }
    if (outcome.outcome === 'forbidden') return context.json({ error: 'forbidden' }, 403);
    if (outcome.outcome === 'not-found') return context.json({ error: 'not_found' }, 404);
    if (outcome.outcome === 'invalid-assignee') {
      return context.json({ error: 'invalid_assignee' }, 400);
    }
    if (outcome.outcome === 'invariant') {
      return context.json({ error: 'invariant', invariant: outcome.invariant }, 400);
    }
    return context.json({ error: 'mutation_failed' }, 500);
  });

  api.all('*', (context) => context.json({ error: 'not_found' }, 404));
  return api;
}

export const taskServiceApi = createTaskServiceApi();
