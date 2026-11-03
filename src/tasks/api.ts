import type { Context } from 'hono';
import { tenantProfile } from '../../shared/tenant-profile';
import type { TaskAppEnv, TaskIdentity } from '../app-env';
import type { TaskAccessContext } from '../core/contracts';
import { requireTasksSession } from '../identity/context';
import { logApplicationError } from '../logging';
import {
  mentionedUserIds,
  sendUserNotification,
  taskNotificationOutboxStatement,
  taskUrl,
  type UserNotification,
} from '../notifications/email';
import { auditStatement } from '../persistence/d1-audit';
import {
  type D1CommentRow as CommentRow,
  D1TaskReadBackend,
  parseD1Json as parseJson,
  D1_PROJECT_ACCESS as projectAccess,
  D1_PROJECT_EDIT_ACCESS as projectEditAccess,
  publicD1Comment as publicComment,
  publicD1Task as publicTask,
  type D1TaskRow as TaskRow,
  D1_TASK_COLUMNS as taskColumns,
} from '../persistence/d1-task-backend';
import type { SqlStatement } from '../platform/ports';
import { isHostedEmail } from '../runtime/identity-config';
import { projectSettingsPatchSchema, taskMutationSchema, taskPatchSchema } from '../shared/schemas';
import { sortKey, taskAssignmentNotification, taskKeyForCreation } from './service';
import { normalizeTaskView } from './views';

export type { TaskAppEnv, TaskIdentity } from '../app-env';
export { requireTasksSession } from '../identity/context';
export { auditStatement } from '../persistence/d1-audit';
export { sortKey, taskAssignmentNotification, taskKeyForCreation } from './service';

type AppContext = Context<TaskAppEnv>;

function taskAccessContext(identity: TaskIdentity): TaskAccessContext {
  const email = identity.user.email.trim();
  return {
    identity: {
      principal: {
        reference: `user:${identity.user.id}`,
        kind: email.toLowerCase() === tenantProfile.agent.email.toLowerCase() ? 'agent' : 'human',
        name: email,
        email,
      },
      // D1 access clauses remain authoritative; signed session claims are presentation hints.
      permissions: [],
    },
  };
}

function taskReadBackend(context: AppContext) {
  return new D1TaskReadBackend(context.env.DB);
}

async function accessibleTask(context: AppContext, userId: number, taskKey: string) {
  return context.env.DB.prepare(
    `SELECT t.id, t.task_key, t.title, t.assignee_user_id, t.created_by_user_id, t.version
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE t.task_key = ? AND t.archived_at IS NULL AND p.archived_at IS NULL
       AND ${projectAccess}`,
  )
    .bind(taskKey, userId)
    .first<{
      id: number;
      task_key: string;
      title: string;
      assignee_user_id: number | null;
      created_by_user_id: number;
      version: number;
    }>();
}

async function taskAccessibleToUser(context: AppContext, taskId: number, userId: number) {
  const access = await context.env.DB.prepare(
    `SELECT 1 AS allowed
     FROM tasks t JOIN projects p ON p.id = t.project_id
     WHERE t.id = ? AND t.archived_at IS NULL AND p.archived_at IS NULL
       AND ${projectAccess}
       AND EXISTS (
         SELECT 1 FROM user_permissions notification_up
         WHERE notification_up.user_id = ?
           AND notification_up.permission_key IN ('tasks.view', 'tasks.personal', 'platform.admin')
       )`,
  )
    .bind(taskId, userId, userId)
    .first<{ allowed: number }>();
  return Boolean(access?.allowed);
}

async function accessibleNotificationUserIds(
  context: AppContext,
  taskId: number,
  userIds: Array<number | null>,
) {
  const candidates = [...new Set(userIds.filter((userId): userId is number => Boolean(userId)))];
  const decisions = await Promise.all(
    candidates.map(async (userId) => ({
      userId,
      allowed: await taskAccessibleToUser(context, taskId, userId),
    })),
  );
  return decisions.filter((decision) => decision.allowed).map((decision) => decision.userId);
}

function scheduleNotifications(context: AppContext, notifications: UserNotification[]) {
  if (notifications.length === 0) return;
  context.executionCtx.waitUntil(
    Promise.all(
      notifications.map((notification) => sendUserNotification(context.env, notification)),
    )
      .then(() => undefined)
      .catch(async (error) => {
        await logApplicationError(
          'notification.delivery_failed',
          error,
          context.env,
          context.get('requestId'),
        );
      }),
  );
}

