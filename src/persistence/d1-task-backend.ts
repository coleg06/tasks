import type {
  JsonObject,
  JsonValue,
  TaskComment,
  TaskDomainCapabilities,
  TaskEffort,
  TaskFieldChange,
  TaskHistoryEvent,
  TaskPrincipal,
  TaskPriority,
  TaskProjectMember,
  TaskProjectMemberRole,
  TaskRecord,
  TaskReference,
  TaskWorkflowState,
} from '../../shared/task-domain';
import { tenantProfile } from '../../shared/tenant-profile';
import type {
  AccessLookupResult,
  TaskAccessContext,
  TaskCommentView,
  TaskListQuery,
  TaskPage,
  TaskProjectAccessRole,
  TaskProjectView,
  TaskReadBackend,
  TaskReadResult,
  TaskWorkspaceBackend,
} from '../core/contracts';
import type { Env } from '../env';
import { type TaskView, taskViewFilter } from '../tasks/views';

export type D1TaskBackendReads = TaskReadBackend;

export type D1TaskWorkspaceBackendReads = Pick<
  TaskWorkspaceBackend,
  'listProjectAssignees' | 'listProjectMembers' | 'listProjects'
>;

export const D1_TASK_CAPABILITIES = {
  workflow: ['backlog', 'not_started', 'in_progress', 'blocked', 'done'],
  priorities: ['high', 'medium', 'low'],
  allowsUnprioritized: true,
  principalKinds: ['human', 'agent'],
  effort: true,
  taskTypes: true,
  tags: false,
  parentTasks: false,
  dependencies: false,
  sprints: false,
  projectCardinality: 'single',
  comments: true,
  history: true,
  optimisticConcurrency: true,
  durableIdempotency: true,
} as const satisfies TaskDomainCapabilities;

export type D1TaskRow = {
  id: number;
  task_key: string;
  seq: number;
  title: string;
  description: string;
  status: string;
  priority: string | null;
  effort: string | null;
  due_date: string | null;
  completed_at: string | null;
  archived_at?: string | null;
  source_system?: string | null;
  source_id?: string | null;
  source_url: string | null;
  source_created_at?: string | null;
  source_updated_at: string | null;
  source_metadata_json: string | null;
  source_content_json?: string | null;
  assignee_user_id?: number | null;
  assignee_name: string | null;
  assignee_email: string | null;
  assignee_principal_type?: 'human' | 'agent' | null;
  creator_user_id?: number;
  creator_name: string;
  creator_email: string;
  creator_photo_url: string | null;
  creator_principal_type?: 'human' | 'agent';
  project_key: string;
  project_name: string;
  project_description?: string;
  project_visibility?: 'workspace' | 'private';
  project_type?: 'shared' | 'personal';
  workspace_key: string;
  workspace_name: string;
  created_at: string;
  updated_at: string;
  version: number;
};

type D1ProjectRow = {
  project_key: string;
  name: string;
  description: string;
  visibility: 'workspace' | 'private';
  project_type: 'shared' | 'personal';
  personal_owner_user_id: number | null;
  workspace_key: string;
  workspace_name: string;
  member_role: 'owner' | 'editor' | 'viewer' | null;
  workspace_role: 'owner' | 'admin' | 'member';
  is_task_admin: number;
  can_edit_tasks: number;
};

export type D1CommentRow = {
  id: number;
  body: string;
  created_at: string;
  updated_at: string;
  edited_at: string | null;
  author_user_id: number;
  author_name: string;
  author_email: string;
  author_principal_type?: 'human' | 'agent';
};

type D1TaskEventRow = {
  id: number;
  action: string;
  changes_json: string;
  created_at: string;
  actor_user_id?: number;
  actor_name: string;
  actor_email: string;
  actor_principal_type?: 'human' | 'agent';
};

type D1ProjectMemberRow = {
  id: number;
  email: string;
  name: string;
  principal_type: 'human' | 'agent';
  role: TaskProjectMemberRole;
};

type D1ProjectAssigneeRow = {
  id: number;
  email: string;
  name: string;
  principal_type: 'human' | 'agent';
};

export type D1TaskApiListQuery = {
  view: TaskView;
  search: string;
  project: string;
  sort: string;
  hideAgentTasks: boolean;
};

type D1TaskRowQuery = TaskListQuery & {
  view?: TaskView;
  sort?: string;
  hideAgentTasks?: boolean;
};

type D1TaskDetailRows = {
  task: D1TaskRow;
  canEdit: boolean;
  canComment: boolean;
  canManageComments: boolean;
  comments?: readonly D1CommentRow[];
  activity?: readonly D1TaskEventRow[];
};

type D1TaskDetailOptions = {
  comments?: boolean;
  history?: boolean;
  historyLimit?: number;
};

