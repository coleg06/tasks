import type {
  TaskComment as PortableTaskComment,
  TaskHistoryEvent as PortableTaskHistoryEvent,
  TaskProject as PortableTaskProject,
  TaskRecord as PortableTaskRecord,
} from '../../../shared/task-domain';
import { tenantProfile } from '../../../shared/tenant-profile';
import type {
  AccountPreferences,
  AdminData,
  AdminRolesData,
  AdminUserDetail,
  AssignedEventWorkItem,
  Assignee,
  AuditFilters,
  AuditPage,
  Bootstrap,
  BulkAction,
  DeliverableStatus,
  DirectoryFilters,
  DirectoryPage,
  EmailDeliveryPreferences,
  EventAssistDraft,
  EventAssistMessage,
  EventAssistResponse,
  EventDetail,
  EventFacts,
  EventIntake,
  EventLanguage,
  EventOptions,
  EventPlan,
  EventResponsibilityPatch,
  EventStage,
  EventSummary,
  EventTemplate,
  EventWorkItemCreate,
  EventWorkItemPatch,
  EventWorkItemStatus,
  InviteRow,
  Project,
  ProjectMember,
  TaskComment,
  TaskDetail,
  TaskPatch,
  TaskSummary,
  TaskView,
  WorkflowAnalytics,
} from './types';

type PortableTaskCommentView = {
  comment: PortableTaskComment;
  access: { canDelete: boolean };
};

type PortableTaskReadResult = {
  task: PortableTaskRecord;
  access: { canEdit: boolean; canComment: boolean };
  comments?: PortableTaskCommentView[];
  history?: PortableTaskHistoryEvent[];
};