async function editableProject(context: AppContext, userId: number, projectKey: string) {
  return context.env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.project_key, p.project_type, p.personal_owner_user_id
     FROM projects p
     WHERE p.project_key = ? AND p.archived_at IS NULL AND ${projectEditAccess}`,
  )
    .bind(projectKey, userId)
    .first<{
      id: number;
      workspace_id: number;
      project_key: string;
      project_type: 'shared' | 'personal';
      personal_owner_user_id: number | null;
    }>();
}

async function resolveAssignee(context: AppContext, workspaceId: number, email: string | null) {
  if (!email) return null;
  return context.env.DB.prepare(
    `SELECT u.id FROM users u
     JOIN workspace_members wm ON wm.user_id = u.id
     WHERE wm.workspace_id = ? AND u.email = ? COLLATE NOCASE AND u.status = 'active'`,
  )
    .bind(workspaceId, email)
    .first<{ id: number }>();
}

export async function listProjects(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const projects = await taskReadBackend(context).listProjectsForApi(taskAccessContext(identity));
  return context.json({ projects });
}

export async function createProject(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const input = await context.req.json<{
    name?: unknown;
    description?: unknown;
    visibility?: unknown;
  }>();
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  const description =
    typeof input.description === 'string' ? input.description.trim().slice(0, 500) : '';
  const visibility = input.visibility === 'private' ? 'private' : 'workspace';
  if (!name) return context.json({ error: 'name_required' }, 400);
  const workspace = await context.env.DB.prepare(
    `SELECT w.id FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE w.workspace_key = ? AND wm.user_id = ?`,
  )
    .bind(tenantProfile.workspaceKey, identity.user.id)
    .first<{ id: number }>();
  if (!workspace) return context.json({ error: 'forbidden' }, 403);
  const prefix =
    name
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9 ]/g, '')
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 4)
      .toUpperCase() || 'PRJ';
  const projectKey = `${prefix}-${crypto.randomUUID().slice(0, 4).toUpperCase()}`;
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO projects (
        workspace_id, project_key, name, description, visibility, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(workspace.id, projectKey, name, description, visibility, identity.user.id),
    context.env.DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role)
       SELECT id, ?, 'owner' FROM projects WHERE project_key = ?`,
    ).bind(identity.user.id, projectKey),
    auditStatement(context, identity.auditUserId, 'project', projectKey, 'project.created', {
      name,
      visibility,
    }),
  ]);
  return context.json({ project: { key: projectKey, name, description, visibility } }, 201);
}

