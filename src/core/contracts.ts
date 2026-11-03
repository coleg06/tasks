import type {
  IsoDate,
  IsoTimestamp,
  JsonObject,
  JsonValue,
  OpaqueReference,
  OpaqueRevision,
  TaskComment,
  TaskDependency,
  TaskDomainCapabilities,
  TaskEffort,
  TaskHistoryEvent,
  TaskNotificationIntent,
  TaskPrincipal,
  TaskPrincipalKind,
  TaskPriority,
  TaskProject,
  TaskProjectMember,
  TaskProjectMemberRole,
  TaskRecord,
  TaskReference,
  TaskSprintMembership,
  TaskWorkflowState,
} from '../../shared/task-domain';

export type ResolvedIdentity = {
  /** Effective principal used for authorization. */
  readonly principal: TaskPrincipal;
  readonly permissions: readonly string[];
  /** Credential owner when it delegated authority to the effective principal. */
  readonly delegatedBy?: TaskPrincipal;
  readonly expiresAt?: IsoTimestamp | null;
};

/** The adapter selects its own credential/evidence type; the core has no HTTP dependency. */
export interface IdentityProvider<TIdentityInput = unknown> {
  resolve(input: TIdentityInput): Promise<ResolvedIdentity | null>;
}

export type TaskAccessContext = {
  readonly identity: ResolvedIdentity;
};

export type TaskMutationContext = TaskAccessContext & {
  /**
   * Principal recorded in the immutable application audit. Task history and
   * notification attribution use identity.principal, the effective subject.
   */
  readonly auditPrincipal: TaskPrincipal;
  readonly requestId: string;
  /** Required only by entry points that promise idempotent replay. */
  readonly idempotencyKey?: string;
  /** Present only for mutations protected by optimistic concurrency. */
  readonly expectedRevision?: OpaqueRevision;
};

export type TaskAccessDecisions = {
  readonly canEdit: boolean;
  readonly canComment: boolean;
};

export type TaskCommentAccessDecisions = {
  readonly canDelete: boolean;
};

export type TaskProjectAccessRole = TaskProjectMemberRole | 'admin' | 'member';

export type TaskProjectAccessDecisions = {
  readonly role: TaskProjectAccessRole;
  readonly canCreateTask: boolean;
  readonly canEditTasks: boolean;
};

export type TaskCommentView = {
  readonly comment: TaskComment;
  readonly access: TaskCommentAccessDecisions;
};

export type TaskReadResult = {
  readonly task: TaskRecord;
  readonly access: TaskAccessDecisions;
  /** Omitted when comments were not requested. */
  readonly comments?: readonly TaskCommentView[];
  /** Omitted when history was not requested. */
  readonly history?: readonly TaskHistoryEvent[];
};

export type TaskProjectView = {
  readonly project: TaskProject;
  readonly access: TaskProjectAccessDecisions;
};

export type TaskReferenceResolution =
  | { readonly outcome: 'resolved'; readonly reference: TaskReference }
  | { readonly outcome: 'not-found' };

export type TaskListQuery = {
  readonly search?: string;
  readonly statuses?: readonly TaskWorkflowState[];
  readonly priorities?: readonly (TaskPriority | null)[];
  /** Null selects unassigned tasks; omission does not filter by assignee. */
  readonly assignee?: OpaqueReference | null;
  readonly excludeAssigneeKinds?: readonly TaskPrincipalKind[];
  readonly project?: OpaqueReference;
  readonly tags?: readonly string[];
  /** Null selects top-level tasks; omission does not filter by parent. */
  readonly parent?: OpaqueReference | null;
  readonly dueBefore?: IsoDate;
  readonly includeArchived?: boolean;
  readonly cursor?: OpaqueReference;
  readonly limit?: number;
};

export type TaskPage = {
  readonly tasks: readonly TaskRecord[];
  readonly total?: number;
  readonly nextCursor?: OpaqueReference | null;
};

export type TaskDirectoryQuery = {
  readonly cursor?: OpaqueReference;
  readonly limit?: number;
};

export type TaskPrincipalDirectoryQuery = TaskDirectoryQuery & {
  readonly kinds?: readonly TaskPrincipalKind[];
  readonly email?: string;
};

