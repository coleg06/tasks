/**
 * Backend-owned identifier. Consumers may compare or pass this value back to
 * an adapter, but must not infer a format, sequence, or storage engine from it.
 */
export type OpaqueReference = string;

/**
 * Backend-owned concurrency token. It may be a version, timestamp, ETag, or
 * another adapter-defined value and must be treated as opaque by consumers.
 */
export type OpaqueRevision = string;

export type IsoTimestamp = string;
export type IsoDate = string;

export type JsonPrimitive = boolean | number | string | null;
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

export type TaskReference = {
  /** The backend's stable native identifier. */
  readonly native: OpaqueReference;
  /** The preferred human-facing reference, such as T-42 or TASK-42. */
  readonly display: string;
  /** Every additional reference that must continue to resolve to this task. */
  readonly aliases: readonly string[];
};

export const TASK_PRINCIPAL_KINDS = ['human', 'agent', 'system'] as const;
export type TaskPrincipalKind = (typeof TASK_PRINCIPAL_KINDS)[number];

export type TaskPrincipal = {
  readonly reference: OpaqueReference;
  readonly kind: TaskPrincipalKind;
  readonly name: string;
  readonly email?: string | null;
};

/** The lossless union of the task workflow states supported by current adapters. */
export const TASK_WORKFLOW_STATES = [
  'backlog',
  'not_started',
  'open',
  'in_progress',
  'blocked',
  'review',
  'done',
  'cancelled',
] as const;
export type TaskWorkflowState = (typeof TASK_WORKFLOW_STATES)[number];

/** The lossless union of priority values; an unprioritized task uses null. */
export const TASK_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_EFFORTS = ['small', 'medium', 'large'] as const;
export type TaskEffort = (typeof TASK_EFFORTS)[number];

export const TASK_DEPENDENCY_KINDS = ['blocks', 'related', 'subtask'] as const;
export type TaskDependencyKind = (typeof TASK_DEPENDENCY_KINDS)[number];

export type TaskDependency = {
  readonly task: TaskReference;
  readonly kind: TaskDependencyKind;
  /** Preserves which side of the source dependency row the current task occupies. */
  readonly direction: 'outbound' | 'inbound';
};

export type TaskWorkspace = {
  readonly reference: OpaqueReference;
  readonly key: string;
  readonly name: string;
};

export type TaskProject = {
  readonly reference: OpaqueReference;
  readonly key: string;
  readonly name: string;
  readonly description?: string | null;
  readonly workspace?: TaskWorkspace | null;
  readonly visibility?: 'workspace' | 'private';
  readonly kind?: 'shared' | 'personal';
  readonly archivedAt?: IsoTimestamp | null;
};

export const TASK_PROJECT_MEMBER_ROLES = ['owner', 'editor', 'viewer'] as const;
export type TaskProjectMemberRole = (typeof TASK_PROJECT_MEMBER_ROLES)[number];

export type TaskProjectMember = {
  readonly principal: TaskPrincipal;
  readonly role: TaskProjectMemberRole;
};

export type TaskSprintMembership = {
  readonly reference: OpaqueReference;
  readonly key: string;
  readonly name: string;
  readonly role?: 'committed' | 'carryover' | 'stretch';
  readonly status?: 'active' | 'closed';
  readonly startDate?: IsoDate | null;
  readonly endDate?: IsoDate | null;
};

export type SourceAttribution = {
  readonly system: string;
  readonly reference?: OpaqueReference;
  readonly revision?: OpaqueRevision;
  readonly url?: string;
  readonly metadata?: JsonObject;
};

export type TaskComment = {
  /** Null only when the source does not expose a stable comment identifier. */
  readonly reference: OpaqueReference | null;
  readonly revision: OpaqueRevision | null;
  readonly body: string;
  readonly author: TaskPrincipal | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt?: IsoTimestamp;
  readonly editedAt?: IsoTimestamp | null;
  readonly deletedAt?: IsoTimestamp | null;
  readonly source?: SourceAttribution;
};

export type TaskFieldChange = {
  readonly field: string;
  /** Omitted means the source did not expose that side; null is an exposed null value. */
  readonly previous?: JsonValue;
  readonly current?: JsonValue;
};

export type TaskHistoryEvent = {
  /** Null only when the source does not expose a stable event identifier. */
  readonly reference: OpaqueReference | null;
  readonly revision: OpaqueRevision | null;
  readonly action: string;
  readonly actor: TaskPrincipal | null;
  readonly changes: readonly TaskFieldChange[];
  readonly occurredAt: IsoTimestamp;
  readonly source?: SourceAttribution;
};

/**
 * A normalized task record. Optional product fields distinguish an unsupported
 * or intentionally unloaded feature from a loaded field whose value is null.
 */
export type TaskRecord = {
  readonly reference: TaskReference;
  readonly revision: OpaqueRevision;
  readonly title: string;
  readonly description: string | null;
  readonly status: TaskWorkflowState;
  readonly priority: TaskPriority | null;
  readonly assignee: TaskPrincipal | null;
  readonly createdBy: TaskPrincipal | null;
  readonly dueDate: IsoDate | null;
  readonly completedAt: IsoTimestamp | null;
  readonly archivedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly effort?: TaskEffort | null;
  readonly taskTypes?: readonly string[];
  readonly tags?: readonly string[];
  readonly parent?: TaskReference | null;
  readonly dependencies?: readonly TaskDependency[];
  readonly sprints?: readonly TaskSprintMembership[];
  /**
   * Project memberships. A backend may supply zero, one, or several (for example project-tag
   * memberships), so adapters must never collapse this to one value.
   */
  readonly projects?: readonly TaskProject[];
  readonly source?: SourceAttribution;
  readonly metadata?: JsonObject;
};

/** Features and vocabulary that a task backend can represent without translation loss. */
export type TaskDomainCapabilities = {
  readonly workflow: readonly TaskWorkflowState[];
  readonly priorities: readonly TaskPriority[];
  readonly allowsUnprioritized: boolean;
  readonly principalKinds: readonly TaskPrincipalKind[];
  readonly effort: boolean;
  readonly taskTypes: boolean;
  readonly tags: boolean;
  readonly parentTasks: boolean;
  readonly dependencies: boolean;
  readonly sprints: boolean;
  readonly projectCardinality: 'none' | 'single' | 'multiple';
  readonly comments: boolean;
  readonly history: boolean;
  readonly optimisticConcurrency: boolean;
  readonly durableIdempotency: boolean;
};

type TaskNotificationIntentBase = {
  /** Reference of the durable outbox reservation created with the mutation. */
  readonly reference: OpaqueReference;
  readonly deduplicationKey: string;
  readonly task: TaskReference;
  readonly taskRevision: OpaqueRevision;
  readonly recipient: TaskPrincipal;
  readonly actor: TaskPrincipal | null;
  readonly occurredAt: IsoTimestamp;
};

export type TaskNotificationIntent =
  | (TaskNotificationIntentBase & {
      readonly kind: 'assignment';
      readonly previousAssignee?: TaskPrincipal | null;
    })
  | (TaskNotificationIntentBase & {
      readonly kind: 'comment';
      readonly comment: TaskComment;
    })
  | (TaskNotificationIntentBase & {
      readonly kind: 'mention';
      readonly comment: TaskComment;
    })
  | (TaskNotificationIntentBase & {
      readonly kind: 'deadline';
      readonly dueDate: IsoDate;
    });