export async function updateProject(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const parsed = projectSettingsPatchSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json({ error: 'invalid_project_settings', issues: parsed.error.issues }, 400);
  }
  const projectKey = context.req.param('projectKey') ?? '';
  const project = await context.env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.visibility, p.project_type
     FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = wm.user_id
     WHERE p.project_key = ? AND p.archived_at IS NULL AND wm.user_id = ?
       AND (
         wm.role IN ('owner','admin')
         OR pm.role = 'owner'
         OR EXISTS(
           SELECT 1 FROM user_permissions admin_up
           WHERE admin_up.user_id = wm.user_id AND admin_up.permission_key = 'tasks.manage'
         )
       )`,
  )
    .bind(projectKey, identity.user.id)
    .first<{
      id: number;
      name: string;
      description: string;
      visibility: 'workspace' | 'private';
      project_type: 'shared' | 'personal';
    }>();
  if (!project) return context.json({ error: 'forbidden' }, 403);
  if (project.project_type === 'personal') {
    return context.json({ error: 'personal_project_locked' }, 403);
  }

  const next = {
    name: parsed.data.name ?? project.name,
    description: parsed.data.description ?? project.description,
    visibility: parsed.data.visibility ?? project.visibility,
  };
  const changes = Object.fromEntries(
    Object.entries(next).filter(([key, value]) => value !== project[key as keyof typeof project]),
  );
  if (Object.keys(changes).length === 0) {
    return context.json({ project: { key: projectKey, ...next } });
  }

  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE projects SET name = ?, description = ?, visibility = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    ).bind(next.name, next.description, next.visibility, project.id),
    auditStatement(
      context,
      identity.auditUserId,
      'project',
      projectKey,
      'project.updated',
      changes,
    ),
  ]);
  return context.json({ project: { key: projectKey, ...next } });
}

export async function listProjectMembers(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const members = await taskReadBackend(context).listProjectMembersForApi(
    context.req.param('projectKey') ?? '',
    taskAccessContext(identity),
  );
  return members ? context.json({ members }) : context.json({ error: 'not_found' }, 404);
}

export async function upsertProjectMember(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.manage');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const input = await context.req.json<{ email?: unknown; role?: unknown }>();
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const role = input.role === 'editor' || input.role === 'owner' ? input.role : 'viewer';
  if (!isHostedEmail(context.env, email)) {
    return context.json({ error: 'hosted_email_required' }, 400);
  }
  const project = await context.env.DB.prepare(
    `SELECT p.id, p.workspace_id, p.project_type FROM projects p
     JOIN workspace_members wm ON wm.workspace_id = p.workspace_id
     LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = wm.user_id
     WHERE p.project_key = ? AND wm.user_id = ?
       AND (
         wm.role IN ('owner','admin')
         OR pm.role = 'owner'
         OR EXISTS(
           SELECT 1 FROM user_permissions admin_up
           WHERE admin_up.user_id = wm.user_id AND admin_up.permission_key = 'tasks.manage'
         )
       )`,
  )
    .bind(context.req.param('projectKey'), identity.user.id)
    .first<{ id: number; workspace_id: number; project_type: 'shared' | 'personal' }>();
  if (!project) return context.json({ error: 'forbidden' }, 403);
  if (project.project_type === 'personal') {
    return context.json({ error: 'personal_project_locked' }, 403);
  }
  const firstName = email.split('@')[0] ?? email;
  await context.env.DB.prepare(
    `INSERT INTO users (email, first_name) VALUES (?, ?)
     ON CONFLICT(email) DO UPDATE SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
  )
    .bind(email, firstName)
    .run();
  const user = await context.env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
    .bind(email)
    .first<{ id: number }>();
  if (!user) return context.json({ error: 'user_creation_failed' }, 500);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
       VALUES (?, 'tasks.view')`,
    ).bind(user.id),
    context.env.DB.prepare(
      `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
       VALUES (?, 'tasks.comment')`,
    ).bind(user.id),
    context.env.DB.prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'member')
       ON CONFLICT(workspace_id, user_id) DO NOTHING`,
    ).bind(project.workspace_id, user.id),
    context.env.DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
    ).bind(project.id, user.id, role),
    auditStatement(
      context,
      identity.auditUserId,
      'membership',
      `${context.req.param('projectKey')}:${email}`,
      'project.member_updated',
      {
        email,
        role,
      },
    ),
  ]);
  return context.json({ member: { email, role } });
}

export async function listProjectAssignees(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const assignees = await taskReadBackend(context).listProjectAssigneesForApi(
    context.req.param('projectKey') ?? '',
    taskAccessContext(identity),
  );
  return assignees ? context.json({ assignees }) : context.json({ error: 'not_found' }, 404);
}

export async function listTasks(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);

  const view = normalizeTaskView(context.req.query('view'));
  const query = (context.req.query('q') ?? '').trim().slice(0, 120);
  const project = (context.req.query('project') ?? '').trim().slice(0, 40);
  const requestedSort = (context.req.query('sort') ?? '').trim();
  const hideAgentTasks = context.req.query('hideAgent') === '1';
  const tasks = await taskReadBackend(context).listTasksForApi(
    { view, search: query, project, sort: requestedSort, hideAgentTasks },
    taskAccessContext(identity),
  );
  return context.get('mobileAdapter') ? context.json({ tasks }) : context.json({ tasks, view });
}

async function loadTaskDetail(context: AppContext, identity: TaskIdentity, taskKey: string) {
  return taskReadBackend(context).getTaskForApi(taskKey, taskAccessContext(identity));
}

export async function getTask(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const detail = await loadTaskDetail(context, identity, context.req.param('taskKey') ?? '');
  return detail ? context.json(detail) : context.json({ error: 'not_found' }, 404);
}

