import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import type {
  AccountPreferences,
  AssignedEventWorkItem,
  AuditFilters,
  Bootstrap,
  BulkAction,
  DeliverableStatus,
  DirectoryFilters,
  EventIntake,
  EventResponsibilityPatch,
  EventStage,
  EventWorkItemCreate,
  EventWorkItemPatch,
  TaskDetail,
  TaskPatch,
  TaskSummary,
  TaskView,
} from './types';

export type TaskFilters = {
  project?: string | undefined;
  view: TaskView;
  q?: string | undefined;
  sort?: string | undefined;
  hideAgent?: boolean | undefined;
};

export const keys = {
  bootstrap: ['bootstrap'] as const,
  projects: ['projects'] as const,
  tasks: (filters: TaskFilters) => ['tasks', filters] as const,
  task: (key: string) => ['task', key] as const,
  assignees: (projectKey: string) => ['assignees', projectKey] as const,
  members: (projectKey: string) => ['members', projectKey] as const,
  admin: ['admin'] as const,
  // Every administration query shares the ['admin'] prefix so one invalidation refreshes them all.
  adminRoles: ['admin', 'roles'] as const,
  adminDirectory: (filters: DirectoryFilters) => ['admin', 'directory', filters] as const,
  adminUser: (userId: number) => ['admin', 'user', userId] as const,
  adminAudit: (filters: AuditFilters) => ['admin', 'audit', filters] as const,
  eventTemplates: ['event-templates'] as const,
  eventOptions: ['event-options'] as const,
  assignedEventWorkItems: (filters: { q?: string; include?: string }) =>
    ['event-work-items', filters] as const,
  events: (filters: { q?: string; stage?: string }) => ['events', filters] as const,
  event: (key: string) => ['event', key] as const,
  workflowAnalytics: (days: number) => ['workflow-analytics', days] as const,
};

export function useBootstrap() {
  return useQuery({
    queryKey: keys.bootstrap,
    queryFn: api.bootstrap,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpdateAccountPreferences() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (preferences: AccountPreferences) => api.updateAccountPreferences(preferences),
    onSuccess: (preferences) => {
      void client.invalidateQueries({ queryKey: ['email-preferences'] });
      client.setQueryData<Bootstrap>(keys.bootstrap, (bootstrap) =>
        bootstrap?.user
          ? {
              ...bootstrap,
              user: {
                ...bootstrap.user,
                task_creation_mode: preferences.taskCreationMode,
                ...(preferences.notificationEmails
                  ? { notification_email_preferences: preferences.notificationEmails }
                  : {}),
                ...(preferences.notificationAlerts
                  ? {
                      task_alert_preferences: preferences.notificationAlerts,
                      notification_email_preferences: {
                        assignments: preferences.notificationAlerts.assignments.email,
                        comments: preferences.notificationAlerts.comments.email,
                        mentions: preferences.notificationAlerts.mentions.email,
                        deadlines: preferences.notificationAlerts.deadlines.email,
                      },
                    }
                  : {}),
              },
            }
          : bootstrap,
      );
    },
  });
}

export function useWorkflowAnalytics(days: number, enabled: boolean) {
  return useQuery({
    queryKey: keys.workflowAnalytics(days),
    queryFn: () => api.workflowAnalytics(days),
    enabled,
  });
}

export function useProjects(enabled: boolean) {
  return useQuery({ queryKey: keys.projects, queryFn: api.projects, enabled });
}

export function useTasks(filters: TaskFilters, enabled: boolean) {
  return useQuery({
    queryKey: keys.tasks(filters),
    queryFn: () => api.tasks(filters),
    enabled,
  });
}

export function useTask(key: string | undefined) {
  return useQuery({
    queryKey: keys.task(key ?? ''),
    queryFn: () => api.task(key as string),
    enabled: Boolean(key),
  });
}

export function useAssignees(projectKey: string | undefined) {
  return useQuery({
    queryKey: keys.assignees(projectKey ?? ''),
    queryFn: () => api.assignees(projectKey as string),
    enabled: Boolean(projectKey),
    staleTime: 5 * 60 * 1000,
  });
}

export function useProjectMembers(projectKey: string | undefined) {
  return useQuery({
    queryKey: keys.members(projectKey ?? ''),
    queryFn: () => api.members(projectKey as string),
    enabled: Boolean(projectKey),
  });
}

