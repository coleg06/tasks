import type { EmailDeliveryPreferences } from '../../../shared/email-delivery';

export type { EmailDeliveryPreferences } from '../../../shared/email-delivery';

import type { RuntimeFeatures } from '../../../shared/runtime-features';
import type {
  TaskEffort as PortableTaskEffort,
  TaskPriority as PortableTaskPriority,
  TaskWorkflowState,
} from '../../../shared/task-domain';
import { tenantProfile } from '../../../shared/tenant-profile';

export type TaskStatus = TaskWorkflowState;
export type TaskPriority = PortableTaskPriority;
export type TaskEffort = PortableTaskEffort;
export type TaskView = 'open' | 'mine' | 'backlog' | 'completed';

export type Identity = {
  id: number;
  email: string;
  first_name: string;
  last_name: string;
  photo_url: string | null;
  task_creation_mode: TaskCreationMode;
  notification_email_preferences: NotificationEmailPreferences;
  task_alert_preferences: TaskAlertPreferences;
};

export type TaskCreationMode = 'guided' | 'quick';
export type NotificationEmailPreferences = {
  assignments: boolean;
  comments: boolean;
  mentions: boolean;
  deadlines: boolean;
};

export type TaskAlertChannelPreferences = { email: boolean; inApp: boolean; push: boolean };
export type TaskAlertPreferences = {
  assignments: TaskAlertChannelPreferences;
  comments: TaskAlertChannelPreferences;
  mentions: TaskAlertChannelPreferences;
  deadlines: TaskAlertChannelPreferences;
};

export type AccountPreferences = {
  taskCreationMode: TaskCreationMode;
  notificationEmails?: NotificationEmailPreferences;
  notificationAlerts?: TaskAlertPreferences;
  emailDelivery?: EmailDeliveryPreferences;
};

export type Bootstrap = {
  authConfigured: boolean;
  features: RuntimeFeatures;
  permissions: string[];
  /** Deployed release identifier (a commit SHA, or `local`). Not secret; also on `/healthz`. */
  release?: string;
  user: Identity | null;
  impersonation?: { actor: Identity } | null;
};

export type Project = {
  key: string;
  name: string;
  description: string;
  visibility: 'workspace' | 'private';
  type: 'shared' | 'personal';
  workspace: { key: string; name: string };
  role: string;
  canCreateTask: boolean;
  canEditTasks: boolean;
};

export type ProjectMember = {
  email: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
};

export type Assignee = { email: string; name: string };

export type TaskComment = {
  id: number;
  body: string;
  createdAt: string;
  editedAt: string | null;
  canDelete: boolean;
  author: { name: string; email: string };
};

export type TaskActivity = {
  id: number;
  action: string;
  changes: Record<string, unknown>;
  createdAt: string;
  actor: { name: string; email: string };
};

export type TaskSummary = {
  key: string;
  /** Human reference such as "T-142". `key` is a storage identifier. */
  reference: string;
  seq: number;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority | null;
  effort: TaskEffort | null;
  dueDate: string | null;
  completedAt: string | null;
  assignee: { name: string; email: string | null } | null;
  creator: { name: string; email: string; photoUrl: string | null };
  taskTypes: string[];
  attachments: unknown[];
  project: { key: string; name: string; workspace: { key: string; name: string } };
  /** All source memberships; `project` remains the primary legacy display value. */
  projects?: Project[];
  createdAt: string;
  updatedAt: string;
  version: number;
  /** Opaque source concurrency token; present for portable task APIs. */
  revision?: string;
};

export type TaskDetail = TaskSummary & {
  content?: { plainText?: string; plain_text?: string; markdown?: string };
  comments: TaskComment[];
  activity: TaskActivity[];
  canEdit: boolean;
  canComment: boolean;
};

/** Fields the PATCH endpoint accepts. Every key is optional — the server merges. */
export type TaskPatch = {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority | null;
  effort?: TaskEffort | null;
  assigneeEmail?: string | null;
  dueDate?: string | null;
  projectKey?: string;
  taskTypes?: string[];
};

export const statusLabels: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  not_started: 'Not started',
  open: 'Open',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const statusOrder: TaskStatus[] = [...tenantProfile.tasks.workflow];

export const priorityLabels: Record<TaskPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const effortLabels: Record<TaskEffort, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