export async function createTask(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const parsed = taskMutationSchema.safeParse(await context.req.json());
  if (!parsed.success)
    return context.json({ error: 'invalid_task', issues: parsed.error.issues }, 400);
  const input = parsed.data;
  const project = await editableProject(context, identity.user.id, input.projectKey);
  if (!project) return context.json({ error: 'forbidden' }, 403);
  const requestedAssignee = await resolveAssignee(
    context,
    project.workspace_id,
    input.assigneeEmail,
  );
  if (input.assigneeEmail && !requestedAssignee) {
    return context.json({ error: 'invalid_assignee' }, 400);
  }
  if (
    project.project_type === 'personal' &&
    requestedAssignee &&
    requestedAssignee.id !== project.personal_owner_user_id
  ) {
    return context.json({ error: 'personal_project_assignee' }, 400);
  }
  const assignee =
    project.project_type === 'personal'
      ? { id: project.personal_owner_user_id ?? identity.user.id }
      : requestedAssignee;
  const taskKey = await taskKeyForCreation(identity.user.id, input.mutationKey);
  const timestamp = new Date().toISOString().replace('.000Z', 'Z');
  const metadata = { taskTypes: [...new Set(input.taskTypes)], attachments: [] };
  const { mutationKey: _mutationKey, ...auditedInput } = input;
  const changes = {
    ...auditedInput,
    assigneeEmail:
      project.project_type === 'personal'
        ? identity.user.email
        : (input.assigneeEmail?.toLowerCase() ?? null),
  };
  const requestId =
    context.get('requestId') ??
    context.req.header('cf-ray') ??
    context.req.header('x-request-id') ??
    crypto.randomUUID();
  const assignmentNotification = taskAssignmentNotification({
    actorUserId: identity.user.id,
    assignee,
    dueDate: input.dueDate,
    env: context.env,
    nextVersion: 1,
    previousAssigneeUserId: null,
    taskKey,
    title: input.title,
  });
  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `${input.mutationKey ? 'INSERT OR IGNORE' : 'INSERT'} INTO tasks (
        task_key, seq, title, description, status, priority, effort, assignee_user_id,
        created_by_user_id, due_date, sort_key, completed_at, source_metadata_json,
        workspace_id, project_id, created_at, updated_at
       ) VALUES (
        ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    ).bind(
      taskKey,
      input.title,
      input.description,
      input.status,
      input.priority,
      input.effort,
      assignee?.id ?? null,
      identity.user.id,
      input.dueDate,
      sortKey(input.status, input.priority, input.dueDate, taskKey),
      input.status === 'done' ? timestamp : null,
      JSON.stringify(metadata),
      project.workspace_id,
      project.id,
      timestamp,
      timestamp,
    ),
    context.env.DB.prepare('SELECT changes() AS task_inserted'),
    context.env.DB.prepare(
      `INSERT INTO task_events (task_id, actor_user_id, action, changes_json)
       SELECT t.id, ?, 'created', ? FROM tasks t
       WHERE t.task_key = ?
         AND NOT EXISTS (
           SELECT 1 FROM task_events existing
           WHERE existing.task_id = t.id AND existing.action = 'created'
         )`,
    ).bind(identity.user.id, JSON.stringify(changes), taskKey),
    context.env.DB.prepare('SELECT changes() AS event_inserted'),
    auditStatement(
      context,
      identity.auditUserId,
      'task',
      taskKey,
      'task.created',
      changes,
      requestId,
      true,
    ),
  ];
  if (assignmentNotification) {
    const outbox = taskNotificationOutboxStatement(context.env, assignmentNotification, requestId);
    if (outbox) statements.push(outbox);
  }
  const createdTaskResultIndex = statements.length;
  statements.push(
    context.env.DB.prepare(
      `SELECT ${taskColumns}
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       JOIN workspaces w ON w.id = p.workspace_id
       LEFT JOIN users u ON u.id = t.assignee_user_id
       JOIN users creator ON creator.id = t.created_by_user_id
       WHERE t.task_key = ? AND t.archived_at IS NULL AND p.archived_at IS NULL`,
    ).bind(taskKey),
  );
  const results = await context.env.DB.batch(statements);
  // D1 meta.changes includes work performed by the FTS triggers, so it is not a
  // reliable one-row insert signal. SQLite changes() excludes trigger effects and
  // is captured immediately after INSERT OR IGNORE inside the same batch.
  const insertion = results[1]?.results?.[0] as { task_inserted?: number } | undefined;
  const eventInsertion = results[3]?.results?.[0] as { event_inserted?: number } | undefined;
  const newlyCreated = Number(insertion?.task_inserted ?? 0) === 1;
  const creationEventCreated = Number(eventInsertion?.event_inserted ?? 0) === 1;
  const createdTask = results[createdTaskResultIndex]?.results?.[0] as TaskRow | undefined;
  if (
    (!newlyCreated && !input.mutationKey) ||
    (newlyCreated && !creationEventCreated) ||
    !createdTask
  ) {
    await logApplicationError(
      'task.creation_response_failed',
      new Error('Created task row unavailable.'),
      context.env,
      requestId,
      {
        taskKey,
        userId: identity.user.id,
        inserted: newlyCreated,
        insertMetaChanges: results[0]?.meta.changes ?? 0,
        eventInserted: creationEventCreated,
        eventMetaChanges: results[2]?.meta.changes ?? 0,
      },
    );
    return context.json({ error: 'task_creation_failed' }, 500);
  }
  if (newlyCreated && assignmentNotification)
    scheduleNotifications(context, [assignmentNotification]);
  return context.json({ task: publicTask(createdTask) }, newlyCreated ? 201 : 200);
}

export async function updateTask(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const taskKey = context.req.param('taskKey') ?? '';
  const current = await context.env.DB.prepare(
    `SELECT t.id, t.title, t.description, t.status, t.priority, t.effort, t.due_date, t.version,
       t.assignee_user_id, au.email AS assignee_email, t.source_metadata_json,
       p.project_key, p.workspace_id
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     LEFT JOIN users au ON au.id = t.assignee_user_id
     WHERE t.task_key = ? AND t.archived_at IS NULL AND ${projectEditAccess}`,
  )
    .bind(taskKey, identity.user.id)
    .first<{
      id: number;
      title: string;
      description: string;
      status: string;
      priority: string | null;
      effort: string | null;
      due_date: string | null;
      assignee_user_id: number | null;
      assignee_email: string | null;
      source_metadata_json: string | null;
      project_key: string;
      workspace_id: number;
      version: number;
    }>();
  if (!current) return context.json({ error: 'forbidden' }, 403);
  const ifMatch = context.req.header('If-Match');
  if (context.get('mobileAdapter') && !ifMatch) {
    return context.json({ error: 'if_match_required' }, 428);
  }
  let expectedVersion = current.version;
  if (ifMatch) {
    const match = /^"([1-9][0-9]*)"$/.exec(ifMatch);
    if (!match?.[1]) return context.json({ error: 'invalid_if_match' }, 400);
    expectedVersion = Number(match[1]);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.version) {
      const detail = await loadTaskDetail(context, identity, taskKey);
      return context.json({ error: 'version_conflict', ...(detail ?? {}) }, 409);
    }
  }
  const parsed = taskPatchSchema.safeParse(await context.req.json());
  if (!parsed.success)
    return context.json({ error: 'invalid_task', issues: parsed.error.issues }, 400);
  const patch = parsed.data;
  const projectKey = patch.projectKey ?? current.project_key;
  const project = await editableProject(context, identity.user.id, projectKey);
  if (!project) return context.json({ error: 'invalid_project' }, 400);
  const assigneeEmail =
    project.project_type === 'personal'
      ? identity.user.email
      : patch.assigneeEmail === undefined
        ? current.assignee_email
        : patch.assigneeEmail;
  const assignee = await resolveAssignee(context, project.workspace_id, assigneeEmail);
  if (assigneeEmail && !assignee) return context.json({ error: 'invalid_assignee' }, 400);
  if (project.project_type === 'personal' && assignee?.id !== project.personal_owner_user_id) {
    return context.json({ error: 'personal_project_assignee' }, 400);
  }
  const metadata = parseJson(current.source_metadata_json);
  if (patch.taskTypes) metadata.taskTypes = [...new Set(patch.taskTypes)];
  const next = {
    title: patch.title ?? current.title,
    description: patch.description ?? current.description,
    status: patch.status ?? current.status,
    priority: patch.priority === undefined ? current.priority : patch.priority,
    effort: patch.effort === undefined ? current.effort : patch.effort,
    dueDate: patch.dueDate === undefined ? current.due_date : patch.dueDate,
    assigneeEmail: assigneeEmail?.toLowerCase() ?? null,
    projectKey,
    taskTypes: Array.isArray(metadata.taskTypes) ? metadata.taskTypes : [],
  };
  const before = {
    title: current.title,
    description: current.description,
    status: current.status,
    priority: current.priority,
    effort: current.effort,
    dueDate: current.due_date,
    assigneeEmail: current.assignee_email,
    projectKey: current.project_key,
    taskTypes: Array.isArray(parseJson(current.source_metadata_json).taskTypes)
      ? parseJson(current.source_metadata_json).taskTypes
      : [],
  };
  const changes = Object.fromEntries(
    Object.entries(next)
      .filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(before[key as keyof typeof before]),
      )
      .map(([key, value]) => [key, { before: before[key as keyof typeof before], after: value }]),
  );
  if (Object.keys(changes).length === 0) {
    const detail = await loadTaskDetail(context, identity, taskKey);
    return detail ? context.json(detail) : context.json({ error: 'not_found' }, 404);
  }
  const timestamp = new Date().toISOString().replace('.000Z', 'Z');
  const requestId =
    context.get('requestId') ??
    context.req.header('cf-ray') ??
    context.req.header('x-request-id') ??
    crypto.randomUUID();
  const assignmentNotification = taskAssignmentNotification({
    actorUserId: identity.user.id,
    assignee,
    dueDate: next.dueDate,
    env: context.env,
    nextVersion: current.version + 1,
    previousAssigneeUserId: current.assignee_user_id,
    taskKey,
    title: next.title,
  });
  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `UPDATE tasks SET
        title = ?, description = ?, status = ?, priority = ?, effort = ?,
        assignee_user_id = ?, due_date = ?, sort_key = ?,
        completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END,
        source_metadata_json = ?, workspace_id = ?, project_id = ?,
        version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`,
    ).bind(
      next.title,
      next.description,
      next.status,
      next.priority,
      next.effort,
      assignee?.id ?? null,
      next.dueDate,
      sortKey(next.status, next.priority, next.dueDate, taskKey),
      next.status,
      timestamp,
      JSON.stringify(metadata),
      project.workspace_id,
      project.id,
      timestamp,
      current.id,
      expectedVersion,
    ),
    context.env.DB.prepare(
      `INSERT INTO task_events (task_id, actor_user_id, action, changes_json)
       SELECT ?, ?, 'updated', ? WHERE changes() = 1`,
    ).bind(current.id, identity.user.id, JSON.stringify(changes)),
    auditStatement(
      context,
      identity.auditUserId,
      'task',
      taskKey,
      'task.updated',
      changes,
      requestId,
      true,
    ),
  ];
  if (assignmentNotification) {
    const outbox = taskNotificationOutboxStatement(context.env, assignmentNotification, requestId);
    if (outbox) statements.push(outbox);
  }
  const results = await context.env.DB.batch(statements);
  // D1 reports total_changes(), which includes FTS trigger writes, so a committed update is
  // changes > 0 (not exactly 1); zero means the version guard matched no row.
  if (!results[0]?.meta.changes) {
    const detail = await loadTaskDetail(context, identity, taskKey);
    return context.json({ error: 'version_conflict', ...(detail ?? {}) }, 409);
  }
  if (assignmentNotification) scheduleNotifications(context, [assignmentNotification]);
  const detail = await loadTaskDetail(context, identity, taskKey);
  return detail ? context.json(detail) : context.json({ error: 'not_found' }, 404);
}

export async function createComment(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.comment');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const task = await accessibleTask(context, identity.user.id, context.req.param('taskKey') ?? '');
  if (!task) return context.json({ error: 'not_found' }, 404);
  const input = await context.req.json<{ body?: unknown }>();
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > 5000) return context.json({ error: 'invalid_comment' }, 400);
  const mentionCandidates = await mentionedUserIds(context.env, body);
  const mentions = await accessibleNotificationUserIds(context, task.id, mentionCandidates);
  const mutationKey = crypto.randomUUID();
  const requestId =
    context.get('requestId') ??
    context.req.header('cf-ray') ??
    context.req.header('x-request-id') ??
    crypto.randomUUID();
  const notifications: UserNotification[] = mentions.map((userId) => ({
    userId,
    actorUserId: identity.user.id,
    kind: 'mention',
    entityType: 'task',
    entityKey: task.task_key,
    dedupeKey: `mention:task-comment:${mutationKey}:${userId}`,
    subject: `You were mentioned: ${task.title}`,
    heading: 'You were mentioned in a task comment',
    message: body,
    url: taskUrl(context.env, task.task_key),
    taskVersion: task.version,
  }));
  const mentioned = new Set(mentions);
  const followers = await accessibleNotificationUserIds(context, task.id, [
    task.assignee_user_id,
    task.created_by_user_id,
  ]);
  for (const userId of followers) {
    if (!userId || userId === identity.user.id || mentioned.has(userId)) continue;
    notifications.push({
      userId,
      actorUserId: identity.user.id,
      kind: 'comment',
      entityType: 'task',
      entityKey: task.task_key,
      dedupeKey: `comment:task:${mutationKey}:${userId}`,
      subject: `New comment: ${task.title}`,
      heading: 'A task you follow has a new comment',
      message: body,
      url: taskUrl(context.env, task.task_key),
      taskVersion: task.version,
    });
  }
  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO task_comments (task_id, author_user_id, body, mutation_key)
       VALUES (?, ?, ?, ?)`,
    ).bind(task.id, identity.user.id, body, mutationKey),
    context.env.DB.prepare(
      `INSERT INTO task_events (task_id, actor_user_id, action, changes_json)
       SELECT ?, ?, 'commented', json_object('commentId', id)
       FROM task_comments WHERE mutation_key = ?`,
    ).bind(task.id, identity.user.id, mutationKey),
  ];
  for (const userId of mentions) {
    statements.push(
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO comment_mentions (subject_type, comment_id, mentioned_user_id)
         SELECT 'task', id, ? FROM task_comments WHERE mutation_key = ?`,
      ).bind(userId, mutationKey),
    );
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO audit_events (
         actor_user_id, entity_type, entity_key, action, changes_json, request_id
       ) SELECT ?, 'comment', CAST(id AS TEXT), 'comment.created', ?, ?
       FROM task_comments WHERE mutation_key = ?`,
    ).bind(
      identity.auditUserId,
      JSON.stringify({ taskKey: task.task_key }),
      requestId,
      mutationKey,
    ),
  );
  for (const notification of notifications) {
    const outbox = taskNotificationOutboxStatement(context.env, notification, requestId);
    if (outbox) statements.push(outbox);
  }
  const results = await context.env.DB.batch(statements);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    return context.json({ error: 'comment_creation_failed' }, 500);
  }
  const createdComment = await context.env.DB.prepare(
    `SELECT c.id, c.body, c.created_at, c.updated_at, c.edited_at, c.author_user_id,
       COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS author_name,
       u.email AS author_email
     FROM task_comments c JOIN users u ON u.id = c.author_user_id
     WHERE c.mutation_key = ?`,
  )
    .bind(mutationKey)
    .first<CommentRow>();
  if (createdComment) scheduleNotifications(context, notifications);
  return createdComment
    ? context.json(
        { comment: { ...publicComment(createdComment, identity.user.id), mentions } },
        201,
      )
    : context.json({ error: 'comment_creation_failed' }, 500);
}