/**
 * Patches a task and repaints immediately.
 *
 * `optimistic` carries the display shape of the change, because the wire format
 * and the render format differ — the API takes `assigneeEmail`, the row shows
 * `assignee.name`. Callers already hold the label they picked, so they pass it
 * rather than the cache guessing.
 */
export function usePatchTask() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: ({
      key,
      patch,
    }: {
      key: string;
      patch: TaskPatch;
      optimistic?: Partial<TaskSummary>;
    }) => api.patchTask(key, patch),

    onMutate: async ({ key, patch, optimistic }) => {
      await client.cancelQueries({ queryKey: ['tasks'] });
      await client.cancelQueries({ queryKey: keys.task(key) });

      const previousLists = client.getQueriesData<TaskSummary[]>({ queryKey: ['tasks'] });
      const previousDetail = client.getQueryData<TaskDetail>(keys.task(key));

      const merge = <T extends TaskSummary>(task: T): T => ({
        ...task,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        ...(patch.effort === undefined ? {} : { effort: patch.effort }),
        ...(patch.dueDate === undefined ? {} : { dueDate: patch.dueDate }),
        ...optimistic,
      });

      // Patch in place rather than re-sorting: a row that jumps out from under
      // the pointer mid-edit is worse than one that settles on the next fetch.
      client.setQueriesData<TaskSummary[]>({ queryKey: ['tasks'] }, (tasks) =>
        tasks?.map((task) => (task.key === key ? merge(task) : task)),
      );
      client.setQueryData<TaskDetail>(keys.task(key), (task) => (task ? merge(task) : task));

      return { previousLists, previousDetail, key };
    },

    onError: (_error, _variables, context) => {
      if (!context) return;
      for (const [queryKey, data] of context.previousLists) client.setQueryData(queryKey, data);
      if (context.previousDetail)
        client.setQueryData(keys.task(context.key), context.previousDetail);
    },

    onSettled: (_data, _error, { key }) => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
      void client.invalidateQueries({ queryKey: keys.task(key) });
    },
  });
}

export function useCreateTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createTask,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useCreateComment(taskKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.createComment(taskKey, body),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.task(taskKey) });
    },
  });
}

export function useDeleteComment(taskKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (commentId: number) => api.deleteComment(taskKey, commentId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.task(taskKey) });
    },
  });
}

export function useCreateProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createProject,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.projects });
    },
  });
}

export function usePatchProject(projectKey: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      name: string;
      description: string;
      visibility: 'workspace' | 'private';
    }) => api.patchProject(projectKey as string, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.projects });
    },
  });
}

export function useUpdateProjectMember(projectKey: string | undefined) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; role: string }) =>
      api.updateProjectMember(projectKey as string, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.members(projectKey ?? '') });
    },
  });
}

export function useAdmin() {
  return useQuery({ queryKey: keys.admin, queryFn: api.admin });
}

export function useAdminRoles() {
  return useQuery({ queryKey: keys.adminRoles, queryFn: api.adminRoles });
}

export function useAdminDirectory(filters: DirectoryFilters) {
  return useQuery({
    queryKey: keys.adminDirectory(filters),
    queryFn: () => api.adminDirectory(filters),
    // Keep the previous page on screen while the next one loads, so paging does not flash.
    placeholderData: (previous) => previous,
  });
}

export function useAdminUserDetail(userId: number | null) {
  return useQuery({
    queryKey: keys.adminUser(userId ?? 0),
    queryFn: () => api.adminUserDetail(userId as number),
    enabled: userId !== null,
  });
}

export function useAdminAudit(filters: AuditFilters) {
  return useQuery({
    queryKey: keys.adminAudit(filters),
    queryFn: () => api.adminAudit(filters),
    placeholderData: (previous) => previous,
  });
}

function useAdminMutation<TInput, TOutput>(mutationFn: (input: TInput) => Promise<TOutput>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.admin });
    },
  });
}

export function useSetAdminUserRoles() {
  return useAdminMutation(({ userId, roles }: { userId: number; roles: string[] }) =>
    api.setAdminUserRoles(userId, roles),
  );
}

export function useUpdateAdminUserProfile() {
  return useAdminMutation(
    ({
      userId,
      ...input
    }: {
      userId: number;
      email?: string;
      firstName?: string;
      lastName?: string;
    }) => api.updateAdminUserProfile(userId, input),
  );
}