export const viewLabels: Record<TaskView, string> = {
  open: 'All Open Tasks',
  mine: 'My Tasks',
  backlog: 'Backlog',
  completed: 'Completed',
};

export type AdminUser = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  photoUrl: string | null;
  hasSignedIn: boolean;
  createdAt: string;
  status: 'active' | 'disabled';
  lastSeenAt: string | null;
  permissions: string[];
  roles?: string[];
};

export type AdminPermission = { key: string; label: string; description: string };
export type AdminPermissionArea = { area: string; label: string; permissions: AdminPermission[] };

export type AdminRole = {
  key: string;
  label: string;
  description: string;
  builtin: boolean;
  permissions: string[];
  /** The role contains platform.admin and therefore every permission. */
  grantsAll: boolean;
  userCount: number;
  /** The signed-in administrator may assign it (they hold everything it confers). */
  assignable: boolean;
};

export type AdminRolesData = {
  roles: AdminRole[];
  catalog: AdminPermissionArea[];
  canManageRoles: boolean;
};

export type DirectoryUser = {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  name: string;
  photoUrl: string | null;
  hasSignedIn: boolean;
  status: 'active' | 'disabled';
  principalType: 'human' | 'agent';
  lastSeenAt: string | null;
  createdAt: string;
  roles: string[];
  isPlatformAdmin: boolean;
  isManager: boolean;
};

export type DirectoryFilters = {
  q: string;
  status: '' | 'active' | 'disabled';
  role: string;
  cursor: string;
};

export type DirectoryPage = {
  users: DirectoryUser[];
  total: number;
  nextCursor: string | null;
};

export type PermissionSource =
  | { type: 'direct' }
  | { type: 'role'; role: string; label: string }
  | { type: 'platform_admin' };

export type AdminUserDetail = {
  user: {
    id: number;
    email: string;
    firstName: string;
    lastName: string;
    name: string;
    photoUrl: string | null;
    hasSignedIn: boolean;
    status: 'active' | 'disabled';
    principalType: 'human' | 'agent';
    lastSeenAt: string | null;
    createdAt: string;
  };
  roles: Array<{
    key: string;
    label: string;
    grantedAt: string;
    grantedBy: { id: number; name: string | null } | null;
  }>;
  directPermissions: string[];
  effectivePermissions: Array<{ key: string; label: string; sources: PermissionSource[] }>;
  isPlatformAdmin: boolean;
  projects: Array<{ key: string; name: string; role: string }>;
};

export type BulkAction = 'add_roles' | 'remove_roles' | 'set_roles' | 'disable' | 'enable';

export type InviteRowStatus = 'ok' | 'invalid_email' | 'duplicate' | 'exists';
export type InviteRow = {
  index: number;
  email: string;
  firstName: string;
  lastName: string;
  status: InviteRowStatus;
};

export type AuditFilters = {
  actor: string;
  target: string;
  action: string;
  from: string;
  to: string;
  cursor: string;
};

export type AuditEvent = {
  id: number;
  entityType: string;
  entityKey: string;
  action: string;
  changes: Record<string, unknown>;
  /** True when the details are hidden because they may belong to a private personal project. */
  redacted?: boolean;
  requestId: string | null;
  createdAt: string;
  actor: { id: number | null; name: string; email: string | null };
};

export type AuditPage = { events: AuditEvent[]; nextCursor: number | null; actions?: string[] };

export type AdminData = {
  stats: { users: number; projects: number; tasks: number; comments: number };
  users: AdminUser[];
  projects: Array<{
    key: string;
    name: string;
    visibility: string;
    workspaceName: string;
    taskCount: number;
    memberCount: number;
  }>;
  events: Array<{
    id: number;
    entityType: string;
    entityKey: string;
    action: string;
    changes: Record<string, unknown>;
    redacted?: boolean;
    requestId: string | null;
    createdAt: string;
    actor: { name: string; email: string | null };
  }>;
  notificationHealth: {
    environment: 'local' | 'dev' | 'production';
    emailConfigured: boolean;
    portalAlertsConfigured: boolean;
    email: {
      accepted24h: number;
      failed24h: number;
      unresolvedFailed: number;
      stalledPending: number;
      lastAcceptedAt: string | null;
      lastFailedAt: string | null;
    };
    portalAlerts: {
      delivered24h: number;
      readyToRetry: number;
      stalledProcessing: number;
      deadLetter: number;
      lastDeliveredAt: string | null;
    };
    recentEmailDeliveries: Array<{
      id: number;
      kind: string;
      entityType: string;
      entityKey: string;
      status: string;
      errorCode: string | null;
      requestId: string | null;
      createdAt: string;
      updatedAt: string;
      recipient: { name: string; email: string };
    }>;
  };
  operationalHealth: {
    errors24h: number;
    warnings24h: number;
    lastEventAt: string | null;
    recentEvents: Array<{
      id: number;
      severity: 'warning' | 'error';
      event: string;
      source: string;
      requestId: string | null;
      method: string | null;
      path: string | null;
      statusCode: number | null;
      message: string;
      details: Record<string, unknown>;
      createdAt: string;
      actor: { name: string; email: string | null } | null;
    }>;
  };
};