export async function deleteComment(context: AppContext) {
  const identity = await requireTasksSession(context, 'tasks.comment');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const task = await accessibleTask(context, identity.user.id, context.req.param('taskKey') ?? '');
  if (!task) return context.json({ error: 'not_found' }, 404);
  const canManage = await context.env.DB.prepare(
    `SELECT 1 AS allowed FROM user_permissions
     WHERE user_id = ? AND permission_key = 'tasks.manage'`,
  )
    .bind(identity.user.id)
    .first<{ allowed: number }>();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE task_comments
       SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ? AND task_id = ? AND deleted_at IS NULL
         AND (author_user_id = ? OR ? = 1)`,
    ).bind(
      Number(context.req.param('commentId')),
      task.id,
      identity.user.id,
      canManage?.allowed ?? 0,
    ),
    context.env.DB.prepare(
      `INSERT INTO task_events (task_id, actor_user_id, action, changes_json)
       SELECT ?, ?, 'comment_deleted', json_object('commentId', ?) WHERE changes() = 1`,
    ).bind(task.id, identity.user.id, Number(context.req.param('commentId'))),
    auditStatement(
      context,
      identity.auditUserId,
      'comment',
      context.req.param('commentId') ?? '',
      'comment.deleted',
      { taskKey: task.task_key },
      undefined,
      true,
    ),
  ]);
  return results[0]?.meta.changes
    ? context.body(null, 204)
    : context.json({ error: 'not_found' }, 404);
}