/** Errors carry the server's machine-readable code so callers can map messages. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const messages: Record<string, string> = {
  forbidden: 'You cannot edit this project.',
  invalid_assignee: 'That assignee cannot access this project.',
  personal_project_assignee: 'Personal tasks can only be assigned to you.',
  personal_project_locked: 'Personal projects cannot be shared or changed.',
  invalid_project: 'That project is unavailable.',
  invalid_project_settings: 'Review the project settings and try again.',
  invalid_task: 'Some of those values were rejected.',
  invalid_account_preferences: 'Review your task and notification preferences.',
  invalid_email_preferences: 'Review your email limits and delivery choices.',
  invalid_email_settings: 'Choose an email limit from zero through 1,000.',
  personal_limit_exceeds_platform:
    'The platform email limit changed. Reopen Preferences and choose a lower personal limit.',
  email_disabled: 'Email notifications are disabled for this service.',
  hosted_email_required: tenantProfile.identity.hostedDomain
    ? `Use a valid @${tenantProfile.identity.hostedDomain} email address.`
    : 'Use a valid email address.',
  invalid_event: 'Review the highlighted event details and try again.',
  invalid_work_item: 'Review the event task details and try again.',
  responsibility_required: 'Choose a responsibility for this task.',
  responsibility_reason_required: 'Add a reason for a blocked or unneeded responsibility.',
  invalid_responsibility: 'Choose a responsibility belonging to this event.',
  responsibility_exists: 'This event already has that responsibility area.',
  responsibility_not_active: 'Reopen this responsibility before creating tasks.',
  event_not_ready:
    'Resolve the responsibility and deliverable blockers before marking the event ready.',
  invalid_event_assist: 'Add a short event description or answer before continuing.',
  event_assist_too_large: 'That event conversation is too long. Start a fresh guided draft.',
  invalid_owner: 'Choose an active staff account in this workspace.',
  email_in_use: 'That email already belongs to another user.',
  signed_in_email_locked: `A ${tenantProfile.identity.providerLabel}-linked email cannot be changed here.`,
  user_exists: 'That staff member already has an account.',
  inactive_user: 'Only active users can be impersonated.',
  unauthorized: 'Your session expired. Reload to sign in again.',
  asset_required: 'Choose an image or PDF to upload.',
  asset_empty: 'That file is empty.',
  asset_too_large: 'Event files must be 50 MB or smaller.',
  asset_invalid_type: 'Upload a PNG, JPEG, WebP, or PDF file.',
  asset_not_approved: 'Approve this exact revision before marking it final.',
  asset_missing: 'The stored file could not be found.',
  platform_admin_required: 'Only a platform administrator can do that.',
  role_exceeds_permissions: 'You can only give out access that you hold yourself.',
  builtin_role_locked: 'Built-in roles cannot be changed or deleted.',
  role_in_use: 'People still have this role. Choose a replacement role first.',
  invalid_replacement: 'Choose a different role to replace it.',
  role_exists: 'A role with that key already exists.',
  invalid_label: 'Give the role a name of up to 80 characters.',
  invalid_permissions: 'Choose at least one permission.',
  unknown_permission: 'One of those permissions does not exist.',
  unknown_role: 'One of those roles no longer exists. Refresh and try again.',
  last_platform_admin_required: 'At least one active platform administrator must remain.',
  cannot_remove_own_admin_access: 'You cannot remove your own administration access.',
  cannot_remove_own_platform_admin_access: 'You cannot remove your own administrator access.',
  agent_principal_protected: 'The automation account cannot be changed here.',
  granted_by_role: 'That access comes from a role. Change the person’s roles instead.',
  invalid_entries: 'Fix the highlighted rows and try again.',
};

const csrfCookie = `${tenantProfile.security.cookiePrefix}_csrf`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && typeof document !== 'undefined') {
    const csrf = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${csrfCookie}=`))
      ?.slice(csrfCookie.length + 1);
    if (csrf) headers.set('X-CSRF-Token', decodeURIComponent(csrf));
  }
  if (
    init?.body !== undefined &&
    !(init.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, { ...init, headers });

  if (response.status === 204) return undefined as T;

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const code = typeof payload.error === 'string' ? payload.error : 'request_failed';
    const firstIssue = Array.isArray(payload.issues) ? payload.issues[0] : null;
    const issueMessage =
      firstIssue && typeof firstIssue === 'object' && 'message' in firstIssue
        ? String(firstIssue.message)
        : null;
    const issuePath =
      firstIssue &&
      typeof firstIssue === 'object' &&
      'path' in firstIssue &&
      Array.isArray(firstIssue.path)
        ? firstIssue.path.map(String).join('.')
        : '';
    const issueLabels: Record<string, string> = {
      startDate: 'Event date',
      startTime: 'Start time',
      endTime: 'End time',
      ownerEmail: 'Event owner',
      channels: 'Communication outcomes',
      languages: 'Languages',
      'registration.url': 'Registration URL',
      'registration.openDate': 'Registration open date',
      'registration.closeDate': 'Registration close date',
      'registration.cost': 'Cost',
      'registration.capacity': 'Capacity',
    };
    const detailedIssue = issueMessage
      ? issuePath
        ? `${issueLabels[issuePath] ?? issuePath}: ${issueMessage}`
        : issueMessage
      : null;
    throw new ApiError(
      response.status,
      code,
      detailedIssue ?? messages[code] ?? 'That request could not be completed.',
    );
  }

  return payload as T;
}

function taskQuery(filters: {
  project?: string | undefined;
  view: TaskView;
  q?: string | undefined;
  sort?: string | undefined;
  hideAgent?: boolean | undefined;
}) {
  const parameters = new URLSearchParams({ view: filters.view });
  if (filters.project) parameters.set('project', filters.project);
  if (filters.q?.trim()) parameters.set('q', filters.q.trim());
  if (filters.sort) parameters.set('sort', filters.sort);
  if (filters.hideAgent) parameters.set('hideAgent', '1');
  return parameters.toString();
}

const portableProjectReferences = new Map<string, string>();
const portablePrincipalReferences = new Map<string, string>();
const portableTaskRevisions = new Map<string, string>();
const portableTaskProjectReferences = new Map<string, string[]>();

function portableProject(project?: PortableTaskProject): Project {
  const key = project?.key ?? tenantProfile.defaultProjectKey;
  const reference = project?.reference ?? key;
  portableProjectReferences.set(key, reference);
  return {
    key,
    name: project?.name ?? tenantProfile.defaultProjectName,
    description: project?.description ?? tenantProfile.defaultProjectDescription,
    visibility: project?.visibility ?? 'workspace',
    type: project?.kind ?? 'shared',
    workspace: {
      key: project?.workspace?.key ?? tenantProfile.workspaceKey,
      name: project?.workspace?.name ?? tenantProfile.organizationName,
    },
    role: 'editor',
    canCreateTask: true,
    canEditTasks: true,
  };
}

function portableTaskSummary(task: PortableTaskRecord): TaskSummary {
  const nativeSequence = Number(task.reference.native);
  portableTaskRevisions.set(task.reference.native, task.revision);
  const attachments = task.metadata?.attachments;
  const projects = (task.projects ?? []).map(portableProject);
  portableTaskProjectReferences.set(
    task.reference.native,
    (task.projects ?? []).map((project) => project.reference),
  );
  return {
    key: task.reference.native,
    reference: task.reference.display,
    seq: Number.isSafeInteger(nativeSequence) ? nativeSequence : 0,
    title: task.title,
    description: task.description ?? '',
    status: task.status,
    priority: task.priority,
    effort: task.effort ?? null,
    dueDate: task.dueDate,
    completedAt: task.completedAt,
    assignee: task.assignee
      ? { name: task.assignee.name, email: task.assignee.email ?? null }
      : null,
    creator: {
      name: task.createdBy?.name ?? tenantProfile.organizationName,
      email: task.createdBy?.email ?? '',
      photoUrl: null,
    },
    taskTypes: [...(task.taskTypes ?? [])],
    attachments: Array.isArray(attachments) ? [...attachments] : [],
    project: projects[0] ?? portableProject(),
    projects,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    version: Number.isSafeInteger(Number(task.revision)) ? Number(task.revision) : 1,
    revision: task.revision,
  };
}

function portableComment(view: PortableTaskCommentView): TaskComment {
  const numericReference = Number(view.comment.reference);
  return {
    id: Number.isSafeInteger(numericReference) ? numericReference : 0,
    body: view.comment.body,
    createdAt: view.comment.createdAt,
    editedAt: view.comment.editedAt ?? null,
    canDelete: view.access.canDelete,
    author: {
      name: view.comment.author?.name ?? 'Unknown',
      email: view.comment.author?.email ?? '',
    },
  };
}

function portableTaskDetail(result: PortableTaskReadResult): TaskDetail {
  return {
    ...portableTaskSummary(result.task),
    comments: (result.comments ?? []).map(portableComment),
    activity: (result.history ?? []).map((event, index) => ({
      id: Number.isSafeInteger(Number(event.reference)) ? Number(event.reference) : index + 1,
      action: event.action,
      changes: Object.fromEntries(
        event.changes.map((change) => [
          change.field,
          { before: change.previous, after: change.current },
        ]),
      ),
      createdAt: event.occurredAt,
      actor: { name: event.actor?.name ?? 'Unknown', email: event.actor?.email ?? '' },
    })),
    canEdit: result.access.canEdit,
    canComment: result.access.canComment,
  };
}

async function portableProjects(): Promise<Project[]> {
  const payload = await request<{ projects: PortableTaskProject[] }>(
    '/api/task-service/v1/projects?limit=200',
  );
  const projects = payload.projects.map(portableProject);
  return projects.length ? projects : [portableProject()];
}

async function portableAssignees(): Promise<Assignee[]> {
  const payload = await request<{
    principals: Array<{ reference: string; name: string; email?: string | null }>;
  }>(
    `/api/task-service/v1/principals?kind=${tenantProfile.agent.enabled ? 'human,agent' : 'human'}&limit=200`,
  );
  return payload.principals.flatMap((principal) => {
    if (!principal.email) return [];
    portablePrincipalReferences.set(principal.email.toLowerCase(), principal.reference);
    return [{ email: principal.email, name: principal.name }];
  });
}

async function portableTasks(filters: {
  project?: string | undefined;
  view: TaskView;
  q?: string | undefined;
  hideAgent?: boolean | undefined;
}): Promise<TaskSummary[]> {
  if (filters.project && !portableProjectReferences.has(filters.project)) await portableProjects();
  const parameters = new URLSearchParams({ limit: '200' });
  if (filters.q?.trim()) parameters.set('search', filters.q.trim());
  if (filters.project) {
    parameters.set('project', portableProjectReferences.get(filters.project) ?? filters.project);
  }
  if (filters.view === 'mine') parameters.set('assignee', 'me');
  if (filters.hideAgent) parameters.set('excludeAssigneeKind', 'agent');
  const completed = new Set(['done', 'cancelled']);
  // The all view asks for every status, so it sends no status filter at all.
  const statuses =
    filters.view === 'all'
      ? []
      : filters.view === 'completed'
        ? tenantProfile.tasks.workflow.filter((status) => completed.has(status))
        : filters.view === 'backlog'
          ? tenantProfile.tasks.workflow.filter((status) =>
              ['backlog', 'not_started', 'open'].includes(status),
            )
          : tenantProfile.tasks.workflow.filter((status) => !completed.has(status));
  if (statuses.length) parameters.set('status', statuses.join(','));

  const tasks: TaskSummary[] = [];
  for (let page = 0; page < 10; page += 1) {
    const payload = await request<{
      tasks: PortableTaskRecord[];
      nextCursor?: string | null;
    }>(`/api/task-service/v1/tasks?${parameters}`);
    tasks.push(...payload.tasks.map(portableTaskSummary));
    if (!payload.nextCursor) break;
    parameters.set('cursor', payload.nextCursor);
  }
  return tasks;
}

async function portableTask(key: string): Promise<TaskDetail> {
  const payload = await request<PortableTaskReadResult & { apiVersion: string }>(
    `/api/task-service/v1/tasks/${encodeURIComponent(key)}?comments=true&history=true`,
  );
  return portableTaskDetail(payload);
}

async function portableCreateTask(
  input: TaskPatch & { title: string; projectKey: string; mutationKey?: string },
) {
  if (!portableProjectReferences.has(input.projectKey)) await portableProjects();
  if (input.assigneeEmail && !portablePrincipalReferences.has(input.assigneeEmail.toLowerCase())) {
    await portableAssignees();
  }
  const fallbackPriority =
    tenantProfile.tasks.priorities.find((priority) => priority === 'medium') ??
    tenantProfile.tasks.priorities[0];
  const payload = await request<{
    value: PortableTaskReadResult;
  }>('/api/task-service/v1/tasks', {
    method: 'POST',
    headers: { 'Idempotency-Key': input.mutationKey ?? crypto.randomUUID() },
    body: JSON.stringify({
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? tenantProfile.tasks.workflow[0],
      priority:
        input.priority ?? (tenantProfile.tasks.allowsUnprioritized ? null : fallbackPriority),
      assignee:
        input.assigneeEmail === null
          ? null
          : input.assigneeEmail
            ? portablePrincipalReferences.get(input.assigneeEmail.toLowerCase())
            : undefined,
      dueDate: input.dueDate ?? null,
      projects: [portableProjectReferences.get(input.projectKey) ?? input.projectKey],
      ...(tenantProfile.tasks.effort.length ? { effort: input.effort ?? null } : {}),
      ...(tenantProfile.tasks.taskTypes ? { taskTypes: input.taskTypes ?? [] } : {}),
    }),
  });
  return portableTaskSummary(payload.value.task);
}

async function portablePatchTask(key: string, patch: TaskPatch) {
  if (!portableTaskRevisions.has(key)) await portableTask(key);
  if (patch.projectKey && !portableProjectReferences.has(patch.projectKey))
    await portableProjects();
  if (patch.assigneeEmail && !portablePrincipalReferences.has(patch.assigneeEmail.toLowerCase())) {
    await portableAssignees();
  }
  const mutation: Record<string, unknown> = {
    ...(patch.title === undefined ? {} : { title: patch.title }),
    ...(patch.description === undefined ? {} : { description: patch.description }),
    ...(patch.status === undefined ? {} : { status: patch.status }),
    ...(patch.priority === undefined ? {} : { priority: patch.priority }),
    ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
    ...(patch.assigneeEmail === undefined
      ? {}
      : {
          assignee:
            patch.assigneeEmail === null
              ? null
              : portablePrincipalReferences.get(patch.assigneeEmail.toLowerCase()),
        }),
    ...(patch.projectKey === undefined
      ? {}
      : {
          projects: [
            portableProjectReferences.get(patch.projectKey) ?? patch.projectKey,
            ...(portableTaskProjectReferences.get(key)?.slice(1) ?? []),
          ],
        }),
    ...(tenantProfile.tasks.effort.length && patch.effort !== undefined
      ? { effort: patch.effort }
      : {}),
    ...(tenantProfile.tasks.taskTypes && patch.taskTypes !== undefined
      ? { taskTypes: patch.taskTypes }
      : {}),
  };
  if (Object.keys(mutation).length === 0) return portableTask(key);
  const revision = portableTaskRevisions.get(key);
  if (!revision) throw new ApiError(428, 'revision_required', 'Reload this task and try again.');
  const payload = await request<{ value: PortableTaskReadResult }>(
    `/api/task-service/v1/tasks/${encodeURIComponent(key)}`,
    {
      method: 'PATCH',
      headers: { 'Idempotency-Key': crypto.randomUUID(), 'X-Task-Revision': revision },
      body: JSON.stringify(mutation),
    },
  );
  return portableTaskSummary(payload.value.task);
}

async function portableCreateComment(taskKey: string, body: string) {
  const payload = await request<{ value: PortableTaskCommentView }>(
    `/api/task-service/v1/tasks/${encodeURIComponent(taskKey)}/comments`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ body }),
    },
  );
  return portableComment(payload.value);
}

const usesPortableTasks = tenantProfile.tasks.apiMode === 'portable';

export const api = {
  bootstrap: () => request<Bootstrap>('/api/bootstrap'),

  reportClientError: (input: {
    event: 'ui.render_error' | 'ui.unhandled_error' | 'ui.unhandled_rejection';
    message: string;
    route: string;
    componentStack?: string;
  }) =>
    request<void>('/api/telemetry/client-error', {
      method: 'POST',
      body: JSON.stringify(input),
    }).catch(() => undefined),

  emailPreferences: () =>
    request<{ preferences: EmailDeliveryPreferences; settings: { perMinute: number } }>(
      '/api/account/email-preferences',
    ),
  emailSettings: () => request<{ settings: { perMinute: number } }>('/api/admin/email-settings'),
  updateEmailSettings: (perMinute: number) =>
    request<{ settings: { perMinute: number } }>('/api/admin/email-settings', {
      method: 'PATCH',
      body: JSON.stringify({ perMinute }),
    }),
  updateAccountPreferences: (preferences: AccountPreferences) =>
    request<{ preferences: AccountPreferences }>('/api/account/preferences', {
      method: 'PATCH',
      body: JSON.stringify(preferences),
    }).then((payload) => payload.preferences),

  workflowAnalytics: (days = 90) =>
    request<WorkflowAnalytics>(`/api/analytics/workflows?days=${days}`),

  projects: () =>
    usesPortableTasks
      ? portableProjects()
      : request<{ projects: Project[] }>('/api/projects').then((payload) => payload.projects),

  tasks: (filters: {
    project?: string | undefined;
    view: TaskView;
    q?: string | undefined;
    sort?: string | undefined;
    hideAgent?: boolean | undefined;
  }) =>
    usesPortableTasks
      ? portableTasks(filters)
      : request<{ tasks: TaskSummary[] }>(`/api/tasks?${taskQuery(filters)}`).then(
          (payload) => payload.tasks,
        ),

  task: (key: string) =>
    usesPortableTasks
      ? portableTask(key)
      : request<{ task: TaskDetail }>(`/api/tasks/${encodeURIComponent(key)}`).then(
          (payload) => payload.task,
        ),

  createTask: (input: TaskPatch & { title: string; projectKey: string; mutationKey?: string }) =>
    usesPortableTasks
      ? portableCreateTask(input)
      : request<{ task: TaskSummary }>('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            description: '',
            status: 'not_started',
            priority: null,
            effort: null,
            assigneeEmail: null,
            dueDate: null,
            taskTypes: [],
            ...input,
          }),
        }).then((payload) => payload.task),

  patchTask: (key: string, patch: TaskPatch) =>
    usesPortableTasks
      ? portablePatchTask(key, patch)
      : request<{ task: TaskSummary }>(`/api/tasks/${encodeURIComponent(key)}`, {
          method: 'PATCH',
          body: JSON.stringify(patch),
        }).then((payload) => payload.task),

  assignees: (projectKey: string) =>
    usesPortableTasks
      ? portableAssignees()
      : request<{ assignees: Assignee[] }>(
          `/api/projects/${encodeURIComponent(projectKey)}/assignees`,
        ).then((payload) => payload.assignees),

  members: (projectKey: string) =>
    request<{ members: ProjectMember[] }>(
      `/api/projects/${encodeURIComponent(projectKey)}/members`,
    ).then((payload) => payload.members),

  createProject: (input: { name: string; visibility: 'workspace' | 'private' }) =>
    request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((payload) => payload.project),

  patchProject: (
    projectKey: string,
    input: { name: string; description: string; visibility: 'workspace' | 'private' },
  ) =>
    request<{ project: Project }>(`/api/projects/${encodeURIComponent(projectKey)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((payload) => payload.project),

  updateProjectMember: (projectKey: string, input: { email: string; role: string }) =>
    request<{ member: ProjectMember }>(`/api/projects/${encodeURIComponent(projectKey)}/members`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),

  createComment: (taskKey: string, body: string) =>
    usesPortableTasks
      ? portableCreateComment(taskKey, body)
      : request<{ comment: TaskComment }>(`/api/tasks/${encodeURIComponent(taskKey)}/comments`, {
          method: 'POST',
          body: JSON.stringify({ body }),
        }).then((payload) => payload.comment),

  deleteComment: (taskKey: string, commentId: number) =>
    usesPortableTasks
      ? Promise.reject(
          new ApiError(405, 'mutation_unsupported', 'Comment deletion is unavailable.'),
        )
      : request<void>(`/api/tasks/${encodeURIComponent(taskKey)}/comments/${commentId}`, {
          method: 'DELETE',
        }),

  admin: () => request<AdminData>('/api/admin?users=omit'),

  inviteAdminUser: (input: {
    email: string;
    firstName: string;
    lastName: string;
    hasTaskAccess: boolean;
    isManager: boolean;
    isEventManager: boolean;
    canApproveEvents: boolean;
    isPlatformAdmin: boolean;
    roles?: string[];
  }) =>
    request<{ user: unknown; signInPath: string }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  updateAdminUser: (
    userId: number,
    input: {
      status: string;
      hasTaskAccess?: boolean;
      isManager: boolean;
      isEventManager: boolean;
      canApproveEvents: boolean;
      isPlatformAdmin?: boolean;
      email?: string;
      firstName?: string;
      lastName?: string;
    },
  ) =>
    request<{ user: unknown }>(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  adminRoles: () => request<AdminRolesData>('/api/admin/roles'),

  createAdminRole: (input: { label: string; description: string; permissions: string[] }) =>
    request<{ role: unknown }>('/api/admin/roles', { method: 'POST', body: JSON.stringify(input) }),

  updateAdminRole: (
    key: string,
    input: { label?: string; description?: string; permissions?: string[] },
  ) =>
    request<{ role: unknown }>(`/api/admin/roles/${encodeURIComponent(key)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  deleteAdminRole: (key: string, replacement?: string) =>
    request<{ ok: true; reassignedUsers: number }>(
      `/api/admin/roles/${encodeURIComponent(key)}${
        replacement ? `?replacement=${encodeURIComponent(replacement)}` : ''
      }`,
      { method: 'DELETE' },
    ),

  adminDirectory: (filters: DirectoryFilters, limit = 50) => {
    const parameters = new URLSearchParams({ limit: String(limit) });
    if (filters.q.trim()) parameters.set('q', filters.q.trim());
    if (filters.status) parameters.set('status', filters.status);
    if (filters.role) parameters.set('role', filters.role);
    if (filters.cursor) parameters.set('cursor', filters.cursor);
    return request<DirectoryPage>(`/api/admin/directory?${parameters.toString()}`);
  },

  adminUserDetail: (userId: number) => request<AdminUserDetail>(`/api/admin/users/${userId}`),

  setAdminUserRoles: (userId: number, roles: string[]) =>
    request<{ ok: true; changed: number }>(`/api/admin/users/${userId}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ roles }),
    }),

  updateAdminUserProfile: (
    userId: number,
    input: { email?: string; firstName?: string; lastName?: string },
  ) =>
    request<{ ok: true }>(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  bulkAdminUsers: (input: { action: BulkAction; userIds: number[]; roles?: string[] }) =>
    request<{ ok: true; changed: number; unchanged: number; withoutRoles: number[] }>(
      '/api/admin/users/bulk',
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ),

  bulkInviteAdminUsers: (input: {
    entries: Array<{ email: string; firstName?: string; lastName?: string }>;
    roles: string[];
    dryRun: boolean;
  }) =>
    request<{
      rows?: InviteRow[];
      valid?: number;
      created?: number;
      signInPath?: string;
    }>('/api/admin/users/bulk-invite', { method: 'POST', body: JSON.stringify(input) }),

  adminAudit: (filters: AuditFilters, limit = 50) => {
    const parameters = new URLSearchParams({ limit: String(limit) });
    for (const key of ['actor', 'target', 'action', 'from', 'to', 'cursor'] as const) {
      if (filters[key].trim()) parameters.set(key, filters[key].trim());
    }
    return request<AuditPage>(`/api/admin/audit?${parameters.toString()}`);
  },

  impersonateAdminUser: (userId: number) =>
    request<{ ok: true }>(`/api/admin/users/${userId}/impersonate`, { method: 'POST' }),

  stopAdminImpersonation: () =>
    request<{ ok: true }>('/api/admin/impersonation/stop', { method: 'POST' }),

  eventTemplates: () =>
    request<{ templates: EventTemplate[] }>('/api/event-templates').then(
      (payload) => payload.templates,
    ),

  eventOptions: () => request<EventOptions>('/api/event-options'),

  assistEventIntake: (input: { draft: EventAssistDraft; messages: EventAssistMessage[] }) =>
    request<EventAssistResponse>('/api/events/intake-assist', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  assignedEventWorkItems: (input?: { q?: string; include?: 'open' | 'completed' }) => {
    const parameters = new URLSearchParams();
    if (input?.q) parameters.set('q', input.q);
    if (input?.include === 'completed') parameters.set('include', 'completed');
    const suffix = parameters.size ? `?${parameters}` : '';
    return request<{ workItems: AssignedEventWorkItem[] }>(`/api/event-work-items${suffix}`).then(
      (payload) => payload.workItems,
    );
  },

  eventPlanPreview: (input: EventIntake) =>
    request<{ plan: EventPlan; template: { key: string; name: string; version: number } }>(
      '/api/events/plan-preview',
      { method: 'POST', body: JSON.stringify(input) },
    ),

  events: (filters?: { q?: string; stage?: string }) => {
    const parameters = new URLSearchParams();
    if (filters?.q) parameters.set('q', filters.q);
    if (filters?.stage) parameters.set('stage', filters.stage);
    const suffix = parameters.size ? `?${parameters}` : '';
    return request<{ events: EventSummary[] }>(`/api/events${suffix}`).then(
      (payload) => payload.events,
    );
  },

  event: (key: string) =>
    request<{ event: EventDetail }>(`/api/events/${encodeURIComponent(key)}`).then(
      (payload) => payload.event,
    ),

  createEvent: (input: EventIntake) =>
    request<{ event: { key: string; reference: string }; plan: EventPlan }>('/api/events', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  patchEventFacts: (
    eventKey: string,
    input: Partial<EventFacts> & { changeReason: string; expectedVersion: number },
  ) =>
    request<{ event: EventDetail }>(`/api/events/${encodeURIComponent(eventKey)}/facts`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((payload) => payload.event),

  patchEventStage: (
    eventKey: string,
    input: { stage: EventStage; expectedVersion: number; reason: string },
  ) =>
    request<{ event: EventDetail }>(`/api/events/${encodeURIComponent(eventKey)}/stage`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((payload) => payload.event),

  patchDeliverable: (eventKey: string, deliverableKey: string, status: DeliverableStatus) =>
    request<{ deliverable: { key: string; status: DeliverableStatus } }>(
      `/api/events/${encodeURIComponent(eventKey)}/deliverables/${encodeURIComponent(deliverableKey)}`,
      { method: 'PATCH', body: JSON.stringify({ status }) },
    ),

  patchEventWorkItem: (eventKey: string, workItemKey: string, input: EventWorkItemPatch) =>
    request<{ workItem: { key: string; status: EventWorkItemStatus } }>(
      `/api/events/${encodeURIComponent(eventKey)}/work-items/${encodeURIComponent(workItemKey)}`,
      { method: 'PATCH', body: JSON.stringify(input) },
    ),

  createEventResponsibility: (eventKey: string, area: string) =>
    request(`/api/events/${encodeURIComponent(eventKey)}/responsibilities`, {
      method: 'POST',
      body: JSON.stringify({ area }),
    }),
  patchEventResponsibility: (eventKey: string, key: string, input: EventResponsibilityPatch) =>
    request(
      `/api/events/${encodeURIComponent(eventKey)}/responsibilities/${encodeURIComponent(key)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    ),
  convertEventWorkflow: (eventKey: string) =>
    request(`/api/events/${encodeURIComponent(eventKey)}/responsibility-workflow`, {
      method: 'POST',
    }),
  createEventWorkItem: (eventKey: string, input: EventWorkItemCreate) =>
    request<{ workItem: { key: string; status: EventWorkItemStatus } }>(
      `/api/events/${encodeURIComponent(eventKey)}/work-items`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  createCopyVersion: (
    eventKey: string,
    input: {
      purpose: string;
      language: EventLanguage;
      body: string;
      authorType?: 'human' | 'ai_draft';
      sourceCopyVersionId?: number | null;
    },
  ) =>
    request<{ copyVersion: { id: number; variantId: number; version: number } }>(
      `/api/events/${encodeURIComponent(eventKey)}/copy-versions`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  createAssetVersion: (
    eventKey: string,
    deliverableKey: string,
    input: {
      url: string;
      label: string;
      storageProvider: string | null;
      providerFileId: string | null;
    },
  ) =>
    request<{ assetVersion: { deliverableKey: string; version: number } }>(
      `/api/events/${encodeURIComponent(eventKey)}/deliverables/${encodeURIComponent(deliverableKey)}/assets`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  uploadAssetVersion: (eventKey: string, deliverableKey: string, file: File, label: string) => {
    const body = new FormData();
    body.set('file', file);
    body.set('label', label);
    return request<{
      assetVersion: { id: number; deliverableKey: string; version: number; url: string };
    }>(
      `/api/events/${encodeURIComponent(eventKey)}/deliverables/${encodeURIComponent(deliverableKey)}/assets/upload`,
      { method: 'POST', body },
    ).then((payload) => payload.assetVersion);
  },

  finalizeAssetVersion: (eventKey: string, assetId: number) =>
    request<{
      asset: {
        id: number;
        version: number;
        isFinal: true;
        driveDeliveryStatus: string;
        driveWebViewLink: string | null;
      };
    }>(`/api/events/${encodeURIComponent(eventKey)}/assets/${assetId}/finalize`, {
      method: 'POST',
    }).then((payload) => payload.asset),

  createEventApproval: (
    eventKey: string,
    input: {
      subjectType: 'copy' | 'asset' | 'deliverable' | 'event';
      subjectId: number;
      subjectVersion: number;
      scope:
        | 'english_copy'
        | 'translation'
        | 'design'
        | 'publication'
        | 'event_facts'
        | 'event_ready';
      decision: 'approved' | 'changes_requested';
      comment: string;
    },
  ) =>
    request<{ approval: { decision: string } }>(
      `/api/events/${encodeURIComponent(eventKey)}/approvals`,
      { method: 'POST', body: JSON.stringify(input) },
    ),

  createEventComment: (eventKey: string, body: string) =>
    request<{ comment: { id: number; body: string } }>(
      `/api/events/${encodeURIComponent(eventKey)}/comments`,
      { method: 'POST', body: JSON.stringify({ body }) },
    ),
};