export type EventTemplateKey = 'announcement' | 'standard' | 'major' | 'recurring';
export type EventChannel =
  | 'calendar'
  | 'website'
  | 'program'
  | 'screens'
  | 'social'
  | 'print'
  | 'physical'
  | 'qr'
  | 'media';
export type EventLanguage = 'en' | 'es';
export type CommunicationPriority = 'level_1' | 'level_2' | 'level_3' | 'level_4';
export type EventOperation =
  | 'production'
  | 'facilities'
  | 'transportation'
  | 'food'
  | 'vendors'
  | 'volunteers'
  | 'media';
export type EventStage =
  | 'draft'
  | 'needs_information'
  | 'planning'
  | 'producing'
  | 'approval'
  | 'scheduled'
  | 'event_ready'
  | 'post_event'
  | 'archived';
export type EventReadiness = 'blocked' | 'at_risk' | 'ready';
export type DeliverableStatus =
  | 'not_requested'
  | 'waiting_on_facts'
  | 'drafting'
  | 'proofing'
  | 'design_in_progress'
  | 'review_requested'
  | 'changes_requested'
  | 'approved'
  | 'scheduled'
  | 'published'
  | 'retired';
export type EventWorkItemStatus = 'not_started' | 'in_progress' | 'blocked' | 'done' | 'not_needed';
export type EventWorkItemPhase =
  | 'intake'
  | 'administration'
  | 'copy'
  | 'translation'
  | 'design'
  | 'publishing'
  | 'operations'
  | 'post_event';
export type EventWorkItemPatch = {
  status?: EventWorkItemStatus;
  ownerEmail?: string | null;
  title?: string;
  description?: string;
  dueDate?: string | null;
  phase?: EventWorkItemPhase;
  critical?: boolean;
  responsibilityKey?: string | null;
};
export type EventWorkItemCreate = {
  title: string;
  description: string;
  ownerEmail: string | null;
  dueDate: string | null;
  phase: EventWorkItemPhase;
  status: EventWorkItemStatus;
  critical: boolean;
  responsibilityKey?: string | null;
};

export type AssignedEventWorkItem = {
  work_item_key: string;
  phase: EventWorkItemPhase;
  title: string;
  description: string;
  status: EventWorkItemStatus;
  due_at: string | null;
  critical: number;
  updated_at: string;
  event_key: string;
  eventReference: string;
  event_title: string;
  ministry: string;
  stage: EventStage;
  owner_name: string | null;
  owner_email: string | null;
  owner_photo_url: string | null;
  dependency_blockers: number;
};

export type EventTemplate = {
  key: EventTemplateKey;
  name: string;
  description: string;
  version: number;
  definition: {
    schemaVersion: 1;
    leadSundays: number;
    defaultChannels: EventChannel[];
    defaultOperations: EventOperation[];
  };
};