type D1TaskRowPage = {
  limit: number;
  afterSequence?: number;
  lookahead: boolean;
};

const D1_TASK_CURSOR_PREFIX = 'd1-task-cursor:v2:';

const D1_EFFECTIVE_ASSIGNEE_NAME = `COALESCE(
  NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''),
  json_extract(t.source_metadata_json, '$.assignees[0].name')
)`;

const D1_EFFECTIVE_ASSIGNEE_EMAIL = `COALESCE(
  u.email,
  json_extract(t.source_metadata_json, '$.assignees[0].email')
)`;

const D1_NORMALIZED_ASSIGNEE_EMAIL = `NULLIF(
  TRIM(CAST(${D1_EFFECTIVE_ASSIGNEE_EMAIL} AS TEXT)),
  ''
)`;

const D1_EFFECTIVE_ASSIGNEE_PRESENT = `(
  NULLIF(TRIM(CAST(${D1_EFFECTIVE_ASSIGNEE_NAME} AS TEXT)), '') IS NOT NULL
  OR ${D1_NORMALIZED_ASSIGNEE_EMAIL} IS NOT NULL
)`;

export const D1_TASK_COLUMNS = `
  t.id, t.task_key, t.seq, t.title, t.description, t.status, t.priority, t.effort,
  t.due_date, t.completed_at, t.archived_at, t.source_system, t.source_id,
  t.source_url, t.source_created_at, t.source_updated_at, t.version,
  t.source_metadata_json, t.created_at, t.updated_at,
  t.assignee_user_id,
  p.project_key, p.name AS project_name, p.description AS project_description,
  p.visibility AS project_visibility, p.project_type,
  w.workspace_key, w.name AS workspace_name,
  ${D1_EFFECTIVE_ASSIGNEE_NAME} AS assignee_name,
  ${D1_EFFECTIVE_ASSIGNEE_EMAIL} AS assignee_email,
  u.principal_type AS assignee_principal_type,
  creator.id AS creator_user_id,
  COALESCE(NULLIF(TRIM(creator.first_name || ' ' || creator.last_name), ''), creator.email)
    AS creator_name,
  creator.email AS creator_email,
  creator.photo_url AS creator_photo_url,
  creator.principal_type AS creator_principal_type`;

/** Kept byte-for-byte equivalent to the authorization clause used by the legacy handlers. */
export const D1_PROJECT_ACCESS = `EXISTS (
  SELECT 1 FROM workspace_members access_wm
  WHERE access_wm.workspace_id = p.workspace_id AND access_wm.user_id = ?
    AND (
      (p.project_type = 'personal' AND p.personal_owner_user_id = access_wm.user_id)
      OR (p.project_type = 'shared' AND (
        EXISTS (
          SELECT 1 FROM effective_user_permissions shared_view_up
          WHERE shared_view_up.user_id = access_wm.user_id
            AND shared_view_up.permission_key IN ('tasks.view', 'platform.admin')
        ) AND (
          p.visibility = 'workspace'
          OR access_wm.role IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1 FROM effective_user_permissions access_up
            WHERE access_up.user_id = access_wm.user_id
              AND access_up.permission_key = 'tasks.manage'
          )
          OR EXISTS (
            SELECT 1 FROM project_members access_pm
            WHERE access_pm.project_id = p.id AND access_pm.user_id = access_wm.user_id
          )
        )
      ))
    )
)`;

/** Kept byte-for-byte equivalent to the edit clause used by the legacy handlers. */
export const D1_PROJECT_EDIT_ACCESS = `EXISTS (
  SELECT 1 FROM workspace_members edit_wm
  LEFT JOIN project_members edit_pm
    ON edit_pm.project_id = p.id AND edit_pm.user_id = edit_wm.user_id
  WHERE edit_wm.workspace_id = p.workspace_id AND edit_wm.user_id = ?
    AND (
      (p.project_type = 'personal' AND p.personal_owner_user_id = edit_wm.user_id)
      OR (p.project_type = 'shared' AND (
        EXISTS (
          SELECT 1 FROM effective_user_permissions shared_edit_view_up
          WHERE shared_edit_view_up.user_id = edit_wm.user_id
            AND shared_edit_view_up.permission_key IN ('tasks.view', 'platform.admin')
        ) AND (
          edit_wm.role IN ('owner', 'admin')
          OR edit_pm.role IN ('owner', 'editor')
          OR EXISTS (
            SELECT 1 FROM effective_user_permissions edit_up
            WHERE edit_up.user_id = edit_wm.user_id AND edit_up.permission_key = 'tasks.manage'
          )
        )
      ))
    )
)`;