export type TaskDirectoryPage<TValue> = {
  readonly values: readonly TValue[];
  readonly total?: number;
  readonly nextCursor?: OpaqueReference | null;
};

/** Optional read-only directories used by portable browser and portal clients. */
export interface TaskDirectoryBackend {
  listTaskPrincipals(
    query: TaskPrincipalDirectoryQuery,
    context: TaskAccessContext,
  ): Promise<TaskDirectoryPage<TaskPrincipal>>;
  listTaskProjects(
    query: TaskDirectoryQuery,
    context: TaskAccessContext,
  ): Promise<TaskDirectoryPage<TaskProject>>;
}

export type TaskGetOptions = {
  readonly comments?: boolean;
  readonly history?: boolean;
};

export type TaskCreateInput = {
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskWorkflowState;
  readonly priority: TaskPriority | null;
  readonly assignee?: OpaqueReference | null;
  readonly dueDate?: IsoDate | null;
  readonly effort?: TaskEffort | null;
  readonly taskTypes?: readonly string[];
  readonly tags?: readonly string[];
  readonly parent?: OpaqueReference | null;
  readonly dependencies?: readonly TaskDependency[];
  readonly sprints?: readonly TaskSprintMembership[];
  readonly projects?: readonly OpaqueReference[];
  readonly metadata?: JsonObject;
};

/** Omission means unchanged; null explicitly clears a nullable field. */
export type TaskPatch = {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: TaskWorkflowState;
  readonly priority?: TaskPriority | null;
  readonly assignee?: OpaqueReference | null;
  readonly dueDate?: IsoDate | null;
  readonly effort?: TaskEffort | null;
  readonly taskTypes?: readonly string[];
  readonly tags?: readonly string[];
  readonly parent?: OpaqueReference | null;
  readonly dependencies?: readonly TaskDependency[];
  readonly sprints?: readonly TaskSprintMembership[];
  readonly projects?: readonly OpaqueReference[];
  readonly archived?: boolean;
  readonly metadata?: JsonObject;
};

export type MutationRejection =
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'forbidden' }
  | { readonly outcome: 'invalid-assignee'; readonly assignee?: OpaqueReference | null }
  | { readonly outcome: 'invariant'; readonly invariant: string };

export type OptimisticConflict<TCurrent> = {
  readonly outcome: 'conflict';
  readonly current: TCurrent;
};

/**
 * Notification intents on a successful result have already been durably reserved in
 * the same atomic commit as the domain mutation and its audit record. An adapter must
 * not perform notification transport inside that transaction.
 */
export type MutationSuccess<TValue, TOutcome extends string> = {
  readonly outcome: TOutcome;
  readonly value: TValue;
  readonly notificationIntents: readonly TaskNotificationIntent[];
};

export type CreateMutationOutcome<TValue> =
  | MutationSuccess<TValue, 'created' | 'replayed'>
  | MutationRejection;

export type UpdateMutationOutcome<TValue> =
  | MutationSuccess<TValue, 'updated' | 'unchanged'>
  | OptimisticConflict<TValue>
  | MutationRejection;

export type UpsertMutationOutcome<TValue> =
  | MutationSuccess<TValue, 'created' | 'replayed' | 'updated' | 'unchanged'>
  | MutationRejection;

export type DeleteMutationOutcome<TValue> = MutationSuccess<TValue, 'deleted'> | MutationRejection;

/**
 * Portable task persistence seam. Implementations own authorization-aware reads,
 * source-native write verification, audit records, and atomic notification intents.
 */
export interface TaskReadBackend {
  readonly capabilities: TaskDomainCapabilities;
  resolveTaskReference(
    reference: string,
    context: TaskAccessContext,
  ): Promise<TaskReferenceResolution>;
  listTasks(query: TaskListQuery, context: TaskAccessContext): Promise<TaskPage>;
  getTask(
    reference: OpaqueReference,
    options: TaskGetOptions,
    context: TaskAccessContext,
  ): Promise<TaskReadResult | null>;
}

