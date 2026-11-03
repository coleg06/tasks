import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { TaskAccessContext, TaskReadBackend } from '../core/contracts';

/** Deployment-owned display and default-assignee values; no active tenant is imported. */
export type TasksMcpProfile = {
  readonly organizationName: string;
  readonly defaultProjectKey: string;
  readonly agent: { readonly name: string; readonly email: string };
};

export type TasksMcpIdentity = {
  readonly clientId: string;
  readonly name: string;
  readonly runtime: string;
  readonly scope: 'read' | 'read_write';
  readonly expiresAt?: number | undefined;
};

export type TasksMcpApiCaller = (path: string, init?: RequestInit) => Promise<Response>;

export type TasksMcpToolDependencies = {
  readonly client: TasksMcpIdentity;
  readonly profile: TasksMcpProfile;
  readonly backend: TaskReadBackend;
  readonly access: TaskAccessContext;
  /** Canonical, authorization-aware API; owns audit, mutation verification and durable replay. */
  readonly callApi: TasksMcpApiCaller;
};

type TaskSummary = {
  key: string;
  reference: string;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  effort: string | null;
  dueDate: string | null;
  assignee: { name: string; email: string | null } | null;
  project: { key: string; name: string };
  version: number;
};

type TaskListResponse = { tasks: TaskSummary[] };

const taskReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .describe('Task reference such as T-123 or the opaque TASK-... key.');

const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/)
  .describe('Stable unique key for safely retrying this mutation.');

function toolResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(status: number, value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ status, ...(value as Record<string, unknown>) }),
      },
    ],
    isError: true,
  };
}

async function apiJson(callApi: TasksMcpApiCaller, path: string, init?: RequestInit) {
  const response = await callApi(path, init);
  const value = (await response.json().catch(() => ({ error: 'invalid_response' }))) as unknown;
  return response.ok ? toolResult(value) : toolError(response.status, value);
}

async function apiValue<T>(callApi: TasksMcpApiCaller, path: string, init?: RequestInit) {
  const response = await callApi(path, init);
  const value = (await response.json().catch(() => ({ error: 'invalid_response' }))) as T;
  if (!response.ok) throw new Error(JSON.stringify({ status: response.status, ...value }));
  return value;
}

async function resolveTaskKey(
  backend: TaskReadBackend,
  context: TaskAccessContext,
  reference: string,
) {
  const trimmed = reference.trim();
  const resolution = await backend.resolveTaskReference(trimmed, context);
  return resolution.outcome === 'resolved' ? resolution.reference.native : trimmed;
}

function ensureWriteAccess(client: TasksMcpIdentity) {
  if (client.scope !== 'read_write') throw new Error('This credential is read-only.');
}

function assigneeEmail(value: string | null | undefined, tenantProfile: TasksMcpProfile) {
  const MCP_AGENT_EMAIL = tenantProfile.agent.email;
  if (value === null || value?.toLowerCase() === 'unassigned') return null;
  if (
    !value ||
    value.toLowerCase() === 'agent' ||
    value.toLowerCase() === tenantProfile.agent.name.toLowerCase()
  ) {
    return MCP_AGENT_EMAIL;
  }
  return value.toLowerCase();
}