export function parseD1Json(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function publicD1Comment(row: D1CommentRow, currentUserId: number) {
  return {
    id: row.id,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,
    canDelete: row.author_user_id === currentUserId,
    author: { name: row.author_name || row.author_email, email: row.author_email },
  };
}

export function publicD1Task(row: D1TaskRow, includeContent = false) {
  const metadata = parseD1Json(row.source_metadata_json);
  const content = includeContent ? parseD1Json(row.source_content_json) : undefined;
  return {
    key: row.task_key,
    reference: `T-${row.seq}`,
    seq: row.seq,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    effort: row.effort,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    assignee: row.assignee_name ? { name: row.assignee_name, email: row.assignee_email } : null,
    creator: {
      name: row.creator_name || row.creator_email,
      email: row.creator_email,
      photoUrl: row.creator_photo_url,
    },
    taskTypes: Array.isArray(metadata.taskTypes) ? metadata.taskTypes : [],
    attachments: Array.isArray(metadata.attachments) ? metadata.attachments : [],
    project: {
      key: row.project_key,
      name: row.project_name,
      workspace: { key: row.workspace_key, name: row.workspace_name },
    },
    content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function taskReference(row: Pick<D1TaskRow, 'seq' | 'task_key'>): TaskReference {
  return { native: row.task_key, display: `T-${row.seq}`, aliases: [String(row.seq)] };
}

function principal(input: {
  id?: number | null | undefined;
  email: string | null;
  name: string | null;
  kind?: 'human' | 'agent' | null | undefined;
}): TaskPrincipal | null {
  if (!input.id && !input.email && !input.name) return null;
  const email = input.email?.trim() || null;
  const kind =
    input.kind === 'agent' || email?.toLowerCase() === tenantProfile.agent.email.toLowerCase()
      ? 'agent'
      : 'human';
  return {
    reference: input.id ? `user:${input.id}` : `email:${email ?? input.name ?? 'unknown'}`,
    kind,
    name: input.name || email || `User ${input.id}`,
    email,
  };
}

function taskRecord(row: D1TaskRow): TaskRecord {
  const metadata = parseD1Json(row.source_metadata_json) as JsonObject;
  const taskTypes = Array.isArray(metadata.taskTypes)
    ? metadata.taskTypes.filter((value): value is string => typeof value === 'string')
    : [];
  const source = row.source_system
    ? {
        system: row.source_system,
        ...(row.source_id ? { reference: row.source_id } : {}),
        ...(row.source_updated_at ? { revision: row.source_updated_at } : {}),
        ...(row.source_url ? { url: row.source_url } : {}),
        metadata,
      }
    : undefined;
  return {
    reference: taskReference(row),
    revision: String(row.version),
    title: row.title,
    description: row.description,
    status: row.status as TaskWorkflowState,
    priority: row.priority as TaskPriority | null,
    assignee: principal({
      id: row.assignee_user_id,
      email: row.assignee_email,
      name: row.assignee_name,
      kind: row.assignee_principal_type,
    }),
    createdBy: principal({
      id: row.creator_user_id,
      email: row.creator_email,
      name: row.creator_name,
      kind: row.creator_principal_type,
    }),
    dueDate: row.due_date,
    completedAt: row.completed_at,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    effort: row.effort as TaskEffort | null,
    taskTypes,
    projects: [
      {
        reference: row.project_key,
        key: row.project_key,
        name: row.project_name,
        description: row.project_description ?? null,
        workspace: {
          reference: row.workspace_key,
          key: row.workspace_key,
          name: row.workspace_name,
        },
        ...(row.project_visibility ? { visibility: row.project_visibility } : {}),
        ...(row.project_type ? { kind: row.project_type } : {}),
      },
    ],
    ...(source ? { source } : {}),
    metadata,
  };
}

function projectRole(row: D1ProjectRow): TaskProjectAccessRole {
  if (row.project_type === 'personal') return 'owner';
  if (row.is_task_admin) return 'admin';
  if (row.workspace_role === 'owner' || row.workspace_role === 'admin') {
    return row.workspace_role;
  }
  return row.member_role ?? row.workspace_role;
}

function projectView(row: D1ProjectRow): TaskProjectView {
  return {
    project: {
      reference: row.project_key,
      key: row.project_key,
      name: row.name,
      description: row.description,
      visibility: row.visibility,
      kind: row.project_type,
      workspace: {
        reference: row.workspace_key,
        key: row.workspace_key,
        name: row.workspace_name,
      },
    },
    access: {
      role: projectRole(row),
      canCreateTask: Boolean(row.can_edit_tasks),
      canEditTasks: Boolean(row.can_edit_tasks),
    },
  };
}

function publicProject(row: D1ProjectRow) {
  return {
    key: row.project_key,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    type: row.project_type,
    workspace: { key: row.workspace_key, name: row.workspace_name },
    role: projectRole(row),
    canCreateTask: Boolean(row.can_edit_tasks),
    canEditTasks: Boolean(row.can_edit_tasks),
  };
}

function historyChanges(value: string): readonly TaskFieldChange[] {
  return Object.entries(parseD1Json(value)).map(([field, change]) => {
    if (change && typeof change === 'object' && !Array.isArray(change)) {
      const sides = change as Record<string, unknown>;
      if ('before' in sides || 'after' in sides) {
        return {
          field,
          ...('before' in sides ? { previous: sides.before as JsonValue } : {}),
          ...('after' in sides ? { current: sides.after as JsonValue } : {}),
        };
      }
    }
    return { field, current: change as JsonValue };
  });
}

function commentView(
  row: D1CommentRow,
  currentUserId: number,
  canManageComments: boolean,
): TaskCommentView {
  const comment: TaskComment = {
    reference: `comment:${row.id}`,
    revision: row.updated_at,
    body: row.body,
    author: principal({
      id: row.author_user_id,
      email: row.author_email,
      name: row.author_name,
      kind: row.author_principal_type,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    editedAt: row.edited_at,
    deletedAt: null,
  };
  return {
    comment,
    access: { canDelete: row.author_user_id === currentUserId || canManageComments },
  };
}

function historyEvent(row: D1TaskEventRow): TaskHistoryEvent {
  return {
    reference: `task-event:${row.id}`,
    revision: null,
    action: row.action,
    actor: principal({
      id: row.actor_user_id,
      email: row.actor_email,
      name: row.actor_name,
      kind: row.actor_principal_type,
    }),
    changes: historyChanges(row.changes_json),
    occurredAt: row.created_at,
  };
}

function numericUserReference(reference: string) {
  const match = /^user:([1-9][0-9]*)$/.exec(reference);
  if (!match?.[1]) return null;
  const userId = Number(match[1]);
  return Number.isSafeInteger(userId) ? userId : null;
}

function emailPrincipalReference(reference: string) {
  if (!reference.startsWith('email:')) return null;
  const value = reference.slice('email:'.length).trim();
  return value || null;
}

function encodeTaskCursor(afterSequence: number) {
  const encoded = btoa(String(afterSequence))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  return `${D1_TASK_CURSOR_PREFIX}${encoded}`;
}

function decodeTaskCursor(cursor: string | undefined): number | null | undefined {
  if (cursor === undefined) return undefined;
  if (!cursor.startsWith(D1_TASK_CURSOR_PREFIX)) return null;
  const encoded = cursor
    .slice(D1_TASK_CURSOR_PREFIX.length)
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  const padding = '='.repeat((4 - (encoded.length % 4)) % 4);
  try {
    const decoded = atob(`${encoded}${padding}`);
    if (!/^[1-9][0-9]*$/.test(decoded)) return null;
    const value = Number(decoded);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function projectKey(reference: string) {
  return reference.startsWith('project:') ? reference.slice('project:'.length) : reference;
}

/**
 * Default D1 read slice. Mutation methods are intentionally absent until their
 * transactions, audit records, and notification outbox semantics move together.
 */
export class D1TaskReadBackend implements D1TaskBackendReads, D1TaskWorkspaceBackendReads {
  readonly capabilities = D1_TASK_CAPABILITIES;

  constructor(private readonly db: Env['DB']) {}

  async resolveTaskReference(reference: string, context: TaskAccessContext) {
    const userId = await this.userId(context);
    if (!userId) return { outcome: 'not-found' as const };
    const trimmed = reference.trim();
    let row = await this.db
      .prepare(
        `SELECT t.task_key, t.seq FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE t.task_key = ? AND t.archived_at IS NULL AND p.archived_at IS NULL
           AND ${D1_PROJECT_ACCESS}
         LIMIT 1`,
      )
      .bind(trimmed, userId)
      .first<Pick<D1TaskRow, 'seq' | 'task_key'>>();
    const sequence = /^(?:T-)?([1-9][0-9]*)$/i.exec(trimmed)?.[1];
    if (!row && sequence) {
      row = await this.db
        .prepare(
          `SELECT t.task_key, t.seq FROM tasks t
           JOIN projects p ON p.id = t.project_id
           WHERE t.seq = ? AND t.archived_at IS NULL AND p.archived_at IS NULL
             AND ${D1_PROJECT_ACCESS}
           LIMIT 1`,
        )
        .bind(Number(sequence), userId)
        .first<Pick<D1TaskRow, 'seq' | 'task_key'>>();
    }
    return row
      ? { outcome: 'resolved' as const, reference: taskReference(row) }
      : { outcome: 'not-found' as const };
  }

  async listTasks(query: TaskListQuery, context: TaskAccessContext): Promise<TaskPage> {
    const userId = await this.userId(context);
    if (!userId) return { tasks: [] };
    const afterSequence = decodeTaskCursor(query.cursor);
    if (afterSequence === null) return { tasks: [], nextCursor: null };
    const limit = Math.max(1, Math.min(Math.trunc(query.limit ?? 500), 500));
    const rows = await this.taskRows(query, userId, {
      limit,
      ...(afterSequence === undefined ? {} : { afterSequence }),
      lookahead: true,
    });
    const hasMore = rows.length > limit;
    const visibleRows = rows.slice(0, limit);
    const lastVisibleSequence = visibleRows.at(-1)?.seq;
    return {
      tasks: visibleRows.map(taskRecord),
      nextCursor:
        hasMore && lastVisibleSequence !== undefined ? encodeTaskCursor(lastVisibleSequence) : null,
    };
  }

  async listTasksForApi(query: D1TaskApiListQuery, context: TaskAccessContext) {
    const userId = await this.userId(context);
    if (!userId) return [];
    const rows = await this.taskRows(
      {
        view: query.view,
        search: query.search,
        project: query.project,
        sort: query.sort,
        hideAgentTasks: query.hideAgentTasks,
        limit: 500,
      },
      userId,
    );
    return rows.map((row) => publicD1Task(row));
  }

  async getTask(
    reference: string,
    options: { comments?: boolean; history?: boolean },
    context: TaskAccessContext,
  ): Promise<TaskReadResult | null> {
    const userId = await this.userId(context);
    if (!userId) return null;
    const detail = await this.taskDetail(reference, userId, options);
    if (!detail) return null;
    return {
      task: taskRecord(detail.task),
      access: { canEdit: detail.canEdit, canComment: detail.canComment },
      ...(detail.comments
        ? {
            comments: detail.comments.map((row) =>
              commentView(row, userId, detail.canManageComments),
            ),
          }
        : {}),
      ...(detail.activity ? { history: detail.activity.map(historyEvent) } : {}),
    };
  }

  async getTaskForApi(reference: string, context: TaskAccessContext) {
    const userId = await this.userId(context);
    if (!userId) return null;
    const detail = await this.taskDetail(reference, userId, {
      comments: true,
      history: true,
      historyLimit: 100,
    });
    if (!detail) return null;
    return {
      task: {
        ...publicD1Task(detail.task, true),
        canEdit: detail.canEdit,
        canComment: detail.canComment,
        comments: (detail.comments ?? []).map((row) => publicD1Comment(row, userId)),
        activity: (detail.activity ?? []).map((row) => ({
          id: row.id,
          action: row.action,
          changes: parseD1Json(row.changes_json),
          createdAt: row.created_at,
          actor: { name: row.actor_name || row.actor_email, email: row.actor_email },
        })),
      },
    };
  }

  async listProjects(context: TaskAccessContext): Promise<readonly TaskProjectView[]> {
    const userId = await this.userId(context);
    if (!userId) return [];
    return (await this.projectRows(userId)).map(projectView);
  }

  async listProjectsForApi(context: TaskAccessContext) {
    const userId = await this.userId(context);
    if (!userId) return [];
    return (await this.projectRows(userId)).map(publicProject);
  }

  async listProjectMembers(
    reference: string,
    context: TaskAccessContext,
  ): Promise<AccessLookupResult<readonly TaskProjectMember[]>> {
    const result = await this.projectMemberRows(projectKey(reference), context);
    if (!result) return { outcome: 'not-found' };
    return {
      outcome: 'found',
      value: result.map((row) => ({
        principal: principal({
          id: row.id,
          email: row.email,
          name: row.name,
          kind: row.principal_type,
        }) as TaskPrincipal,
        role: row.role,
      })),
    };
  }

  async listProjectMembersForApi(reference: string, context: TaskAccessContext) {
    const result = await this.projectMemberRows(projectKey(reference), context);
    return result?.map(({ email, name, role }) => ({ email, name, role })) ?? null;
  }

  async listProjectAssignees(
    reference: string,
    context: TaskAccessContext,
  ): Promise<AccessLookupResult<readonly TaskPrincipal[]>> {
    const result = await this.projectAssigneeRows(projectKey(reference), context);
    if (!result) return { outcome: 'not-found' };
    return {
      outcome: 'found',
      value: result.map(
        (row) =>
          principal({
            id: row.id,
            email: row.email,
            name: row.name,
            kind: row.principal_type,
          }) as TaskPrincipal,
      ),
    };
  }

  async listProjectAssigneesForApi(reference: string, context: TaskAccessContext) {
    const result = await this.projectAssigneeRows(projectKey(reference), context);
    return result?.map(({ email, name }) => ({ email, name })) ?? null;
  }

  private async userId(context: TaskAccessContext) {
    const nativeId = numericUserReference(context.identity.principal.reference);
    if (nativeId) return nativeId;
    const email = context.identity.principal.email?.trim();
    if (!email) return null;
    const user = await this.db
      .prepare(
        `SELECT id FROM users
         WHERE email = ? COLLATE NOCASE AND status = 'active'`,
      )
      .bind(email)
      .first<{ id: number }>();
    return user?.id ?? null;
  }

  private async taskRows(query: D1TaskRowQuery, userId: number, page?: D1TaskRowPage) {
    const clauses = [D1_PROJECT_ACCESS];
    const values: unknown[] = [userId];
    if (!query.includeArchived) {
      clauses.unshift('t.archived_at IS NULL', 'p.archived_at IS NULL');
    }

    if (query.project) {
      clauses.push('p.project_key = ?');
      values.push(projectKey(query.project));
    }
    if (tenantProfile.capabilities.hideAgentTasks && query.hideAgentTasks) {
      clauses.push(
        `(${D1_NORMALIZED_ASSIGNEE_EMAIL} IS NULL
          OR ${D1_NORMALIZED_ASSIGNEE_EMAIL} COLLATE NOCASE <> ?)`,
      );
      values.push(tenantProfile.agent.email);
    }
    if (query.view) {
      const viewFilter = taskViewFilter(query.view);
      clauses.push(viewFilter.sql);
      if (viewFilter.assignedToCurrentUser) values.push(userId);
    } else if (query.statuses) {
      if (query.statuses.length === 0) return [];
      clauses.push(`t.status IN (${query.statuses.map(() => '?').join(', ')})`);
      values.push(...query.statuses);
    }
    if (query.priorities) {
      if (query.priorities.length === 0) return [];
      const priorities = query.priorities.filter((value): value is TaskPriority => value !== null);
      const includesNull = query.priorities.includes(null);
      const filters: string[] = [];
      if (priorities.length > 0) {
        filters.push(`t.priority IN (${priorities.map(() => '?').join(', ')})`);
        values.push(...priorities);
      }
      if (includesNull) filters.push('t.priority IS NULL');
      clauses.push(`(${filters.join(' OR ')})`);
    }
    if (query.assignee === null) {
      clauses.push(`NOT ${D1_EFFECTIVE_ASSIGNEE_PRESENT}`);
    } else if (query.assignee !== undefined) {
      const assigneeUserId = numericUserReference(query.assignee);
      if (assigneeUserId) {
        clauses.push('t.assignee_user_id = ?');
        values.push(assigneeUserId);
      } else {
        const assigneeEmail = emailPrincipalReference(query.assignee);
        if (!assigneeEmail) return [];
        clauses.push(
          `(${D1_NORMALIZED_ASSIGNEE_EMAIL} = ? COLLATE NOCASE
            OR (
              ${D1_NORMALIZED_ASSIGNEE_EMAIL} IS NULL
              AND NULLIF(TRIM(CAST(${D1_EFFECTIVE_ASSIGNEE_NAME} AS TEXT)), '') = ? COLLATE NOCASE
            ))`,
        );
        values.push(assigneeEmail, assigneeEmail);
      }
    }
    if (query.excludeAssigneeKinds?.length) {
      const excludeAgent = query.excludeAssigneeKinds.includes('agent');
      const excludeHuman = query.excludeAssigneeKinds.includes('human');
      if (excludeAgent && excludeHuman) {
        clauses.push(`NOT ${D1_EFFECTIVE_ASSIGNEE_PRESENT}`);
      } else if (excludeAgent || excludeHuman) {
        const isAgent = `(COALESCE(u.principal_type = 'agent', 0)
          OR LOWER(COALESCE(${D1_NORMALIZED_ASSIGNEE_EMAIL}, '')) = LOWER(?))`;
        clauses.push(
          `(
            NOT ${D1_EFFECTIVE_ASSIGNEE_PRESENT}
            OR ${excludeAgent ? `NOT ${isAgent}` : isAgent}
          )`,
        );
        values.push(tenantProfile.agent.email);
      }
    }
    if (query.parent !== undefined && query.parent !== null) return [];
    if (query.tags?.length) return [];
    if (query.dueBefore) {
      clauses.push('t.due_date <= ?');
      values.push(query.dueBefore);
    }
    if (query.search) {
      clauses.push("(t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')");
      const escaped = query.search
        .replaceAll('\\', '\\\\')
        .replaceAll('%', '\\%')
        .replaceAll('_', '\\_');
      values.push(`%${escaped}%`, `%${escaped}%`);
    }
    if (page?.afterSequence !== undefined) {
      clauses.push('t.seq < ?');
      values.push(page.afterSequence);
    }

    const orderBy: Record<string, string> = {
      due_asc: 'CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date ASC, t.created_at DESC',
      due_desc:
        'CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date DESC, t.created_at DESC',
      created_desc: 't.created_at DESC, t.seq DESC',
      created_asc: 't.created_at ASC, t.seq ASC',
      owner_asc:
        'CASE WHEN assignee_name IS NULL THEN 1 ELSE 0 END, assignee_name COLLATE NOCASE ASC, t.title COLLATE NOCASE ASC',
      owner_desc:
        'CASE WHEN assignee_name IS NULL THEN 1 ELSE 0 END, assignee_name COLLATE NOCASE DESC, t.title COLLATE NOCASE ASC',
      updated_desc: 't.updated_at DESC, t.seq DESC',
      title_asc: 't.title COLLATE NOCASE ASC, t.seq DESC',
      title_desc: 't.title COLLATE NOCASE DESC, t.seq DESC',
    };
    const selectedOrder = query.sort ? orderBy[query.sort] : undefined;
    const defaultOrder = `CASE t.status WHEN 'backlog' THEN 0 WHEN 'not_started' THEN 1
           WHEN 'in_progress' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
         CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END,
         CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.updated_at DESC`;
    const limit = page?.limit ?? Math.max(1, Math.min(Math.trunc(query.limit ?? 500), 500));
    const queryLimit = page?.lookahead ? limit + 1 : limit;
    const rowOrder = page ? 't.seq DESC' : (selectedOrder ?? defaultOrder);
    return (
      await this.db
        .prepare(
          `SELECT ${D1_TASK_COLUMNS}
           FROM tasks t
           JOIN projects p ON p.id = t.project_id
           JOIN workspaces w ON w.id = p.workspace_id
           LEFT JOIN users u ON u.id = t.assignee_user_id
           JOIN users creator ON creator.id = t.created_by_user_id
           WHERE ${clauses.join(' AND ')}
           ORDER BY ${rowOrder}
           LIMIT ${queryLimit}`,
        )
        .bind(...values)
        .all<D1TaskRow>()
    ).results;
  }

  private async taskDetail(
    reference: string,
    userId: number,
    options: D1TaskDetailOptions,
  ): Promise<D1TaskDetailRows | null> {
    const task = await this.db
      .prepare(
        `SELECT ${D1_TASK_COLUMNS}, t.source_content_json
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         JOIN workspaces w ON w.id = p.workspace_id
         LEFT JOIN users u ON u.id = t.assignee_user_id
         JOIN users creator ON creator.id = t.created_by_user_id
         WHERE t.task_key = ? AND t.archived_at IS NULL AND p.archived_at IS NULL
           AND ${D1_PROJECT_ACCESS}`,
      )
      .bind(reference, userId)
      .first<D1TaskRow>();
    if (!task) return null;
    const editAccess = await this.db
      .prepare(
        `SELECT p.id, p.workspace_id, p.project_key, p.project_type, p.personal_owner_user_id
         FROM projects p
         WHERE p.project_key = ? AND p.archived_at IS NULL AND ${D1_PROJECT_EDIT_ACCESS}`,
      )
      .bind(task.project_key, userId)
      .first<{ id: number }>();
    const commentAccess = await this.db
      .prepare(
        `SELECT 1 AS allowed FROM effective_user_permissions
         WHERE user_id = ? AND permission_key = 'tasks.comment'`,
      )
      .bind(userId)
      .first<{ allowed: number }>();
    const commentManageAccess = options.comments
      ? await this.db
          .prepare(
            `SELECT 1 AS allowed FROM effective_user_permissions
             WHERE user_id = ? AND permission_key = 'tasks.manage'`,
          )
          .bind(userId)
          .first<{ allowed: number }>()
      : null;
    const comments = options.comments
      ? (
          await this.db
            .prepare(
              `SELECT c.id, c.body, c.created_at, c.updated_at, c.edited_at, c.author_user_id,
                 COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email)
                   AS author_name,
                 u.email AS author_email, u.principal_type AS author_principal_type
               FROM task_comments c JOIN users u ON u.id = c.author_user_id
               WHERE c.task_id = ? AND c.deleted_at IS NULL ORDER BY c.id`,
            )
            .bind(task.id)
            .all<D1CommentRow>()
        ).results
      : undefined;
    const activity = options.history
      ? (
          await this.db
            .prepare(
              `SELECT event.id, event.action, event.changes_json, event.created_at,
                 event.actor_user_id,
                 COALESCE(NULLIF(TRIM(actor.first_name || ' ' || actor.last_name), ''), actor.email)
                   AS actor_name,
                 actor.email AS actor_email, actor.principal_type AS actor_principal_type
               FROM task_events event JOIN users actor ON actor.id = event.actor_user_id
               WHERE event.task_id = ? ORDER BY event.id DESC${
                 options.historyLimit ? ` LIMIT ${options.historyLimit}` : ''
}`,
            )
            .bind(task.id)
            .all<D1TaskEventRow>()
        ).results
      : undefined;
    return {
      task,
      canEdit: Boolean(editAccess),
      canComment: Boolean(commentAccess?.allowed),
      canManageComments: Boolean(commentManageAccess?.allowed),
      ...(comments ? { comments } : {}),
      ...(activity ? { activity } : {}),
    };
  }

  private async projectRows(userId: number) {
    return (
      await this.db
        .prepare(
          `SELECT p.project_key, p.name, p.description, p.visibility, p.project_type,
             p.personal_owner_user_id,
             w.workspace_key, w.name AS workspace_name,
             wm.role AS workspace_role, pm.role AS member_role,
             EXISTS(
               SELECT 1 FROM effective_user_permissions admin_up
               WHERE admin_up.user_id = wm.user_id AND admin_up.permission_key = 'tasks.manage'
             ) AS is_task_admin,
             CASE WHEN
               (p.project_type = 'personal' AND p.personal_owner_user_id = wm.user_id)
               OR (p.project_type = 'shared' AND (
                 EXISTS(
                   SELECT 1 FROM effective_user_permissions shared_edit_view_up
                   WHERE shared_edit_view_up.user_id = wm.user_id
                     AND shared_edit_view_up.permission_key IN ('tasks.view', 'platform.admin')
                 ) AND (
                   wm.role IN ('owner','admin')
                   OR pm.role IN ('owner','editor')
                   OR EXISTS(
                     SELECT 1 FROM effective_user_permissions edit_up
                     WHERE edit_up.user_id = wm.user_id AND edit_up.permission_key = 'tasks.manage'
                   )
                 )
               ))
             THEN 1 ELSE 0 END AS can_edit_tasks
           FROM projects p
           JOIN workspaces w ON w.id = p.workspace_id
           JOIN workspace_members wm ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
           LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = wm.user_id
           WHERE p.archived_at IS NULL AND w.archived_at IS NULL
             AND (
               (p.project_type = 'personal' AND p.personal_owner_user_id = wm.user_id)
               OR (p.project_type = 'shared' AND (
                 EXISTS(
                   SELECT 1 FROM effective_user_permissions shared_view_up
                   WHERE shared_view_up.user_id = wm.user_id
                     AND shared_view_up.permission_key IN ('tasks.view', 'platform.admin')
                 ) AND (
                   p.visibility = 'workspace'
                   OR wm.role IN ('owner','admin')
                   OR pm.user_id IS NOT NULL
                   OR EXISTS(
                     SELECT 1 FROM effective_user_permissions access_up
                     WHERE access_up.user_id = wm.user_id AND access_up.permission_key = 'tasks.manage'
                   )
                 )
               ))
             )
           ORDER BY CASE WHEN p.project_type = 'personal' THEN 0 ELSE 1 END, w.name, p.name`,
        )
        .bind(userId)
        .all<D1ProjectRow>()
    ).results;
  }

  private async projectMemberRows(projectReference: string, context: TaskAccessContext) {
    const userId = await this.userId(context);
    if (!userId) return null;
    const project = await this.db
      .prepare(`SELECT p.id FROM projects p WHERE p.project_key = ? AND ${D1_PROJECT_ACCESS}`)
      .bind(projectReference, userId)
      .first<{ id: number }>();
    if (!project) return null;
    return (
      await this.db
        .prepare(
          `SELECT u.id, u.email,
             COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name,
             u.principal_type, pm.role
           FROM project_members pm JOIN users u ON u.id = pm.user_id
           WHERE pm.project_id = ? ORDER BY name, u.email`,
        )
        .bind(project.id)
        .all<D1ProjectMemberRow>()
    ).results;
  }

  private async projectAssigneeRows(projectReference: string, context: TaskAccessContext) {
    const userId = await this.userId(context);
    if (!userId) return null;
    const project = await this.db
      .prepare(
        `SELECT p.id, p.workspace_id, p.visibility, p.project_type, p.personal_owner_user_id
         FROM projects p WHERE p.project_key = ? AND ${D1_PROJECT_ACCESS}`,
      )
      .bind(projectReference, userId)
      .first<{
        id: number;
        workspace_id: number;
        visibility: string;
        project_type: 'shared' | 'personal';
        personal_owner_user_id: number | null;
      }>();
    if (!project) return null;
    return (
      await this.db
        .prepare(
          `SELECT u.id, u.email,
             COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name,
             u.principal_type
           FROM users u
           JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
           LEFT JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = ?
           WHERE u.status = 'active'
             AND (
               (? = 'personal' AND u.id = ?)
               OR (? = 'shared' AND (
                 ? = 'workspace' OR wm.role IN ('owner','admin') OR pm.user_id IS NOT NULL
               ))
             )
           ORDER BY name, u.email`,
        )
        .bind(
          project.workspace_id,
          project.id,
          project.project_type,
          project.personal_owner_user_id,
          project.project_type,
          project.visibility,
        )
        .all<D1ProjectAssigneeRow>()
    ).results;
  }
}