export type EventIntake = {
  templateKey: EventTemplateKey;
  requestApprovalConfirmed: boolean;
  title: string;
  purpose: string;
  ministry: string;
  communicationPriority: CommunicationPriority | null;
  ownerEmail: string | null;
  campuses: string[];
  audience: string;
  startDate: string;
  endDate: string | null;
  startTime: string;
  endTime: string | null;
  timezone: string;
  location: string;
  registration: {
    required: boolean;
    url: string | null;
    openDate: string | null;
    closeDate: string | null;
    cost: number | null;
    capacity: number | null;
    accountCode: string;
    scholarshipAvailable: boolean;
    scholarshipDetails: string;
    formFields: string[];
    additionalQuestions: string;
  };
  channels: EventChannel[];
  languages: EventLanguage[];
  operations: EventOperation[];
  recurrence: { kind: 'none' | 'weekly' | 'monthly' | 'annual'; notes: string };
  priorEvent: {
    heldBefore: boolean;
    sameAsPrevious: boolean | null;
    previousName: string;
  };
  communicationBrief: string;
  creativeBrief: {
    designDirection: string;
    productionDetails: string;
    quantity: number | null;
    otherDeliverables: string;
  };
  resourceRequests: {
    rooms: string[];
    transportation: string[];
    technology: string[];
    building: string[];
    notes: string;
  };
  notes: string;
  source?: {
    system: string;
    id: string;
    url?: string | null;
    metadata?: Record<string, unknown>;
  } | null;
};

export type EventAssistDraft = Partial<
  Omit<
    EventIntake,
    | 'communicationPriority'
    | 'ownerEmail'
    | 'registration'
    | 'recurrence'
    | 'priorEvent'
    | 'creativeBrief'
    | 'resourceRequests'
    | 'source'
  >
> & {
  registration?: Partial<EventIntake['registration']>;
  recurrence?: Partial<EventIntake['recurrence']>;
  priorEvent?: Partial<EventIntake['priorEvent']>;
  creativeBrief?: Partial<EventIntake['creativeBrief']>;
  resourceRequests?: Partial<EventIntake['resourceRequests']>;
};

export type EventAssistMessage = { role: 'user' | 'assistant'; content: string };

export type EventAssistResponse = {
  requestId: string;
  source: 'litellm' | 'guided_fallback';
  notice: string;
  patch: EventAssistDraft;
  draft: EventAssistDraft;
  missing: string[];
  ready: boolean;
  question: string;
};

export type EventOptions = {
  ministries: string[];
  staff: Array<{ id: number; email: string; name: string; photoUrl: string | null }>;
};

export type EventResponsibility = {
  id: number;
  responsibility_key: string;
  area: string;
  owner_email: string | null;
  owner_name: string | null;
  status: 'awaiting_acknowledgment' | 'acknowledged' | 'blocked' | 'ready' | 'not_needed';
  notes: string;
  reviewed_facts_version: number | null;
  version: number;
  canManage: boolean;
};
export type EventResponsibilityPatch = {
  expectedVersion: number;
  expectedFactsVersion: number;
  ownerEmail?: string | null;
  status?: EventResponsibility['status'];
  notes?: string;
};

export type EventPlan = {
  responsibilities: string[];
  templateKey: EventTemplateKey;
  leadSundays: number;
  promotionStartDate: string;
  lateRequest: boolean;
  warnings: string[];
  deliverables: Array<{
    key: string;
    channel: EventChannel;
    title: string;
    assetType: string;
    campus: string;
    language: EventLanguage;
    dueDate: string;
    critical: boolean;
  }>;
  workItems: Array<{
    key: string;
    phase: EventWorkItemPhase;
    title: string;
    description?: string;
    dueDate: string;
    critical: boolean;
    dependsOn: string[];
  }>;
};

export type EventSummary = {
  key: string;
  reference: string;
  title: string;
  purpose: string;
  ministry: string;
  startAt: string;
  endAt: string | null;
  timezone: string;
  location: string;
  stage: EventStage;
  readiness: EventReadiness;
  progress: number;
  blockers: number;
  owner: { name: string; email: string | null } | null;
  template: { key: EventTemplateKey; name: string };
  source: { system: string; id: string | null; url: string | null } | null;
  updatedAt: string;
};

export type EventFacts = Omit<EventIntake, 'templateKey' | 'source'> & {
  promotionStartDate: string;
};