export function registerTasksMcpTools(server: McpServer, dependencies: TasksMcpToolDependencies) {
  const {
    callApi,
    client,
    profile: tenantProfile,
    backend: taskBackend,
    access: taskAccessContext,
  } = dependencies;
  const MCP_AGENT_EMAIL = tenantProfile.agent.email;
  const tenantTasks = `${tenantProfile.organizationName} tasks`;

  server.registerTool(
    'task_list',
    {
      title: `List ${tenantTasks}`,
      description: `List ${tenantTasks}. Use view=mine for tasks assigned to the shared ${tenantProfile.agent.name} principal.`,
      inputSchema: z.object({
        view: z.enum(['open', 'mine', 'backlog', 'completed', 'all']).default('open'),
        project: z.string().trim().min(1).max(40).optional(),
        assignee: z.string().trim().max(320).optional(),
        status: z.enum(['backlog', 'not_started', 'in_progress', 'blocked', 'done']).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ view, project, assignee, status, limit }) => {
      const views = view === 'all' ? ['open', 'backlog', 'completed'] : [view];
      const batches = await Promise.all(
        views.map((selectedView) => {
          const query = new URLSearchParams({ view: selectedView });
          if (project) query.set('project', project);
          return apiValue<TaskListResponse>(callApi, `/api/agent/v1/tasks?${query}`);
        }),
      );
      const unique = new Map(
        batches.flatMap((batch) => batch.tasks).map((task) => [task.key, task]),
      );
      const normalizedAssignee = assignee?.toLowerCase();
      const tasks = [...unique.values()]
        .filter((task) => !status || task.status === status)
        .filter((task) => {
          if (!normalizedAssignee) return true;
          if (normalizedAssignee === 'unassigned') return task.assignee === null;
          if (
            normalizedAssignee === 'agent' ||
            normalizedAssignee === tenantProfile.agent.name.toLowerCase()
          ) {
            return task.assignee?.email === MCP_AGENT_EMAIL;
          }
          return (
            task.assignee?.email?.toLowerCase() === normalizedAssignee ||
            task.assignee?.name.toLowerCase() === normalizedAssignee
          );
        })
        .slice(0, limit);
      return toolResult({ tasks, count: tasks.length });
    },
  );

  server.registerTool(
    'task_search',
    {
      title: `Search ${tenantTasks}`,
      description: `Search open, backlog, and completed ${tenantProfile.organizationName} task titles and descriptions.`,
      inputSchema: z.object({
        query: z.string().trim().min(1).max(120),
        project: z.string().trim().min(1).max(40).optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query: searchQuery, project, limit }) => {
      const batches = await Promise.all(
        ['open', 'backlog', 'completed'].map((view) => {
          const query = new URLSearchParams({ q: searchQuery, view });
          if (project) query.set('project', project);
          return apiValue<TaskListResponse>(callApi, `/api/agent/v1/tasks?${query}`);
        }),
      );
      const tasks = [
        ...new Map(
          batches.flatMap((batch) => batch.tasks).map((task) => [task.key, task]),
        ).values(),
      ].slice(0, limit);
      return toolResult({ tasks, count: tasks.length });
    },
  );

  server.registerTool(
    'task_get',
    {
      title: `Get a ${tenantProfile.organizationName} task`,
      description: `Get one ${tenantProfile.organizationName} task, including comments and current version.`,
      inputSchema: z.object({ task: taskReferenceSchema }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ task }) => {
      const key = await resolveTaskKey(taskBackend, taskAccessContext, task);
      return apiJson(callApi, `/api/agent/v1/tasks/${encodeURIComponent(key)}`);
    },
  );

  server.registerTool(
    'task_create',
    {
      title: `Create a ${tenantProfile.organizationName} task`,
      description: `Create a ${tenantProfile.organizationName} task. New agent-created tasks are assigned to ${tenantProfile.agent.name} unless another assignee or unassigned is specified.`,
      inputSchema: z.object({
        title: z.string().trim().min(1).max(240),
        description: z.string().max(10_000).default(''),
        status: z
          .enum(['backlog', 'not_started', 'in_progress', 'blocked', 'done'])
          .default('not_started'),
        priority: z.enum(['high', 'medium', 'low']).nullable().default(null),
        effort: z.enum(['small', 'medium', 'large']).nullable().default(null),
        assignee: z.string().trim().max(320).nullable().default(tenantProfile.agent.name),
        dueDate: z.iso.date().nullable().default(null),
        project: z.string().trim().min(1).max(40).default(tenantProfile.defaultProjectKey),
        taskTypes: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
        idempotencyKey: idempotencyKeySchema,
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ assignee, idempotencyKey, project, ...input }) => {
      ensureWriteAccess(client);
      return apiJson(callApi, '/api/agent/v1/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({
          ...input,
          projectKey: project,
          assigneeEmail: assigneeEmail(assignee, tenantProfile),
        }),
      });
    },
  );

  server.registerTool(
    'task_update',
    {
      title: `Update a ${tenantProfile.organizationName} task`,
      description: `Update fields on a ${tenantProfile.organizationName} task using optimistic concurrency.`,
      inputSchema: z
        .object({
          task: taskReferenceSchema,
          version: z.number().int().positive(),
          title: z.string().trim().min(1).max(240).optional(),
          description: z.string().max(10_000).optional(),
          status: z.enum(['backlog', 'not_started', 'in_progress', 'blocked', 'done']).optional(),
          priority: z.enum(['high', 'medium', 'low']).nullable().optional(),
          effort: z.enum(['small', 'medium', 'large']).nullable().optional(),
          assignee: z.string().trim().max(320).nullable().optional(),
          dueDate: z.iso.date().nullable().optional(),
          project: z.string().trim().min(1).max(40).optional(),
          taskTypes: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
          idempotencyKey: idempotencyKeySchema,
        })
        .refine(
          ({ task: _task, version: _version, idempotencyKey: _key, ...patch }) =>
            Object.keys(patch).length > 0,
          { message: 'At least one task field is required.' },
        ),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ task, version, assignee, project, idempotencyKey, ...patch }) => {
      ensureWriteAccess(client);
      const key = await resolveTaskKey(taskBackend, taskAccessContext, task);
      return apiJson(callApi, `/api/agent/v1/tasks/${encodeURIComponent(key)}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'If-Match': `"${version}"`,
        },
        body: JSON.stringify({
          ...patch,
          ...(assignee !== undefined
            ? { assigneeEmail: assigneeEmail(assignee, tenantProfile) }
            : {}),
          ...(project !== undefined ? { projectKey: project } : {}),
        }),
      });
    },
  );

  server.registerTool(
    'task_comment',
    {
      title: `Comment on a ${tenantProfile.organizationName} task`,
      description: `Add an attributable progress, decision, blocker, or verification comment to ${tenantTasks}.`,
      inputSchema: z.object({
        task: taskReferenceSchema,
        body: z.string().trim().min(1).max(5000),
        idempotencyKey: idempotencyKeySchema,
      }),
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ task, body, idempotencyKey }) => {
      ensureWriteAccess(client);
      const key = await resolveTaskKey(taskBackend, taskAccessContext, task);
      return apiJson(callApi, `/api/agent/v1/tasks/${encodeURIComponent(key)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ body: `[${client.name} via ${client.runtime}] ${body}` }),
      });
    },
  );
}