export function useBulkAdminUsers() {
  return useAdminMutation((input: { action: BulkAction; userIds: number[]; roles?: string[] }) =>
    api.bulkAdminUsers(input),
  );
}

export function useBulkInviteAdminUsers() {
  return useAdminMutation(api.bulkInviteAdminUsers);
}

export function useCreateAdminRole() {
  return useAdminMutation(api.createAdminRole);
}

export function useUpdateAdminRole() {
  return useAdminMutation(
    ({
      key,
      ...input
    }: {
      key: string;
      label?: string;
      description?: string;
      permissions?: string[];
    }) => api.updateAdminRole(key, input),
  );
}

export function useDeleteAdminRole() {
  return useAdminMutation(({ key, replacement }: { key: string; replacement?: string }) =>
    api.deleteAdminRole(key, replacement),
  );
}

export function useUpdateAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      userId,
      status,
      hasTaskAccess,
      isManager,
      isEventManager,
      canApproveEvents,
      isPlatformAdmin,
      email,
      firstName,
      lastName,
    }: {
      userId: number;
      status: 'active' | 'disabled';
      hasTaskAccess?: boolean;
      isManager: boolean;
      isEventManager: boolean;
      canApproveEvents: boolean;
      isPlatformAdmin?: boolean;
      email?: string;
      firstName?: string;
      lastName?: string;
    }) =>
      api.updateAdminUser(userId, {
        status,
        ...(hasTaskAccess === undefined ? {} : { hasTaskAccess }),
        isManager,
        isEventManager,
        canApproveEvents,
        ...(isPlatformAdmin === undefined ? {} : { isPlatformAdmin }),
        ...(email === undefined ? {} : { email }),
        ...(firstName === undefined ? {} : { firstName }),
        ...(lastName === undefined ? {} : { lastName }),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.admin });
    },
  });
}

export function useInviteAdminUser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.inviteAdminUser,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.admin });
      void client.invalidateQueries({ queryKey: keys.eventOptions });
    },
  });
}

export function useImpersonateAdminUser() {
  return useMutation({
    mutationFn: (userId: number) => api.impersonateAdminUser(userId),
    onSuccess: () => window.location.assign('/'),
  });
}

export function useStopAdminImpersonation() {
  return useMutation({
    mutationFn: api.stopAdminImpersonation,
    onSuccess: () => window.location.assign('/admin'),
  });
}

export function useEventTemplates(enabled: boolean) {
  return useQuery({
    queryKey: keys.eventTemplates,
    queryFn: api.eventTemplates,
    enabled,
    staleTime: 10 * 60 * 1000,
  });
}

export function useEventOptions(enabled: boolean) {
  return useQuery({
    queryKey: keys.eventOptions,
    queryFn: api.eventOptions,
    enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAssistEventIntake() {
  return useMutation({ mutationFn: api.assistEventIntake });
}

export function useAssignedEventWorkItems(
  filters: { q?: string; include?: 'open' | 'completed' },
  enabled: boolean,
) {
  return useQuery({
    queryKey: keys.assignedEventWorkItems(filters),
    queryFn: () => api.assignedEventWorkItems(filters),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useEvents(filters: { q?: string; stage?: string }, enabled: boolean) {
  return useQuery({
    queryKey: keys.events(filters),
    queryFn: () => api.events(filters),
    enabled,
    placeholderData: (previous) => previous,
  });
}

export function useEvent(key: string | undefined, enabled = true) {
  return useQuery({
    queryKey: keys.event(key ?? ''),
    queryFn: () => api.event(key as string),
    enabled: enabled && Boolean(key),
  });
}

export function usePreviewEventPlan() {
  return useMutation({ mutationFn: (input: EventIntake) => api.eventPlanPreview(input) });
}

export function useCreateEvent() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EventIntake) => api.createEvent(input),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['events'] }),
  });
}

export function usePatchEventFacts(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.patchEventFacts.bind(api, eventKey),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.event(eventKey) });
      void client.invalidateQueries({ queryKey: ['events'] });
    },
  });
}

export function usePatchEventStage(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { stage: EventStage; expectedVersion: number; reason: string }) =>
      api.patchEventStage(eventKey, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.event(eventKey) });
      void client.invalidateQueries({ queryKey: ['events'] });
    },
  });
}