export type EventDetail = Omit<EventSummary, 'blockers'> & {
  workflowMode: 'legacy' | 'responsibilities';
  originalRequest: Record<string, unknown> | null;
  originalRequestKind: string;
  responsibilities: EventResponsibility[];
  blockerCount: number;
  factsVersion: number;
  version: number;
  facts: EventFacts;
  factHistory: Array<{
    version: number;
    facts: EventFacts;
    reason: string | null;
    createdAt: string;
  }>;
  channels: Array<{
    id: number;
    channel: EventChannel;
    campus: string;
    language: EventLanguage;
    required: number;
    status: string;
  }>;
  deliverables: Array<{
    id: number;
    deliverable_key: string;
    title: string;
    asset_type: string;
    campus: string;
    language: EventLanguage;
    status: DeliverableStatus;
    due_at: string | null;
    critical: number;
    fact_version: number;
    published_at: string | null;
    approved_copy_version_id: number | null;
    approved_asset_version_id: number | null;
    channel: EventChannel;
    owner_name: string | null;
    owner_email: string | null;
  }>;
  workItems: Array<{
    id: number;
    work_item_key: string;
    phase: EventWorkItemPhase;
    title: string;
    description: string;
    status: EventWorkItemStatus;
    due_at: string | null;
    critical: number;
    sort_order: number;
    owner_name: string | null;
    owner_email: string | null;
    responsibility_id: number | null;
    responsibility_key: string | null;
    legacy: boolean;
    canManage: boolean;
    dependency_keys: string | null;
    dependency_blockers: number;
  }>;
  copyVariants: Array<{
    id: number;
    purpose: string;
    language: EventLanguage;
    current_version: number;
    approved_version_id: number | null;
    version_id: number | null;
    version: number | null;
    fact_version: number | null;
    body: string | null;
    author_type: string | null;
    created_at: string | null;
    author_name: string | null;
  }>;
  assetVersions: Array<{
    id: number;
    deliverable_id: number;
    version: number;
    label: string;
    url: string;
    storage_provider: string | null;
    provider_file_id: string | null;
    checksum_sha256: string | null;
    original_filename: string | null;
    content_type: string | null;
    size_bytes: number | null;
    is_final: number;
    finalized_at: string | null;
    drive_delivery_status:
      | 'not_requested'
      | 'pending_configuration'
      | 'external_link'
      | 'delivered'
      | 'failed';
    drive_file_id: string | null;
    drive_web_view_link: string | null;
    drive_delivered_at: string | null;
    delivery_error: string | null;
    created_at: string;
    creator_name: string | null;
  }>;
  approvals: Array<{
    id: number;
    subject_type: string;
    subject_id: number;
    subject_version: number;
    scope: string;
    decision: 'approved' | 'changes_requested';
    trusted: number;
    comment: string;
    invalidated_at: string | null;
    invalidation_reason: string | null;
    created_at: string;
    approver_name: string | null;
  }>;
  comments: Array<{
    id: number;
    subject_type: string;
    subject_id: number | null;
    body: string;
    source_system: string | null;
    source_id: string | null;
    source_created_at: string | null;
    created_at: string;
    author_name: string;
  }>;
  activity: Array<{
    id: number;
    action: string;
    entity_type: string;
    entity_key: string;
    changes: Record<string, unknown>;
    created_at: string;
    actor_name: string;
  }>;
  canEdit: boolean;
  canApprove: boolean;
  createdAt: string;
};

export type WorkflowDurationMetric = {
  averageHours: number | null;
  medianHours: number | null;
  sampleSize: number;
};

export type WorkflowAnalytics = {
  periodDays: number;
  trackingStartedAt: string | null;
  metrics: {
    eventLeadTime: WorkflowDurationMetric;
    eventTaskLeadTime: WorkflowDurationMetric;
    standardTaskLeadTime: WorkflowDurationMetric;
    deliverableApprovalTime: WorkflowDurationMetric;
    averageAssetVersions: number;
    revisionRate: number;
  };
  phases: Array<WorkflowDurationMetric & { phase: string }>;
  stages: Array<{ stage: string; count: number }>;
  recentEvents: Array<{
    key: string;
    reference: string;
    title: string;
    completedAt: string;
    elapsedHours: number;
  }>;
};

export const eventStageLabels: Record<EventStage, string> = {
  draft: 'Draft',
  needs_information: 'Needs information',
  planning: 'Planning',
  producing: 'Producing',
  approval: 'Approval',
  scheduled: 'Scheduled / live',
  event_ready: 'Event ready',
  post_event: 'Post-event',
  archived: 'Archived',
};

export const deliverableStatusLabels: Record<DeliverableStatus, string> = {
  not_requested: 'Not requested',
  waiting_on_facts: 'Waiting on facts',
  drafting: 'Drafting',
  proofing: 'Proofing',
  design_in_progress: 'Design in progress',
  review_requested: 'Review requested',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  retired: 'Retired',
};