export interface TaskBackend extends TaskReadBackend {
  createTask(
    input: TaskCreateInput,
    context: TaskMutationContext,
  ): Promise<CreateMutationOutcome<TaskReadResult>>;
  updateTask(
    reference: OpaqueReference,
    patch: TaskPatch,
    context: TaskMutationContext,
  ): Promise<UpdateMutationOutcome<TaskReadResult>>;
  addComment(
    reference: OpaqueReference,
    body: string,
    context: TaskMutationContext,
  ): Promise<CreateMutationOutcome<TaskCommentView>>;
  deleteComment(
    taskReference: OpaqueReference,
    commentReference: OpaqueReference,
    context: TaskMutationContext,
  ): Promise<DeleteMutationOutcome<OpaqueReference>>;
}

export type TaskProjectCreateInput = {
  readonly workspace?: OpaqueReference;
  readonly name: string;
  readonly description: string;
  readonly visibility: 'workspace' | 'private';
};

export type TaskProjectPatch = {
  readonly name?: string;
  readonly description?: string;
  readonly visibility?: 'workspace' | 'private';
};

export type TaskProjectMemberInput = {
  readonly principalReference: OpaqueReference;
  readonly role: TaskProjectMemberRole;
};

export type AccessLookupResult<TValue> =
  | { readonly outcome: 'found'; readonly value: TValue }
  | { readonly outcome: 'not-found' }
  | { readonly outcome: 'forbidden' };

/** Optional extension for deployments that expose shared workspace administration. */
export interface TaskWorkspaceBackend {
  listProjects(context: TaskAccessContext): Promise<readonly TaskProjectView[]>;
  createProject(
    input: TaskProjectCreateInput,
    context: TaskMutationContext,
  ): Promise<CreateMutationOutcome<TaskProjectView>>;
  updateProject(
    reference: OpaqueReference,
    patch: TaskProjectPatch,
    context: TaskMutationContext,
  ): Promise<UpdateMutationOutcome<TaskProjectView>>;
  listProjectMembers(
    reference: OpaqueReference,
    context: TaskAccessContext,
  ): Promise<AccessLookupResult<readonly TaskProjectMember[]>>;
  upsertProjectMember(
    reference: OpaqueReference,
    input: TaskProjectMemberInput,
    context: TaskMutationContext,
  ): Promise<UpsertMutationOutcome<TaskProjectMember>>;
  listProjectAssignees(
    reference: OpaqueReference,
    context: TaskAccessContext,
  ): Promise<AccessLookupResult<readonly TaskPrincipal[]>>;
}

/** Delivery happens only after the mutation transaction commits. */
export interface NotificationProvider {
  publish(intent: TaskNotificationIntent): Promise<void>;
}

export type IdempotencyClaim = {
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly expiresAt?: IsoTimestamp;
};

export type IdempotencyBeginResult<TResult = JsonValue> =
  | { readonly state: 'acquired' }
  | { readonly state: 'replay'; readonly result: TResult }
  | { readonly state: 'conflict' }
  | { readonly state: 'uncertain' };

/** begin must atomically acquire a new claim or report the durable prior state. */
export interface IdempotencyStore<TResult = JsonValue> {
  begin(claim: IdempotencyClaim): Promise<IdempotencyBeginResult<TResult>>;
  complete(claim: IdempotencyClaim, result: TResult): Promise<void>;
  markUncertain(claim: IdempotencyClaim): Promise<void>;
}

/** Asset request and result types are selected by the hosting adapter. */
export interface AssetProvider<TAssetRequest = unknown, TAssetResult = unknown> {
  getAsset(request: TAssetRequest): Promise<TAssetResult | null>;
}

export type ReadinessCheckResult = {
  readonly ready: boolean;
  /** Safe operational detail only; implementations must not include secrets. */
  readonly detail?: string;
};

export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<ReadinessCheckResult>;
}

export type ReadinessReport = {
  readonly ready: boolean;
  readonly checkedAt: IsoTimestamp;
  readonly checks: readonly (ReadinessCheckResult & { readonly name: string })[];
};

export interface ReadinessProvider {
  checkReadiness(): Promise<ReadinessReport>;
}