export function usePatchDeliverable(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, status }: { key: string; status: DeliverableStatus }) =>
      api.patchDeliverable(eventKey, key, status),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.event(eventKey) });
      void client.invalidateQueries({ queryKey: ['events'] });
    },
  });
}

export function usePatchEventWorkItem(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ key, ...patch }: { key: string } & EventWorkItemPatch) =>
      api.patchEventWorkItem(eventKey, key, patch),

    onMutate: async ({ key, ...patch }) => {
      await client.cancelQueries({ queryKey: ['event-work-items'] });
      const previousLists = client.getQueriesData<AssignedEventWorkItem[]>({
        queryKey: ['event-work-items'],
      });
      client.setQueriesData<AssignedEventWorkItem[]>({ queryKey: ['event-work-items'] }, (items) =>
        items?.map((item) =>
          item.event_key === eventKey && item.work_item_key === key
            ? {
                ...item,
                ...(patch.status === undefined ? {} : { status: patch.status }),
                ...(patch.dueDate === undefined ? {} : { due_at: patch.dueDate }),
              }
            : item,
        ),
      );
      return { previousLists };
    },

    onError: (_error, _variables, context) => {
      if (!context) return;
      for (const [queryKey, data] of context.previousLists) client.setQueryData(queryKey, data);
    },

    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.event(eventKey) });
      void client.invalidateQueries({ queryKey: ['events'] });
      void client.invalidateQueries({ queryKey: ['event-work-items'] });
    },
  });
}

export function useCreateEventWorkItem(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: EventWorkItemCreate) => api.createEventWorkItem(eventKey, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.event(eventKey) });
      void client.invalidateQueries({ queryKey: ['events'] });
      void client.invalidateQueries({ queryKey: ['event-work-items'] });
    },
  });
}

export function useCreateCopyVersion(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createCopyVersion.bind(api, eventKey),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.event(eventKey) }),
  });
}

export function useCreateAssetVersion(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      deliverableKey,
      input,
    }: {
      deliverableKey: string;
      input: {
        url: string;
        label: string;
        storageProvider: string | null;
        providerFileId: string | null;
      };
    }) => api.createAssetVersion(eventKey, deliverableKey, input),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.event(eventKey) }),
  });
}

export function useUploadAssetVersion(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      deliverableKey,
      file,
      label,
    }: {
      deliverableKey: string;
      file: File;
      label: string;
    }) => api.uploadAssetVersion(eventKey, deliverableKey, file, label),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.event(eventKey) }),
  });
}

export function useFinalizeAssetVersion(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (assetId: number) => api.finalizeAssetVersion(eventKey, assetId),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.event(eventKey) }),
  });
}

export function useCreateEventApproval(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.createEventApproval.bind(api, eventKey),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.event(eventKey) });
      void client.invalidateQueries({ queryKey: ['events'] });
    },
  });
}

export function useCreateEventComment(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => api.createEventComment(eventKey, body),
    onSuccess: () => void client.invalidateQueries({ queryKey: keys.event(eventKey) }),
  });
}

export function useEventResponsibilityMutation(eventKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (
      input:
        | { action: 'convert' }
        | { action: 'create'; area: string }
        | { action: 'patch'; key: string; patch: EventResponsibilityPatch },
    ) =>
      input.action === 'convert'
        ? api.convertEventWorkflow(eventKey)
        : input.action === 'create'
          ? api.createEventResponsibility(eventKey, input.area)
          : api.patchEventResponsibility(eventKey, input.key, input.patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.event(eventKey) });
      void client.invalidateQueries({ queryKey: ['events'] });
      void client.invalidateQueries({ queryKey: ['event-work-items'] });
    },
  });
}

export function useEmailPreferences(enabled: boolean) {
  return useQuery({ queryKey: ['email-preferences'], queryFn: api.emailPreferences, enabled });
}
export function useEmailSettings(enabled: boolean) {
  return useQuery({ queryKey: ['email-settings'], queryFn: api.emailSettings, enabled });
}
export function useUpdateEmailSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: api.updateEmailSettings,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['email-settings'] });
      void client.invalidateQueries({ queryKey: ['email-preferences'] });
    },
  });
}
