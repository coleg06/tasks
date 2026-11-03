import type { Context } from 'hono';
import { tenantProfile } from '../../shared/tenant-profile';
import { tenantEventVocabulary } from '../../shared/tenant-profile-support';
import { userHasPermission } from '../auth/permissions';
import { logApplicationError } from '../logging';
import {
  eventUrl,
  mentionedUserIds,
  sendUserNotification,
  type UserNotification,
} from '../notifications/email';
import type { SqlStatement } from '../platform/ports';
import { requireTasksSession, type TaskAppEnv } from '../tasks/api';
import { deliverAssetToDrive, driveIsConfigured } from './drive';
import { eventArchiveVisibilityClause } from './filters';
import { buildEventPlan } from './planning';
import {
  type ReadinessCounts,
  readinessColumns,
  readinessSummary,
  seedResponsibilityStatements,
} from './responsibilities';
import {
  approvalMutationSchema,
  assetVersionMutationSchema,
  copyVersionMutationSchema,
  deliverablePatchSchema,
  eventFactsPatchSchema,
  eventIntakeSchema,
  eventStagePatchSchema,
  eventWorkItemCreateSchema,
  eventWorkItemPatchSchema,
  responsibilityCreateSchema,
  responsibilityPatchSchema,
  workflowDefinitionSchema,
} from './schemas';

type AppContext = Context<TaskAppEnv>;

type Identity = NonNullable<Awaited<ReturnType<typeof requireTasksSession>>>;

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

type TemplateRow = {
  id: number;
  template_key: string;
  name: string;
  description: string;
  version: number;
  definition_json: string;
};

type EventRow = {
  id: number;
  event_key: string;
  seq: number;
  title: string;
  purpose: string;
  ministry: string;
  start_at: string;
  end_at: string | null;
  timezone: string;
  location: string;
  stage: string;
  readiness_status: string;
  workflow_mode: 'legacy' | 'responsibilities';
  original_request_json: string | null;
  original_request_kind: string | null;
  facts_version: number;
  version: number;
  owner_user_id: number | null;
  created_by_user_id: number;
  owner_name: string | null;
  owner_email: string | null;
  template_key: string;
  template_name: string;
  source_system: string | null;
  source_id: string | null;
  source_url: string | null;
  source_metadata_json: string | null;
  created_at: string;
  updated_at: string;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

async function hasPermission(context: AppContext, userId: number, permission: string) {
  return userHasPermission(context.env, userId, permission);
}

async function eventIdentity(context: AppContext, permission = 'events.view') {
  return requireTasksSession(context, permission);
}

async function activeTemplate(context: AppContext, templateKey: string) {
  return context.env.DB.prepare(
    `SELECT tv.id, t.template_key, t.name, t.description, tv.version, tv.definition_json
     FROM event_workflow_templates t
     JOIN event_workflow_template_versions tv
       ON tv.template_id = t.id AND tv.version = t.active_version
     WHERE t.template_key = ? AND t.archived_at IS NULL`,
  )
    .bind(templateKey)
    .first<TemplateRow>();
}

async function workspaceForUser(context: AppContext, userId: number) {
  return context.env.DB.prepare(
    `SELECT w.id, w.workspace_key FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE w.workspace_key = ? AND wm.user_id = ? AND w.archived_at IS NULL`,
  )
    .bind(tenantProfile.workspaceKey, userId)
    .first<{ id: number; workspace_key: string }>();
}

async function resolveOwner(
  context: AppContext,
  workspaceId: number,
  ownerEmail: string | null,
  fallbackUserId: number,
) {
  if (!ownerEmail) return fallbackUserId;
  const owner = await context.env.DB.prepare(
    `SELECT u.id FROM users u
     JOIN workspace_members wm ON wm.user_id = u.id
     WHERE wm.workspace_id = ? AND u.email = ? COLLATE NOCASE AND u.status = 'active'`,
  )
    .bind(workspaceId, ownerEmail)
    .first<{ id: number }>();
  return owner?.id ?? null;
}

const eventColumns = `
  e.id, e.event_key, e.seq, e.title, e.purpose, e.ministry, e.start_at, e.end_at,
  e.timezone, e.location, e.stage, e.readiness_status, e.facts_version, e.version,
  e.owner_user_id, e.created_by_user_id, e.source_system, e.source_id, e.source_url,
  e.source_metadata_json, e.created_at, e.updated_at,
  e.workflow_mode, e.original_request_json, e.original_request_kind,
  t.template_key, t.name AS template_name,
  COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS owner_name,
  u.email AS owner_email`;

async function accessibleEvent(context: AppContext, userId: number, eventKey: string) {
  return context.env.DB.prepare(
    `SELECT ${eventColumns}
     FROM events e
     JOIN workspace_members wm ON wm.workspace_id = e.workspace_id AND wm.user_id = ?
     JOIN event_workflow_template_versions tv ON tv.id = e.template_version_id
     JOIN event_workflow_templates t ON t.id = tv.template_id
     LEFT JOIN users u ON u.id = e.owner_user_id
     WHERE e.event_key = ?`,
  )
    .bind(userId, eventKey)
    .first<EventRow>();
}

async function canEditEvent(context: AppContext, identity: Identity, event: EventRow) {
  return (
    event.owner_user_id === identity.user.id ||
    event.created_by_user_id === identity.user.id ||
    (await hasPermission(context, identity.user.id, 'events.manage')) ||
    (await hasPermission(context, identity.user.id, 'tasks.manage'))
  );
}

type ResponsibilityRow = {
  id: number;
  responsibility_key: string;
  event_id: number;
  area: string;
  owner_user_id: number | null;
  status: string;
  notes: string;
  reviewed_facts_version: number | null;
  version: number;
};

const readinessGateSql = `NOT EXISTS (SELECT 1 FROM (
  SELECT ${readinessColumns} FROM events e WHERE e.id = ?
) counts WHERE deliverable_blockers + work_item_blockers + responsibility_blockers + approval_blockers > 0)`;

async function eventReadiness(context: AppContext, eventId: number) {
  const counts = await context.env.DB.prepare(
    `SELECT ${readinessColumns} FROM events e WHERE e.id = ?`,
  )
    .bind(eventId)
    .first<ReadinessCounts>();
  if (!counts) throw new Error('Event disappeared during readiness review.');
  return counts;
}

async function responsibilityFor(context: AppContext, eventId: number, key: string) {
  return context.env.DB.prepare(`SELECT * FROM event_responsibilities
    WHERE event_id = ? AND responsibility_key = ?`)
    .bind(eventId, key)
    .first<ResponsibilityRow>();
}

export async function createResponsibility(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event)))
    return context.json({ error: 'forbidden' }, 403);
  if (event.workflow_mode !== 'responsibilities')
    return context.json({ error: 'convert_workflow_first' }, 409);
  const parsed = responsibilityCreateSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'invalid_responsibility' }, 400);
  const key = `ER-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const results = await context.env.DB.batch([
    context.env.DB.prepare(`INSERT OR IGNORE INTO event_responsibilities
      (responsibility_key, event_id, area) VALUES (?, ?, ?)`).bind(key, event.id, parsed.data.area),
    context.env.DB.prepare(`INSERT INTO event_activity (event_id, actor_user_id, action,
      entity_type, entity_key, changes_json) SELECT ?, ?, 'responsibility.created',
      'responsibility', ?, ? WHERE EXISTS (SELECT 1 FROM event_responsibilities WHERE responsibility_key = ?)`).bind(
      event.id,
      identity.auditUserId,
      key,
      JSON.stringify(parsed.data),
      key,
    ),
  ]);
  if (!results[0]?.meta.changes) return context.json({ error: 'responsibility_exists' }, 409);
  return getEvent(context);
}

export async function patchResponsibility(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  const row = await responsibilityFor(
    context,
    event.id,
    context.req.param('responsibilityKey') ?? '',
  );
  if (!row) return context.json({ error: 'not_found' }, 404);
  const canManageEvent = await canEditEvent(context, identity, event);
  if (!canManageEvent && row.owner_user_id !== identity.user.id)
    return context.json({ error: 'forbidden' }, 403);
  const parsed = responsibilityPatchSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'invalid_responsibility' }, 400);
  const patch = parsed.data;
  if (patch.ownerEmail !== undefined && !canManageEvent)
    return context.json({ error: 'forbidden' }, 403);
  if (patch.expectedVersion !== row.version || patch.expectedFactsVersion !== event.facts_version) {
    return context.json({ error: 'version_conflict' }, 409);
  }
  const workspace = await workspaceForUser(context, identity.user.id);
  const ownerId =
    patch.ownerEmail === undefined
      ? row.owner_user_id
      : patch.ownerEmail === null
        ? null
        : await resolveOwner(context, workspace?.id ?? 0, patch.ownerEmail, identity.user.id);
  if (patch.ownerEmail && !ownerId) return context.json({ error: 'invalid_owner' }, 400);
  const reassigned = ownerId !== row.owner_user_id;
  const status = reassigned ? 'awaiting_acknowledgment' : (patch.status ?? row.status);
  const notes = patch.notes ?? row.notes;
  if (['blocked', 'not_needed'].includes(status) && !notes.trim()) {
    return context.json({ error: 'responsibility_reason_required' }, 400);
  }
  if (['acknowledged', 'ready', 'blocked'].includes(status)) {
    const activeOwner = await context.env.DB.prepare(`SELECT 1 FROM users u
      JOIN workspace_members wm ON wm.user_id = u.id WHERE u.id = ? AND u.status = 'active'
      AND wm.workspace_id = (SELECT workspace_id FROM events WHERE id = ?)`)
      .bind(ownerId, event.id)
      .first();
    if (!activeOwner) return context.json({ error: 'invalid_owner' }, 400);
  }
  const mutationKey = crypto.randomUUID();
  const results = await context.env.DB.batch([
    context.env.DB.prepare(`UPDATE event_responsibilities SET owner_user_id = ?, status = ?, notes = ?,
      reviewed_facts_version = ?, version = version + 1, mutation_key = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND version = ?
      AND (SELECT facts_version FROM events WHERE id = ?) = ?`).bind(
      ownerId,
      status,
      notes,
      status === 'awaiting_acknowledgment' ? null : event.facts_version,
      mutationKey,
      row.id,
      row.version,
      event.id,
      event.facts_version,
    ),
    context.env.DB.prepare(`INSERT INTO event_activity (event_id, actor_user_id, action,
      entity_type, entity_key, changes_json) SELECT ?, ?, 'responsibility.updated',
      'responsibility', ?, ? WHERE EXISTS (SELECT 1 FROM event_responsibilities WHERE id = ? AND mutation_key = ?)`).bind(
      event.id,
      identity.auditUserId,
      row.responsibility_key,
      JSON.stringify({
        ownerUserId: { from: row.owner_user_id, to: ownerId },
        status: { from: row.status, to: status },
        notes,
        factsVersion: event.facts_version,
      }),
      row.id,
      mutationKey,
    ),
  ]);
  if (!results[0]?.meta.changes) return context.json({ error: 'version_conflict' }, 409);
  return getEvent(context);
}

export async function convertResponsibilityWorkflow(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event)))
    return context.json({ error: 'forbidden' }, 403);
  // Conversion is idempotent and never retires, reassigns, or deletes legacy work.
  if (event.workflow_mode === 'responsibilities') return getEvent(context);
  const row = await context.env.DB.prepare(
    `SELECT facts_json FROM event_fact_versions WHERE event_id = ? AND version = ?`,
  )
    .bind(event.id, event.facts_version)
    .first<{ facts_json: string }>();
  const input = eventIntakeSchema.safeParse({
    ...parseJson(row?.facts_json, {}),
    templateKey: event.template_key,
  });
  if (!input.success)
    return context.json({ error: 'invalid_event', issues: input.error.issues }, 400);
  await context.env.DB.batch([
    ...seedResponsibilityStatements(context.env.DB, event.id, input.data),
    context.env.DB.prepare(`INSERT INTO event_activity (event_id, actor_user_id, action,
      entity_type, entity_key, changes_json) SELECT ?, ?, 'event.workflow_converted', 'event', ?, ?
      WHERE (SELECT workflow_mode FROM events WHERE id = ?) = 'legacy'`).bind(
      event.id,
      identity.auditUserId,
      event.event_key,
      JSON.stringify({
        from: 'legacy',
        to: 'responsibilities',
        legacyWork:
          'Preserved; explicitly link tasks to a responsibility to adopt them into readiness.',
      }),
      event.id,
    ),
    context.env.DB.prepare(`UPDATE events SET workflow_mode = 'responsibilities', version = version + 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND workflow_mode = 'legacy'`).bind(
      event.id,
    ),
  ]);
  return getEvent(context);
}

function sourceFields(
  source:
    | {
        system: string;
        id: string;
        url?: string | null | undefined;
        metadata?: Record<string, unknown> | undefined;
      }
    | null
    | undefined,
) {
  return {
    system: source?.system ?? null,
    id: source?.id ?? null,
    url: source?.url ?? null,
    metadata: source?.metadata ? JSON.stringify(source.metadata) : null,
  };
}

function currentFacts(
  input: ReturnType<typeof eventIntakeSchema.parse>,
  plan: ReturnType<typeof buildEventPlan>,
) {
  return {
    requestApprovalConfirmed: input.requestApprovalConfirmed,
    title: input.title,
    purpose: input.purpose,
    ministry: input.ministry,
    communicationPriority: input.communicationPriority,
    ownerEmail: input.ownerEmail,
    campuses: input.campuses,
    audience: input.audience,
    startDate: input.startDate,
    endDate: input.endDate,
    startTime: input.startTime,
    endTime: input.endTime,
    timezone: input.timezone,
    location: input.location,
    registration: input.registration,
    channels: input.channels,
    languages: input.languages,
    operations: input.operations,
    recurrence: input.recurrence,
    priorEvent: input.priorEvent,
    communicationBrief: input.communicationBrief,
    creativeBrief: input.creativeBrief,
    resourceRequests: input.resourceRequests,
    notes: input.notes,
    promotionStartDate: plan.promotionStartDate,
  };
}

function copyPurposes(channels: Array<string>) {
  if (!channels.length) return [];
  const purposes = new Set<string>(['full_promo']);
  if (channels.includes('screens') || channels.includes('program')) purposes.add('slide');
  if (channels.includes('calendar')) purposes.add('calendar');
  if (channels.includes('social')) purposes.add('social');
  if (channels.includes('print')) purposes.add('handout');
  if (channels.includes('website')) purposes.add('website');
  return [...purposes];
}

type ExistingPlannedRow = {
  id: number;
  key: string;
  status: string;
  source_metadata_json: string | null;
};

function planKeyFor(row: ExistingPlannedRow) {
  return parseJson<{ planKey?: string }>(row.source_metadata_json, {}).planKey;
}

// Generated records keep a stable planKey even though their public keys are random. Reconcile by
// that key so edits refresh the plan without deleting completed work, files, or audit history.
async function eventPlanSyncStatements(
  context: AppContext,
  event: EventRow,
  input: ReturnType<typeof eventIntakeSchema.parse>,
  plan: ReturnType<typeof buildEventPlan>,
  factVersion: number,
  ownerUserId: number,
) {
  const statements: SqlStatement[] = [];
  const channelRows = await context.env.DB.prepare(
    `SELECT id, channel, campus, language, status
     FROM event_channels WHERE event_id = ?`,
  )
    .bind(event.id)
    .all<{ id: number; channel: string; campus: string; language: string; status: string }>();
  const requestedChannels = new Set<string>();
  for (const channel of input.channels) {
    for (const campus of input.campuses) {
      for (const language of input.languages) {
        const key = `${channel}\u0000${campus}\u0000${language}`;
        requestedChannels.add(key);
        statements.push(
          context.env.DB.prepare(
            `INSERT INTO event_channels (event_id, channel, campus, language)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(event_id, channel, campus, language) DO UPDATE SET
               status = CASE WHEN status = 'not_needed' THEN 'planned' ELSE status END,
               updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`,
          ).bind(event.id, channel, campus, language),
        );
      }
    }
  }
  for (const row of channelRows.results) {
    const key = `${row.channel}\u0000${row.campus}\u0000${row.language}`;
    if (!requestedChannels.has(key) && row.status !== 'not_needed') {
      statements.push(
        context.env.DB.prepare(
          `UPDATE event_channels SET status = 'not_needed',
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
        ).bind(row.id),
      );
    }
  }

  const deliverableRows = await context.env.DB.prepare(
    `SELECT id, deliverable_key AS key, status, source_metadata_json
     FROM event_deliverables WHERE event_id = ?`,
  )
    .bind(event.id)
    .all<ExistingPlannedRow>();
  const deliverablesByPlanKey = new Map(
    deliverableRows.results
      .map((row) => [planKeyFor(row), row] as const)
      .filter((entry): entry is [string, ExistingPlannedRow] => Boolean(entry[0])),
  );
  const nextDeliverableKeys = new Set(plan.deliverables.map((item) => item.key));
  for (const deliverable of plan.deliverables) {
    const existing = deliverablesByPlanKey.get(deliverable.key);
    if (existing) {
      statements.push(
        context.env.DB.prepare(
          `UPDATE event_deliverables SET
             channel_id = (SELECT id FROM event_channels
               WHERE event_id = ? AND channel = ? AND campus = ? AND language = ?),
             title = ?, asset_type = ?, campus = ?, language = ?, due_at = ?, critical = ?,
             fact_version = ?, status = CASE WHEN status = 'not_requested'
               THEN 'waiting_on_facts' ELSE status END,
             updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
           WHERE id = ?`,
        ).bind(
          event.id,
          deliverable.channel,
          deliverable.campus,
          deliverable.language,
          deliverable.title,
          deliverable.assetType,
          deliverable.campus,
          deliverable.language,
          deliverable.dueDate,
          deliverable.critical ? 1 : 0,
          factVersion,
          existing.id,
        ),
      );
    } else {
      const deliverableKey = `DEL-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO event_deliverables (
            deliverable_key, event_id, channel_id, title, asset_type, campus, language,
            status, due_at, owner_user_id, critical, fact_version, source_metadata_json
           ) VALUES (
            ?, ?, (SELECT id FROM event_channels
              WHERE event_id = ? AND channel = ? AND campus = ? AND language = ?),
            ?, ?, ?, ?, 'waiting_on_facts', ?, ?, ?, ?, ?
           )`,
        ).bind(
          deliverableKey,
          event.id,
          event.id,
          deliverable.channel,
          deliverable.campus,
          deliverable.language,
          deliverable.title,
          deliverable.assetType,
          deliverable.campus,
          deliverable.language,
          deliverable.dueDate,
          event.workflow_mode === 'responsibilities' ? null : ownerUserId,
          deliverable.critical ? 1 : 0,
          factVersion,
          JSON.stringify({ planKey: deliverable.key }),
        ),
      );
    }
  }
  for (const row of deliverableRows.results) {
    const planKey = planKeyFor(row);
    if (planKey && !nextDeliverableKeys.has(planKey) && row.status !== 'not_requested') {
      statements.push(
        context.env.DB.prepare(
          `UPDATE event_deliverables SET status = 'not_requested', fact_version = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
        ).bind(factVersion, row.id),
      );
    }
  }

  if (event.workflow_mode === 'legacy') {
    const workItemRows = await context.env.DB.prepare(
      `SELECT id, work_item_key AS key, status, source_metadata_json
     FROM event_work_items WHERE event_id = ?`,
    )
      .bind(event.id)
      .all<ExistingPlannedRow>();
    const workItemsByPlanKey = new Map(
      workItemRows.results
        .map((row) => [planKeyFor(row), row] as const)
        .filter((entry): entry is [string, ExistingPlannedRow] => Boolean(entry[0])),
    );
    const workItemKeys = new Map<string, string>();
    const nextWorkItemKeys = new Set(plan.workItems.map((item) => item.key));
    for (const item of plan.workItems) {
      const existing = workItemsByPlanKey.get(item.key);
      const workItemKey =
        existing?.key ??
        `EWI-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
      workItemKeys.set(item.key, workItemKey);
      if (existing) {
        const metadata = parseJson<{ planKey?: string; removedByPlanSync?: boolean }>(
          existing.source_metadata_json,
          {},
        );
        statements.push(
          context.env.DB.prepare(
            `UPDATE event_work_items SET phase = ?, title = ?, description = ?, due_at = ?,
           critical = ?, sort_order = ?, status = ?, source_metadata_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
          ).bind(
            item.phase,
            item.title,
            item.description ?? '',
            item.dueDate,
            item.critical ? 1 : 0,
            plan.workItems.indexOf(item),
            metadata.removedByPlanSync ? 'not_started' : existing.status,
            JSON.stringify({ planKey: item.key }),
            existing.id,
          ),
        );
      } else {
        statements.push(
          context.env.DB.prepare(
            `INSERT INTO event_work_items (
            work_item_key, event_id, phase, title, description, status, due_at, owner_user_id,
            critical, sort_order, source_metadata_json
           ) VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?)`,
          ).bind(
            workItemKey,
            event.id,
            item.phase,
            item.title,
            item.description ?? '',
            item.dueDate,
            ownerUserId,
            item.critical ? 1 : 0,
            plan.workItems.indexOf(item),
            JSON.stringify({ planKey: item.key }),
          ),
        );
      }
    }
    for (const row of workItemRows.results) {
      const planKey = planKeyFor(row);
      if (planKey && !nextWorkItemKeys.has(planKey)) {
        statements.push(
          context.env.DB.prepare(
            `UPDATE event_work_items SET status = 'not_needed', source_metadata_json = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
          ).bind(JSON.stringify({ planKey, removedByPlanSync: true }), row.id),
        );
      }
    }
    statements.push(
      context.env.DB.prepare(
        `DELETE FROM event_work_item_dependencies
       WHERE work_item_id IN (
         SELECT id FROM event_work_items
         WHERE event_id = ? AND json_extract(source_metadata_json, '$.planKey') IS NOT NULL
       )`,
      ).bind(event.id),
    );
    for (const item of plan.workItems) {
      for (const dependency of item.dependsOn) {
        const workItemKey = workItemKeys.get(item.key);
        const dependencyKey = workItemKeys.get(dependency);
        if (!workItemKey || !dependencyKey || workItemKey === dependencyKey) continue;
        statements.push(
          context.env.DB.prepare(
            `INSERT OR IGNORE INTO event_work_item_dependencies (
            work_item_id, depends_on_work_item_id
           ) SELECT current.id, dependency.id
             FROM event_work_items current, event_work_items dependency
             WHERE current.work_item_key = ? AND dependency.work_item_key = ?`,
          ).bind(workItemKey, dependencyKey),
        );
      }
    }
  }

  for (const purpose of copyPurposes(input.channels)) {
    for (const language of input.languages) {
      statements.push(
        context.env.DB.prepare(
          `INSERT OR IGNORE INTO event_copy_variants (event_id, purpose, language)
           VALUES (?, ?, ?)`,
        ).bind(event.id, purpose, language),
      );
    }
  }
  return statements;
}

function activityStatement(
  context: AppContext,
  eventId: number,
  actorUserId: number | null,
  action: string,
  entityType: string,
  entityKey: string,
  changes: Record<string, unknown>,
  source?: { system: string | null; id: string | null },
  onlyIfPreviousChanged = false,
) {
  return context.env.DB.prepare(
    `INSERT INTO event_activity (
      event_id, actor_user_id, action, entity_type, entity_key, changes_json,
      correlation_id, source_system, source_id
     ) ${onlyIfPreviousChanged ? 'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1' : 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'}`,
  ).bind(
    eventId,
    actorUserId,
    action,
    entityType,
    entityKey,
    JSON.stringify(changes),
    context.get('requestId') ??
      context.req.header('cf-ray') ??
      context.req.header('x-request-id') ??
      crypto.randomUUID(),
    source?.system ?? null,
    source?.id ?? null,
  );
}

export async function listEventTemplates(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const rows = await context.env.DB.prepare(
    `SELECT tv.id, t.template_key, t.name, t.description, tv.version, tv.definition_json
     FROM event_workflow_templates t
     JOIN event_workflow_template_versions tv
       ON tv.template_id = t.id AND tv.version = t.active_version
     WHERE t.archived_at IS NULL ORDER BY t.id`,
  ).all<TemplateRow>();
  return context.json({
    templates: rows.results.map((row) => ({
      key: row.template_key,
      name: row.name,
      description: row.description,
      version: row.version,
      definition: workflowDefinitionSchema.parse(JSON.parse(row.definition_json)),
    })),
  });
}

export async function listEventOptions(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const workspace = await workspaceForUser(context, identity.user.id);
  if (!workspace) return context.json({ error: 'forbidden' }, 403);
  const [ministries, staff] = await Promise.all([
    context.env.DB.prepare(
      `SELECT DISTINCT TRIM(ministry) AS ministry
       FROM events
       WHERE workspace_id = ? AND TRIM(ministry) <> ''
       ORDER BY ministry COLLATE NOCASE`,
    )
      .bind(workspace.id)
      .all<{ ministry: string }>(),
    context.env.DB.prepare(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.photo_url
       FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE wm.workspace_id = ? AND u.status = 'active'
       ORDER BY u.first_name COLLATE NOCASE, u.last_name COLLATE NOCASE, u.email COLLATE NOCASE`,
    )
      .bind(workspace.id)
      .all<{
        id: number;
        email: string;
        first_name: string;
        last_name: string;
        photo_url: string | null;
      }>(),
  ]);
  const ministryPresets = tenantEventVocabulary().ministryPresets;
  const seen = new Set(ministryPresets.map((value) => value.toLowerCase()));
  const customMinistries = ministries.results
    .map((row) => row.ministry)
    .filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return context.json({
    ministries: [...ministryPresets, ...customMinistries],
    staff: staff.results.map((user) => ({
      id: user.id,
      email: user.email,
      name: `${user.first_name} ${user.last_name}`.trim() || user.email,
      photoUrl: user.photo_url,
    })),
  });
}

export async function previewEventPlan(context: AppContext) {
  const identity = await eventIdentity(context, 'events.create');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const parsed = eventIntakeSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json({ error: 'invalid_event', issues: parsed.error.issues }, 400);
  }
  const template = await activeTemplate(context, parsed.data.templateKey);
  if (!template) return context.json({ error: 'invalid_template' }, 400);
  const definition = workflowDefinitionSchema.parse(JSON.parse(template.definition_json));
  const plan = buildEventPlan(parsed.data, definition);
  return context.json({
    plan,
    template: {
      key: template.template_key,
      name: template.name,
      version: template.version,
    },
  });
}

export async function createEvent(context: AppContext) {
  const identity = await eventIdentity(context, 'events.create');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const parsed = eventIntakeSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json({ error: 'invalid_event', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const workspace = await workspaceForUser(context, identity.user.id);
  if (!workspace) return context.json({ error: 'forbidden' }, 403);
  const template = await activeTemplate(context, input.templateKey);
  if (!template) return context.json({ error: 'invalid_template' }, 400);
  const ownerUserId = await resolveOwner(context, workspace.id, input.ownerEmail, identity.user.id);
  if (!ownerUserId) return context.json({ error: 'invalid_owner' }, 400);

  const definition = workflowDefinitionSchema.parse(JSON.parse(template.definition_json));
  const plan = buildEventPlan(input, definition);
  const facts = currentFacts(input, plan);
  const source = sourceFields(input.source);
  const eventKey = `EVT-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const startAt = `${input.startDate}T${input.startTime}:00`;
  const endAt =
    input.endDate || input.endTime
      ? `${input.endDate ?? input.startDate}T${input.endTime ?? input.startTime}:00`
      : null;
  const initialStage =
    !input.requestApprovalConfirmed ||
    (input.registration.required && !input.registration.url) ||
    (input.registration.cost !== null &&
      input.registration.cost > 0 &&
      !input.registration.accountCode)
      ? 'needs_information'
      : 'planning';
  const maximum = await context.env.DB.prepare(
    'SELECT COALESCE(MAX(seq), 0) AS maximum FROM events',
  ).first<{ maximum: number }>();
  const seq = (maximum?.maximum ?? 0) + 1;

  await context.env.DB.prepare(
    `INSERT INTO events (
      event_key, seq, workspace_id, template_version_id, title, purpose, ministry,
      owner_user_id, created_by_user_id, start_at, end_at, timezone, location,
      stage, readiness_status, recurrence_json, source_system, source_id, source_url,
      source_metadata_json, source_content_json, workflow_mode, original_request_json, original_request_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, ?, ?, ?, ?, ?, 'responsibilities', ?, 'submitted_intake')`,
  )
    .bind(
      eventKey,
      seq,
      workspace.id,
      template.id,
      input.title,
      input.purpose,
      input.ministry,
      ownerUserId,
      identity.user.id,
      startAt,
      endAt,
      input.timezone,
      input.location,
      initialStage,
      JSON.stringify(input.recurrence),
      source.system,
      source.id,
      source.url,
      source.metadata,
      input.source ? JSON.stringify({ intake: input }) : null,
      JSON.stringify(input),
    )
    .run();

  const created = await context.env.DB.prepare('SELECT id FROM events WHERE event_key = ?')
    .bind(eventKey)
    .first<{ id: number }>();
  if (!created) return context.json({ error: 'event_creation_failed' }, 500);

  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO event_fact_versions (
        event_id, version, facts_json, changed_by_user_id, change_reason, source_system, source_id
       ) VALUES (?, 1, ?, ?, 'Initial event request', ?, ?)`,
    ).bind(created.id, JSON.stringify(facts), identity.user.id, source.system, source.id),
  ];

  statements.push(...seedResponsibilityStatements(context.env.DB, created.id, input));

  for (const channel of input.channels) {
    for (const campus of input.campuses) {
      for (const language of input.languages) {
        statements.push(
          context.env.DB.prepare(
            `INSERT INTO event_channels (event_id, channel, campus, language)
             VALUES (?, ?, ?, ?)`,
          ).bind(created.id, channel, campus, language),
        );
      }
    }
  }

  for (const deliverable of plan.deliverables) {
    const deliverableKey = `DEL-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO event_deliverables (
          deliverable_key, event_id, channel_id, title, asset_type, campus, language,
          status, due_at, owner_user_id, critical, fact_version, source_metadata_json
         ) VALUES (
          ?, ?, (SELECT id FROM event_channels
                 WHERE event_id = ? AND channel = ? AND campus = ? AND language = ?),
          ?, ?, ?, ?, 'waiting_on_facts', ?, ?, ?, 1, ?
         )`,
      ).bind(
        deliverableKey,
        created.id,
        created.id,
        deliverable.channel,
        deliverable.campus,
        deliverable.language,
        deliverable.title,
        deliverable.assetType,
        deliverable.campus,
        deliverable.language,
        deliverable.dueDate,
        null,
        deliverable.critical ? 1 : 0,
        JSON.stringify({ planKey: deliverable.key }),
      ),
    );
  }

  const workItemKeys = new Map<string, string>();
  for (const item of plan.workItems) {
    workItemKeys.set(
      item.key,
      `EWI-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
    );
  }
  for (const [index, item] of plan.workItems.entries()) {
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO event_work_items (
          work_item_key, event_id, phase, title, description, status, due_at, owner_user_id,
          critical, sort_order, source_metadata_json
         ) VALUES (?, ?, ?, ?, ?, 'not_started', ?, ?, ?, ?, ?)`,
      ).bind(
        workItemKeys.get(item.key),
        created.id,
        item.phase,
        item.title,
        item.description ?? '',
        item.dueDate,
        ownerUserId,
        item.critical ? 1 : 0,
        index,
        JSON.stringify({ planKey: item.key }),
      ),
    );
  }
  for (const item of plan.workItems) {
    for (const dependency of item.dependsOn) {
      const workItemKey = workItemKeys.get(item.key);
      const dependencyKey = workItemKeys.get(dependency);
      if (!workItemKey || !dependencyKey || workItemKey === dependencyKey) continue;
      statements.push(
        context.env.DB.prepare(
          `INSERT OR IGNORE INTO event_work_item_dependencies (
            work_item_id, depends_on_work_item_id
           ) SELECT current.id, dependency.id
             FROM event_work_items current, event_work_items dependency
             WHERE current.work_item_key = ? AND dependency.work_item_key = ?`,
        ).bind(workItemKey, dependencyKey),
      );
    }
  }

  for (const purpose of copyPurposes(input.channels)) {
    for (const language of input.languages) {
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO event_copy_variants (event_id, purpose, language) VALUES (?, ?, ?)`,
        ).bind(created.id, purpose, language),
      );
    }
  }

  statements.push(
    activityStatement(
      context,
      created.id,
      identity.auditUserId,
      'event.created',
      'event',
      eventKey,
      {
        templateKey: input.templateKey,
        templateVersion: template.version,
        deliverableCount: plan.deliverables.length,
        workItemCount: plan.workItems.length,
        promotionStartDate: plan.promotionStartDate,
      },
      { system: source.system, id: source.id },
    ),
  );

  await context.env.DB.batch(statements);
  scheduleNotifications(context, [
    {
      userId: ownerUserId,
      actorUserId: identity.user.id,
      kind: 'assignment',
      entityType: 'event',
      entityKey: eventKey,
      dedupeKey: `assignment:event:${eventKey}:${ownerUserId}`,
      subject: `Event assigned: ${input.title}`,
      heading: 'An event project was assigned to you',
      message: `${input.title} starts ${input.startDate} and includes ${plan.workItems.length} task${plan.workItems.length === 1 ? '' : 's'}.`,
      url: eventUrl(context.env, eventKey),
    },
  ]);
  return context.json({ event: { key: eventKey, reference: `E-${seq}` }, plan }, 201);
}

export async function listEvents(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const query = (context.req.query('q') ?? '').trim().slice(0, 120);
  const stage = (context.req.query('stage') ?? '').trim();
  const clauses = ['1 = 1'];
  const archiveVisibility = eventArchiveVisibilityClause(stage);
  if (archiveVisibility) clauses.push(archiveVisibility);
  const values: unknown[] = [identity.user.id];
  if (query) {
    clauses.push("(e.title LIKE ? ESCAPE '\\' OR e.purpose LIKE ? ESCAPE '\\')");
    const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  if (stage) {
    clauses.push('e.stage = ?');
    values.push(stage);
  }
  const rows = await context.env.DB.prepare(
    `SELECT ${eventColumns},
       ${readinessColumns}
     FROM events e
     JOIN workspace_members wm ON wm.workspace_id = e.workspace_id AND wm.user_id = ?
     JOIN event_workflow_template_versions tv ON tv.id = e.template_version_id
     JOIN event_workflow_templates t ON t.id = tv.template_id
     LEFT JOIN users u ON u.id = e.owner_user_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY e.start_at, e.title LIMIT 500`,
  )
    .bind(...values)
    .all<EventRow & ReadinessCounts>();
  return context.json({
    events: rows.results.map((row) => {
      const { blockers, progress, readiness } = readinessSummary(row);
      return {
        key: row.event_key,
        reference: `E-${row.seq}`,
        title: row.title,
        purpose: row.purpose,
        ministry: row.ministry,
        startAt: row.start_at,
        endAt: row.end_at,
        timezone: row.timezone,
        location: row.location,
        stage: row.stage,
        readiness,
        progress,
        blockers,
        owner: row.owner_name ? { name: row.owner_name, email: row.owner_email } : null,
        template: { key: row.template_key, name: row.template_name },
        source: row.source_system
          ? { system: row.source_system, id: row.source_id, url: row.source_url }
          : null,
        updatedAt: row.updated_at,
      };
    }),
  });
}

export async function getEvent(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);

  const [
    facts,
    channels,
    deliverables,
    workItems,
    variants,
    assets,
    approvals,
    comments,
    activity,
  ] = await Promise.all([
    context.env.DB.prepare(
      `SELECT version, facts_json, change_reason, created_at
         FROM event_fact_versions WHERE event_id = ? ORDER BY version DESC`,
    )
      .bind(event.id)
      .all<{
        version: number;
        facts_json: string;
        change_reason: string | null;
        created_at: string;
      }>(),
    context.env.DB.prepare(
      `SELECT id, channel, campus, language, required, status
         FROM event_channels WHERE event_id = ? ORDER BY channel, campus, language`,
    )
      .bind(event.id)
      .all(),
    context.env.DB.prepare(
      `SELECT d.id, d.deliverable_key, d.title, d.asset_type, d.campus, d.language,
           d.status, d.due_at, d.critical, d.fact_version, d.published_at,
           d.approved_copy_version_id, d.approved_asset_version_id,
           c.channel,
           COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS owner_name,
           u.email AS owner_email
         FROM event_deliverables d
         LEFT JOIN event_channels c ON c.id = d.channel_id
         LEFT JOIN users u ON u.id = d.owner_user_id
         WHERE d.event_id = ? ORDER BY d.due_at, d.title`,
    )
      .bind(event.id)
      .all(),
    context.env.DB.prepare(
      `SELECT wi.id, wi.work_item_key, wi.phase, wi.title, wi.description, wi.status,
           wi.due_at, wi.critical, wi.sort_order, wi.responsibility_id,
           wi.source_metadata_json,
           COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS owner_name,
           u.email AS owner_email,
           GROUP_CONCAT(dep.work_item_key, ',') AS dependency_keys,
           SUM(CASE WHEN dep.id IS NOT NULL AND dep.status NOT IN ('done','not_needed') THEN 1 ELSE 0 END)
             AS dependency_blockers
         FROM event_work_items wi
         LEFT JOIN users u ON u.id = wi.owner_user_id
         LEFT JOIN event_work_item_dependencies wid ON wid.work_item_id = wi.id
         LEFT JOIN event_work_items dep ON dep.id = wid.depends_on_work_item_id
         WHERE wi.event_id = ?
         GROUP BY wi.id ORDER BY wi.sort_order`,
    )
      .bind(event.id)
      .all(),
    context.env.DB.prepare(
      `SELECT cv.id, cv.purpose, cv.language, cv.current_version, cv.approved_version_id,
           v.id AS version_id, v.version, v.fact_version, v.body, v.author_type, v.created_at,
           COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS author_name
         FROM event_copy_variants cv
         LEFT JOIN event_copy_versions v
           ON v.copy_variant_id = cv.id AND v.version = cv.current_version
         LEFT JOIN users u ON u.id = v.created_by_user_id
         WHERE cv.event_id = ? ORDER BY cv.purpose, cv.language`,
    )
      .bind(event.id)
      .all(),
    context.env.DB.prepare(
      `SELECT av.id, av.deliverable_id, av.version, av.label, av.url, av.storage_provider,
           av.provider_file_id, av.checksum_sha256, av.original_filename, av.content_type,
           av.size_bytes, av.is_final, av.finalized_at, av.drive_delivery_status,
           av.drive_file_id, av.drive_web_view_link, av.drive_delivered_at,
           av.delivery_error, av.created_at,
           COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS creator_name
         FROM event_asset_versions av
         JOIN event_deliverables d ON d.id = av.deliverable_id
         LEFT JOIN users u ON u.id = av.created_by_user_id
         WHERE d.event_id = ? ORDER BY av.deliverable_id, av.version DESC`,
    )
      .bind(event.id)
      .all(),
    context.env.DB.prepare(
      `SELECT a.id, a.subject_type, a.subject_id, a.subject_version, a.scope, a.decision,
           a.trusted, a.comment, a.invalidated_at, a.invalidation_reason, a.created_at,
           COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS approver_name
         FROM event_approvals a LEFT JOIN users u ON u.id = a.approver_user_id
         WHERE a.event_id = ? ORDER BY a.id DESC`,
    )
      .bind(event.id)
      .all(),
    context.env.DB.prepare(
      `SELECT c.id, c.subject_type, c.subject_id, c.body, c.source_system,
           c.source_id, c.source_created_at, c.created_at,
           COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email, 'Imported')
             AS author_name
         FROM event_comments c LEFT JOIN users u ON u.id = c.author_user_id
         WHERE c.event_id = ? AND c.deleted_at IS NULL ORDER BY c.id`,
    )
      .bind(event.id)
      .all(),
    context.env.DB.prepare(
      `SELECT a.id, a.action, a.entity_type, a.entity_key, a.changes_json, a.created_at,
           COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email, 'System')
             AS actor_name
         FROM event_activity a LEFT JOIN users u ON u.id = a.actor_user_id
         WHERE a.event_id = ? ORDER BY a.id DESC LIMIT 100`,
    )
      .bind(event.id)
      .all<{ changes_json: string }>(),
  ]);

  const [responsibilities, counts] = await Promise.all([
    context.env.DB.prepare(`SELECT r.*, u.email AS owner_email,
      COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS owner_name
      FROM event_responsibilities r LEFT JOIN users u ON u.id = r.owner_user_id
      WHERE r.event_id = ? ORDER BY r.id`)
      .bind(event.id)
      .all<ResponsibilityRow & { owner_email: string | null; owner_name: string | null }>(),
    eventReadiness(context, event.id),
  ]);
  const currentFact = facts.results[0];
  const summary = readinessSummary(counts);
  const canEdit = await canEditEvent(context, identity, event);

  return context.json({
    event: {
      key: event.event_key,
      reference: `E-${event.seq}`,
      title: event.title,
      purpose: event.purpose,
      ministry: event.ministry,
      startAt: event.start_at,
      endAt: event.end_at,
      timezone: event.timezone,
      location: event.location,
      stage: event.stage,
      readiness: summary.readiness,
      progress: summary.progress,
      blockerCount: summary.blockers,
      workflowMode: event.workflow_mode,
      originalRequest:
        parseJson(event.original_request_json, null) ??
        (facts.results.at(-1) ? parseJson(facts.results.at(-1)?.facts_json, null) : null),
      originalRequestKind: event.original_request_kind ?? 'earliest_saved_facts',
      responsibilities: responsibilities.results.map((r) => ({
        ...r,
        mutation_key: undefined,
        canManage: canEdit || r.owner_user_id === identity.user.id,
      })),
      factsVersion: event.facts_version,
      version: event.version,
      facts: currentFact ? parseJson(currentFact.facts_json, {}) : {},
      factHistory: facts.results.map((row) => ({
        version: row.version,
        facts: parseJson(row.facts_json, {}),
        reason: row.change_reason,
        createdAt: row.created_at,
      })),
      owner: event.owner_name ? { name: event.owner_name, email: event.owner_email } : null,
      template: { key: event.template_key, name: event.template_name },
      source: event.source_system
        ? {
            system: event.source_system,
            id: event.source_id,
            url: event.source_url,
            metadata: parseJson(event.source_metadata_json, {}),
          }
        : null,
      channels: channels.results,
      deliverables: deliverables.results,
      workItems: workItems.results.map((item) => {
        const row = item as {
          responsibility_id: number | null;
          source_metadata_json: string | null;
        };
        const responsibility = responsibilities.results.find((r) => r.id === row.responsibility_id);
        return {
          ...item,
          responsibility_key: responsibility?.responsibility_key ?? null,
          legacy: event.workflow_mode === 'responsibilities' && row.responsibility_id === null,
          canManage: canEdit || responsibility?.owner_user_id === identity.user.id,
        };
      }),
      copyVariants: variants.results,
      assetVersions: assets.results,
      approvals: approvals.results,
      comments: comments.results,
      activity: activity.results.map((row) => ({
        ...row,
        changes: parseJson(row.changes_json, {}),
        changes_json: undefined,
      })),
      canEdit,
      canApprove: await hasPermission(context, identity.user.id, 'events.approve'),
      createdAt: event.created_at,
      updatedAt: event.updated_at,
    },
  });
}

export async function patchEventFacts(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const parsed = eventFactsPatchSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json({ error: 'invalid_event', issues: parsed.error.issues }, 400);
  }
  if (parsed.data.expectedVersion !== event.version) {
    return context.json({ error: 'version_conflict', currentVersion: event.version }, 409);
  }
  const factRow = await context.env.DB.prepare(
    'SELECT facts_json FROM event_fact_versions WHERE event_id = ? AND version = ?',
  )
    .bind(event.id, event.facts_version)
    .first<{ facts_json: string }>();
  const oldFacts = parseJson<Record<string, unknown>>(factRow?.facts_json, {});
  const { changeReason, expectedVersion: _expectedVersion, ...patch } = parsed.data;
  const nextFacts: Record<string, unknown> = { ...oldFacts, ...patch };
  const changedFields = Object.keys(patch).filter(
    (field) => JSON.stringify(oldFacts[field]) !== JSON.stringify(nextFacts[field]),
  );
  if (changedFields.length === 0) return getEvent(context);
  const nextFactVersion = event.facts_version + 1;
  const ownerUserId =
    patch.ownerEmail === undefined
      ? event.owner_user_id
      : await resolveOwner(
          context,
          (await workspaceForUser(context, identity.user.id))?.id ?? 0,
          patch.ownerEmail,
          identity.user.id,
        );
  if (!ownerUserId) return context.json({ error: 'invalid_owner' }, 400);

  const nextInput = eventIntakeSchema.safeParse({
    ...nextFacts,
    templateKey: event.template_key,
    ownerEmail: nextFacts.ownerEmail === undefined ? event.owner_email : nextFacts.ownerEmail,
  });
  if (!nextInput.success) {
    return context.json({ error: 'invalid_event', issues: nextInput.error.issues }, 400);
  }
  const templateVersion = await context.env.DB.prepare(
    `SELECT tv.definition_json
     FROM events e JOIN event_workflow_template_versions tv ON tv.id = e.template_version_id
     WHERE e.id = ?`,
  )
    .bind(event.id)
    .first<{ definition_json: string }>();
  if (!templateVersion) return context.json({ error: 'invalid_template' }, 400);
  const definition = workflowDefinitionSchema.parse(JSON.parse(templateVersion.definition_json));
  const plan = buildEventPlan(nextInput.data, definition, undefined, event.workflow_mode);
  nextFacts.promotionStartDate = plan.promotionStartDate;
  const startAt = `${String(nextFacts.startDate)}T${String(nextFacts.startTime)}:00`;
  const endAt =
    nextFacts.endDate || nextFacts.endTime
      ? `${String(nextFacts.endDate ?? nextFacts.startDate)}T${String(nextFacts.endTime ?? nextFacts.startTime)}:00`
      : null;
  const materialFields = new Set([
    'title',
    'purpose',
    'ministry',
    'communicationPriority',
    'audience',
    'startDate',
    'endDate',
    'startTime',
    'endTime',
    'location',
    'registration',
    'campuses',
    'channels',
    'languages',
    'operations',
    'communicationBrief',
    'creativeBrief',
    'resourceRequests',
    'notes',
  ]);
  const materialChange = changedFields.some((field) => materialFields.has(field));

  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `UPDATE events SET title = ?, purpose = ?, ministry = ?, owner_user_id = ?, start_at = ?,
       end_at = ?, timezone = ?, location = ?, facts_version = ?, version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ? AND version = ?`,
    ).bind(
      nextFacts.title,
      nextFacts.purpose,
      nextFacts.ministry,
      ownerUserId,
      startAt,
      endAt,
      nextFacts.timezone,
      nextFacts.location,
      nextFactVersion,
      event.id,
      event.version,
    ),
    context.env.DB.prepare(
      `INSERT INTO event_fact_versions (
        event_id, version, facts_json, changed_by_user_id, change_reason
       ) VALUES (?, ?, ?, ?, ?)`,
    ).bind(event.id, nextFactVersion, JSON.stringify(nextFacts), identity.user.id, changeReason),
  ];
  statements.push(
    ...(event.workflow_mode === 'responsibilities'
      ? seedResponsibilityStatements(context.env.DB, event.id, nextInput.data)
      : []),
  );
  statements.push(
    context.env.DB.prepare(`UPDATE event_responsibilities SET
    status = 'awaiting_acknowledgment', reviewed_facts_version = NULL, version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE event_id = ?`).bind(event.id),
  );
  if (materialChange) {
    statements.push(
      context.env.DB.prepare(
        `UPDATE event_approvals SET invalidated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         invalidation_reason = ? WHERE event_id = ? AND invalidated_at IS NULL`,
      ).bind(`Event facts changed: ${changedFields.join(', ')}`, event.id),
      context.env.DB.prepare(
        `UPDATE event_deliverables SET status = 'changes_requested', fact_version = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE event_id = ? AND status IN ('approved','scheduled','published')`,
      ).bind(nextFactVersion, event.id),
    );
  }
  statements.push(
    ...(await eventPlanSyncStatements(
      context,
      event,
      nextInput.data,
      plan,
      nextFactVersion,
      ownerUserId,
    )),
  );
  statements.push(
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'event.facts_updated',
      'event',
      event.event_key,
      {
        changedFields,
        factVersion: nextFactVersion,
        materialChange,
        replannedDeliverables: plan.deliverables.length,
        replannedWorkItems: plan.workItems.length,
        reason: changeReason,
      },
    ),
  );
  await context.env.DB.batch(statements);
  if (ownerUserId !== event.owner_user_id) {
    scheduleNotifications(context, [
      {
        userId: ownerUserId,
        actorUserId: identity.user.id,
        kind: 'assignment',
        entityType: 'event',
        entityKey: event.event_key,
        dedupeKey: `assignment:event:${event.event_key}:${ownerUserId}:${nextFactVersion}`,
        subject: `Event assigned: ${String(nextFacts.title)}`,
        heading: 'An event project was assigned to you',
        message: `${String(nextFacts.title)} starts ${String(nextFacts.startDate)}.`,
        url: eventUrl(context.env, event.event_key),
      },
    ]);
  }
  return getEvent(context);
}

export async function patchEventStage(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const parsed = eventStagePatchSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json({ error: 'invalid_stage', issues: parsed.error.issues }, 400);
  }
  if (parsed.data.expectedVersion !== event.version) {
    return context.json({ error: 'version_conflict', currentVersion: event.version }, 409);
  }
  if (
    parsed.data.stage === 'event_ready' &&
    readinessSummary(await eventReadiness(context, event.id)).blockers
  ) {
    return context.json({ error: 'event_not_ready' }, 409);
  }
  if (parsed.data.stage === event.stage) return getEvent(context);

  const results = await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE events SET stage = ?,
       archived_at = CASE WHEN ? = 'archived'
         THEN COALESCE(archived_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ELSE NULL END,
       version = version + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ? AND version = ? AND (? <> 'event_ready' OR ${readinessGateSql})`,
    ).bind(
      parsed.data.stage,
      parsed.data.stage,
      event.id,
      event.version,
      parsed.data.stage,
      event.id,
    ),
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'event.stage_changed',
      'event',
      event.event_key,
      { from: event.stage, to: parsed.data.stage, reason: parsed.data.reason },
      undefined,
      true,
    ),
  ]);
  if (!results[0]?.meta.changes)
    return context.json({ error: 'event_not_ready_or_version_conflict' }, 409);
  return getEvent(context);
}

export async function patchDeliverable(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const parsed = deliverablePatchSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'invalid_deliverable' }, 400);
  const deliverable = await context.env.DB.prepare(
    'SELECT id, deliverable_key, status FROM event_deliverables WHERE event_id = ? AND deliverable_key = ?',
  )
    .bind(event.id, context.req.param('deliverableKey'))
    .first<{ id: number; deliverable_key: string; status: string }>();
  if (!deliverable) return context.json({ error: 'not_found' }, 404);
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE event_deliverables SET status = ?,
       published_at = CASE WHEN ? = 'published' THEN strftime('%Y-%m-%dT%H:%M:%SZ','now')
                           ELSE published_at END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    ).bind(parsed.data.status, parsed.data.status, deliverable.id),
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'deliverable.status_changed',
      'deliverable',
      deliverable.deliverable_key,
      { from: deliverable.status, to: parsed.data.status },
    ),
  ]);
  return context.json({
    deliverable: { key: deliverable.deliverable_key, status: parsed.data.status },
  });
}

export async function listAssignedEventWorkItems(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const query = (context.req.query('q') ?? '').trim().slice(0, 120);
  const includeCompleted = context.req.query('include') === 'completed';
  const clauses = [
    'wi.owner_user_id = ?',
    'e.archived_at IS NULL',
    includeCompleted
      ? "wi.status IN ('done','not_needed')"
      : "wi.status NOT IN ('done','not_needed')",
  ];
  const values: unknown[] = [identity.user.id, identity.user.id];
  if (query) {
    clauses.push("(wi.title LIKE ? ESCAPE '\\' OR e.title LIKE ? ESCAPE '\\')");
    const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    values.push(`%${escaped}%`, `%${escaped}%`);
  }
  const rows = await context.env.DB.prepare(
    `SELECT wi.work_item_key, wi.phase, wi.title, wi.description, wi.status, wi.due_at,
       wi.critical, wi.updated_at, e.event_key, e.seq AS event_seq, e.title AS event_title,
       e.ministry, e.stage,
       COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS owner_name,
       u.email AS owner_email, u.photo_url AS owner_photo_url,
       SUM(CASE WHEN dep.id IS NOT NULL AND dep.status NOT IN ('done','not_needed') THEN 1 ELSE 0 END)
         AS dependency_blockers
     FROM event_work_items wi
     JOIN events e ON e.id = wi.event_id
     JOIN workspace_members wm ON wm.workspace_id = e.workspace_id AND wm.user_id = ?
     LEFT JOIN users u ON u.id = wi.owner_user_id
     LEFT JOIN event_work_item_dependencies wid ON wid.work_item_id = wi.id
     LEFT JOIN event_work_items dep ON dep.id = wid.depends_on_work_item_id
     WHERE ${clauses.join(' AND ')}
     GROUP BY wi.id
     ORDER BY wi.due_at IS NULL, wi.due_at, e.start_at, wi.sort_order
     LIMIT 500`,
  )
    .bind(...values)
    .all();
  return context.json({
    workItems: rows.results.map((row) => ({
      ...row,
      eventReference: `E-${String((row as { event_seq: number }).event_seq)}`,
    })),
  });
}

export async function createWorkItem(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  const parsed = eventWorkItemCreateSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'invalid_work_item' }, 400);
  const responsibility = parsed.data.responsibilityKey
    ? await responsibilityFor(context, event.id, parsed.data.responsibilityKey)
    : null;
  if (parsed.data.responsibilityKey && !responsibility)
    return context.json({ error: 'invalid_responsibility' }, 400);
  if (event.workflow_mode === 'responsibilities' && !responsibility)
    return context.json({ error: 'responsibility_required' }, 400);
  if (
    !(await canEditEvent(context, identity, event)) &&
    responsibility?.owner_user_id !== identity.user.id
  ) {
    return context.json({ error: 'forbidden' }, 403);
  }
  if (responsibility?.status === 'not_needed')
    return context.json({ error: 'responsibility_not_active' }, 409);
  const workspace = await workspaceForUser(context, identity.user.id);
  const ownerUserId = parsed.data.ownerEmail
    ? await resolveOwner(context, workspace?.id ?? 0, parsed.data.ownerEmail, identity.user.id)
    : null;
  if (parsed.data.ownerEmail && !ownerUserId) {
    return context.json({ error: 'invalid_owner' }, 400);
  }
  const workItemKey = `EWI-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const maximum = await context.env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) AS maximum FROM event_work_items WHERE event_id = ?',
  )
    .bind(event.id)
    .first<{ maximum: number }>();
  const sortOrder = (maximum?.maximum ?? -1) + 1;
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO event_work_items (
        work_item_key, event_id, phase, title, description, status, due_at, owner_user_id,
        critical, sort_order, source_metadata_json, responsibility_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      workItemKey,
      event.id,
      parsed.data.phase,
      parsed.data.title,
      parsed.data.description,
      parsed.data.status,
      parsed.data.dueDate,
      ownerUserId,
      parsed.data.critical ? 1 : 0,
      sortOrder,
      JSON.stringify({ custom: true }),
      responsibility?.id ?? null,
    ),
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'work_item.created',
      'work_item',
      workItemKey,
      {
        title: parsed.data.title,
        phase: parsed.data.phase,
        status: parsed.data.status,
        ownerUserId,
        responsibilityKey: responsibility?.responsibility_key ?? null,
        dueDate: parsed.data.dueDate,
        critical: parsed.data.critical,
      },
    ),
  ]);
  if (ownerUserId) {
    scheduleNotifications(context, [
      {
        userId: ownerUserId,
        actorUserId: identity.user.id,
        kind: 'assignment',
        entityType: 'event_work_item',
        entityKey: workItemKey,
        dedupeKey: `assignment:event-work:${workItemKey}:${ownerUserId}`,
        subject: `Event task assigned: ${parsed.data.title}`,
        heading: `Work for ${event.title} was assigned to you`,
        message: `${parsed.data.title}${parsed.data.dueDate ? ` is due ${parsed.data.dueDate}.` : '.'}`,
        url: eventUrl(context.env, event.event_key),
      },
    ]);
  }
  return context.json(
    {
      workItem: {
        key: workItemKey,
        title: parsed.data.title,
        description: parsed.data.description,
        status: parsed.data.status,
        dueDate: parsed.data.dueDate,
        phase: parsed.data.phase,
        critical: parsed.data.critical,
        ownerUserId,
      },
    },
    201,
  );
}

export async function patchWorkItem(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  const parsed = eventWorkItemPatchSchema.safeParse(await context.req.json());
  if (!parsed.success) return context.json({ error: 'invalid_work_item' }, 400);
  const item = await context.env.DB.prepare(
    `SELECT id, work_item_key, status, owner_user_id, title, description, due_at, phase, critical, responsibility_id
     FROM event_work_items WHERE event_id = ? AND work_item_key = ?`,
  )
    .bind(event.id, context.req.param('workItemKey'))
    .first<{
      id: number;
      work_item_key: string;
      status: string;
      owner_user_id: number | null;
      title: string;
      description: string;
      due_at: string | null;
      phase: string;
      critical: number;
      responsibility_id: number | null;
    }>();
  if (!item) return context.json({ error: 'not_found' }, 404);
  const sourceResponsibility =
    item.responsibility_id === null
      ? null
      : await context.env.DB.prepare(
          'SELECT * FROM event_responsibilities WHERE event_id = ? AND id = ?',
        )
          .bind(event.id, item.responsibility_id)
          .first<ResponsibilityRow>();
  const eventManager = await canEditEvent(context, identity, event);
  const canManage = eventManager || sourceResponsibility?.owner_user_id === identity.user.id;
  const targetResponsibility =
    parsed.data.responsibilityKey === undefined
      ? sourceResponsibility
      : parsed.data.responsibilityKey === null
        ? null
        : await responsibilityFor(context, event.id, parsed.data.responsibilityKey);
  if (parsed.data.responsibilityKey && !targetResponsibility)
    return context.json({ error: 'invalid_responsibility' }, 400);
  if (
    event.workflow_mode === 'responsibilities' &&
    item.responsibility_id !== null &&
    !targetResponsibility
  ) {
    return context.json({ error: 'responsibility_required' }, 400);
  }
  if (
    parsed.data.responsibilityKey !== undefined &&
    !eventManager &&
    (!targetResponsibility || targetResponsibility.owner_user_id !== identity.user.id)
  ) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const isAssignee = item.owner_user_id === identity.user.id;
  const changesTaskDetails = Object.keys(parsed.data).some((key) => key !== 'status');
  if (!canManage && (!isAssignee || changesTaskDetails)) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const workspace = await workspaceForUser(context, identity.user.id);
  const ownerUserId =
    parsed.data.ownerEmail === undefined
      ? item.owner_user_id
      : parsed.data.ownerEmail === null
        ? null
        : await resolveOwner(context, workspace?.id ?? 0, parsed.data.ownerEmail, identity.user.id);
  if (parsed.data.ownerEmail && !ownerUserId) {
    return context.json({ error: 'invalid_owner' }, 400);
  }
  const nextStatus = parsed.data.status ?? item.status;
  const nextTitle = parsed.data.title ?? item.title;
  const nextDescription = parsed.data.description ?? item.description;
  const nextDueDate = parsed.data.dueDate === undefined ? item.due_at : parsed.data.dueDate;
  const nextPhase = parsed.data.phase ?? item.phase;
  const nextCritical =
    parsed.data.critical === undefined ? item.critical : parsed.data.critical ? 1 : 0;
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE event_work_items SET status = ?, owner_user_id = ?, title = ?, description = ?,
       due_at = ?, phase = ?, critical = ?, responsibility_id = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    ).bind(
      nextStatus,
      ownerUserId,
      nextTitle,
      nextDescription,
      nextDueDate,
      nextPhase,
      nextCritical,
      targetResponsibility?.id ?? null,
      item.id,
    ),
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      changesTaskDetails ? 'work_item.updated' : 'work_item.status_changed',
      'work_item',
      item.work_item_key,
      {
        status: { from: item.status, to: nextStatus },
        ownerUserId: { from: item.owner_user_id, to: ownerUserId },
        title: { from: item.title, to: nextTitle },
        description: { from: item.description, to: nextDescription },
        dueDate: { from: item.due_at, to: nextDueDate },
        phase: { from: item.phase, to: nextPhase },
        critical: { from: Boolean(item.critical), to: Boolean(nextCritical) },
        responsibilityId: { from: item.responsibility_id, to: targetResponsibility?.id ?? null },
      },
    ),
  ]);
  if (ownerUserId && item.owner_user_id !== ownerUserId) {
    scheduleNotifications(context, [
      {
        userId: ownerUserId,
        actorUserId: identity.user.id,
        kind: 'assignment',
        entityType: 'event_work_item',
        entityKey: item.work_item_key,
        dedupeKey: `assignment:event-work:${item.work_item_key}:${ownerUserId}:${Date.now()}`,
        subject: `Event task assigned: ${nextTitle}`,
        heading: `Work for ${event.title} was assigned to you`,
        message: `${nextTitle}${nextDueDate ? ` is due ${nextDueDate.slice(0, 10)}.` : '.'}`,
        url: eventUrl(context.env, event.event_key),
      },
    ]);
  }
  return context.json({
    workItem: {
      key: item.work_item_key,
      status: nextStatus,
      ownerUserId,
      title: nextTitle,
      description: nextDescription,
      dueDate: nextDueDate,
      phase: nextPhase,
      critical: Boolean(nextCritical),
    },
  });
}

export async function createCopyVersion(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const parsed = copyVersionMutationSchema.safeParse(await context.req.json());
  if (!parsed.success)
    return context.json({ error: 'invalid_copy', issues: parsed.error.issues }, 400);
  const variant = await context.env.DB.prepare(
    `SELECT id, current_version FROM event_copy_variants
     WHERE event_id = ? AND purpose = ? AND language = ?`,
  )
    .bind(event.id, parsed.data.purpose, parsed.data.language)
    .first<{ id: number; current_version: number }>();
  if (!variant) return context.json({ error: 'copy_variant_not_requested' }, 400);
  const version = variant.current_version + 1;
  await context.env.DB.prepare(
    `INSERT INTO event_copy_versions (
      copy_variant_id, version, source_copy_version_id, fact_version, body, author_type,
      created_by_user_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      variant.id,
      version,
      parsed.data.sourceCopyVersionId ?? null,
      event.facts_version,
      parsed.data.body,
      parsed.data.authorType,
      identity.user.id,
    )
    .run();
  const copyVersion = await context.env.DB.prepare(
    'SELECT id FROM event_copy_versions WHERE copy_variant_id = ? AND version = ?',
  )
    .bind(variant.id, version)
    .first<{ id: number }>();
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE event_copy_variants SET current_version = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    ).bind(version, variant.id),
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'copy.version_created',
      'copy',
      String(variant.id),
      {
        version,
        purpose: parsed.data.purpose,
        language: parsed.data.language,
        authorType: parsed.data.authorType,
        factVersion: event.facts_version,
      },
    ),
  ]);
  return context.json(
    { copyVersion: { id: copyVersion?.id, variantId: variant.id, version } },
    201,
  );
}

export async function createAssetVersion(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const parsed = assetVersionMutationSchema.safeParse(await context.req.json());
  if (!parsed.success)
    return context.json({ error: 'invalid_asset', issues: parsed.error.issues }, 400);
  const deliverable = await context.env.DB.prepare(
    `SELECT d.id, d.deliverable_key, d.status, COALESCE(MAX(av.version), 0) AS current_version
     FROM event_deliverables d
     LEFT JOIN event_asset_versions av ON av.deliverable_id = d.id
     WHERE d.event_id = ? AND d.deliverable_key = ? GROUP BY d.id`,
  )
    .bind(event.id, context.req.param('deliverableKey'))
    .first<{ id: number; deliverable_key: string; status: string; current_version: number }>();
  if (!deliverable) return context.json({ error: 'not_found' }, 404);
  const version = deliverable.current_version + 1;
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO event_asset_versions (
        deliverable_id, version, label, url, storage_provider, provider_file_id,
        created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      deliverable.id,
      version,
      parsed.data.label,
      parsed.data.url,
      parsed.data.storageProvider,
      parsed.data.providerFileId,
      identity.user.id,
    ),
    context.env.DB.prepare(
      `UPDATE event_deliverables SET status = 'review_requested',
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    ).bind(deliverable.id),
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'asset.version_created',
      'deliverable',
      deliverable.deliverable_key,
      { version, url: parsed.data.url, label: parsed.data.label },
    ),
    ...(deliverable.status === 'review_requested'
      ? []
      : [
          activityStatement(
            context,
            event.id,
            identity.auditUserId,
            'deliverable.status_changed',
            'deliverable',
            deliverable.deliverable_key,
            { from: deliverable.status, to: 'review_requested', reason: 'asset_link_added' },
          ),
        ]),
  ]);
  return context.json(
    { assetVersion: { deliverableKey: deliverable.deliverable_key, version } },
    201,
  );
}

const uploadTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
export const maximumAssetBytes = 50 * 1024 * 1024;

export function validateAssetUpload(file: { size: number; type: string }) {
  if (file.size <= 0) return 'asset_empty';
  if (file.size > maximumAssetBytes) return 'asset_too_large';
  if (!uploadTypes.has(file.type.toLowerCase())) return 'asset_invalid_type';
  return null;
}

function checksumHex(buffer: ArrayBuffer) {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function assetDownloadUrl(eventKey: string, assetId: number) {
  return `/api/events/${encodeURIComponent(eventKey)}/assets/${assetId}/download`;
}

function safeAttachmentFilename(filename: string) {
  return [...filename]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .replaceAll(/["\\]/g, '')
    .slice(0, 240);
}

export async function uploadAssetVersion(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  if (!context.env.EVENT_ASSETS) return context.json({ error: 'object_store_unavailable' }, 503);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  if (!(await canEditEvent(context, identity, event))) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const deliverable = await context.env.DB.prepare(
    `SELECT d.id, d.deliverable_key, d.status, COALESCE(MAX(av.version), 0) AS current_version
     FROM event_deliverables d
     LEFT JOIN event_asset_versions av ON av.deliverable_id = d.id
     WHERE d.event_id = ? AND d.deliverable_key = ? GROUP BY d.id`,
  )
    .bind(event.id, context.req.param('deliverableKey'))
    .first<{ id: number; deliverable_key: string; status: string; current_version: number }>();
  if (!deliverable) return context.json({ error: 'not_found' }, 404);

  const form = await context.req.raw.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return context.json({ error: 'asset_required' }, 400);
  const uploadError = validateAssetUpload(file);
  if (uploadError) return context.json({ error: uploadError }, 400);
  const labelValue = form.get('label');
  const label = typeof labelValue === 'string' ? labelValue.trim().slice(0, 240) : '';
  const bytes = await file.arrayBuffer();
  const checksum = checksumHex(await crypto.subtle.digest('SHA-256', bytes));
  const version = deliverable.current_version + 1;
  const originalFilename = safeAttachmentFilename(file.name) || `asset-v${version}`;
  const objectKey = `events/${event.event_key}/${deliverable.deliverable_key}/${crypto.randomUUID()}`;
  await context.env.EVENT_ASSETS.put(objectKey, bytes, {
    httpMetadata: {
      contentType: file.type,
      contentDisposition: `attachment; filename="${originalFilename}"`,
    },
    customMetadata: {
      eventKey: event.event_key,
      deliverableKey: deliverable.deliverable_key,
      originalFilename,
      version: String(version),
    },
  });

  let inserted: { id: number } | null = null;
  try {
    inserted = await context.env.DB.prepare(
      `INSERT INTO event_asset_versions (
        deliverable_id, version, label, url, storage_provider, provider_file_id,
        checksum_sha256, original_filename, content_type, size_bytes, object_key,
        created_by_user_id
       ) VALUES (?, ?, ?, '', 'r2', ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
      .bind(
        deliverable.id,
        version,
        label,
        objectKey,
        checksum,
        originalFilename,
        file.type,
        file.size,
        objectKey,
        identity.user.id,
      )
      .first<{ id: number }>();
    if (!inserted) throw new Error('Asset version was not recorded.');
    const url = assetDownloadUrl(event.event_key, inserted.id);
    const statements = [
      context.env.DB.prepare('UPDATE event_asset_versions SET url = ? WHERE id = ?').bind(
        url,
        inserted.id,
      ),
      context.env.DB.prepare(
        `UPDATE event_deliverables SET status = 'review_requested',
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
      ).bind(deliverable.id),
      activityStatement(
        context,
        event.id,
        identity.auditUserId,
        'asset.version_uploaded',
        'asset',
        String(inserted.id),
        {
          deliverableKey: deliverable.deliverable_key,
          version,
          label,
          filename: originalFilename,
          sizeBytes: file.size,
          checksumSha256: checksum,
        },
      ),
    ];
    if (deliverable.status !== 'review_requested') {
      statements.push(
        activityStatement(
          context,
          event.id,
          identity.auditUserId,
          'deliverable.status_changed',
          'deliverable',
          deliverable.deliverable_key,
          { from: deliverable.status, to: 'review_requested', reason: 'asset_uploaded' },
        ),
      );
    }
    await context.env.DB.batch(statements);
    return context.json(
      {
        assetVersion: {
          id: inserted.id,
          deliverableKey: deliverable.deliverable_key,
          version,
          url,
        },
      },
      201,
    );
  } catch (error) {
    if (!inserted) await context.env.EVENT_ASSETS.delete(objectKey);
    throw error;
  }
}

export async function downloadAssetVersion(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  if (!context.env.EVENT_ASSETS) return context.json({ error: 'object_store_unavailable' }, 503);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  const asset = await context.env.DB.prepare(
    `SELECT av.object_key, av.original_filename, av.content_type
     FROM event_asset_versions av
     JOIN event_deliverables d ON d.id = av.deliverable_id
     WHERE av.id = ? AND d.event_id = ? AND av.object_key IS NOT NULL`,
  )
    .bind(context.req.param('assetId'), event.id)
    .first<{ object_key: string; original_filename: string | null; content_type: string | null }>();
  if (!asset) return context.json({ error: 'not_found' }, 404);
  const object = await context.env.EVENT_ASSETS.get(asset.object_key);
  if (!object) return context.json({ error: 'asset_missing' }, 404);
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${safeAttachmentFilename(asset.original_filename ?? 'event-asset')}"`,
    'Content-Type': asset.content_type ?? 'application/octet-stream',
    ETag: object.httpEtag,
  });
  return new Response(object.body, { headers });
}

export async function finalizeAssetVersion(context: AppContext) {
  const identity = await eventIdentity(context, 'events.approve');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  const asset = await context.env.DB.prepare(
    `SELECT av.id, av.version, av.label, av.url, av.object_key, av.original_filename,
       av.content_type, av.size_bytes, d.id AS deliverable_id, d.deliverable_key,
       d.asset_type, d.approved_asset_version_id
     FROM event_asset_versions av
     JOIN event_deliverables d ON d.id = av.deliverable_id
     WHERE av.id = ? AND d.event_id = ?`,
  )
    .bind(context.req.param('assetId'), event.id)
    .first<{
      id: number;
      version: number;
      label: string;
      url: string;
      object_key: string | null;
      original_filename: string | null;
      content_type: string | null;
      size_bytes: number | null;
      deliverable_id: number;
      deliverable_key: string;
      asset_type: string;
      approved_asset_version_id: number | null;
    }>();
  if (!asset) return context.json({ error: 'not_found' }, 404);
  if (asset.approved_asset_version_id !== asset.id) {
    return context.json({ error: 'asset_not_approved' }, 409);
  }

  let deliveryStatus = asset.object_key ? 'pending_configuration' : 'external_link';
  let driveFileId: string | null = null;
  let driveWebViewLink: string | null = null;
  let deliveryError: string | null = null;
  if (asset.object_key && context.env.EVENT_ASSETS && driveIsConfigured(context.env)) {
    const object = await context.env.EVENT_ASSETS.get(asset.object_key);
    if (!object) return context.json({ error: 'asset_missing' }, 404);
    try {
      const delivered = await deliverAssetToDrive(context.env, {
        body: object.body,
        contentType: asset.content_type ?? 'application/octet-stream',
        eventKey: event.event_key,
        eventReference: `E-${event.seq}`,
        eventStartAt: event.start_at,
        eventTitle: event.title,
        filename:
          asset.original_filename ?? `${event.event_key}-${asset.asset_type}-v${asset.version}`,
        size: asset.size_bytes ?? object.size,
        version: asset.version,
        deliverableKey: asset.deliverable_key,
      });
      deliveryStatus = 'delivered';
      driveFileId = delivered.id;
      driveWebViewLink = delivered.webViewLink;
    } catch (error) {
      deliveryStatus = 'failed';
      deliveryError = (
        error instanceof Error ? error.message : 'Google Drive delivery failed.'
      ).slice(0, 500);
    }
  }

  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE event_asset_versions SET is_final = 0 WHERE deliverable_id = ? AND id <> ?`,
    ).bind(asset.deliverable_id, asset.id),
    context.env.DB.prepare(
      `UPDATE event_asset_versions SET is_final = 1,
       finalized_at = COALESCE(finalized_at, strftime('%Y-%m-%dT%H:%M:%SZ','now')),
       drive_delivery_status = ?, drive_file_id = ?, drive_web_view_link = ?,
       drive_delivered_at = CASE WHEN ? = 'delivered' THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE drive_delivered_at END,
       delivery_error = ? WHERE id = ?`,
    ).bind(deliveryStatus, driveFileId, driveWebViewLink, deliveryStatus, deliveryError, asset.id),
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'asset.finalized',
      'asset',
      String(asset.id),
      {
        deliverableKey: asset.deliverable_key,
        version: asset.version,
        deliveryStatus,
        driveFileId,
      },
    ),
  ]);
  return context.json({
    asset: {
      id: asset.id,
      version: asset.version,
      isFinal: true,
      driveDeliveryStatus: deliveryStatus,
      driveWebViewLink,
    },
  });
}

async function approvalSubjectBelongsToEvent(
  context: AppContext,
  eventId: number,
  subjectType: string,
  subjectId: number,
) {
  if (subjectType === 'event') return subjectId === eventId;
  if (subjectType === 'deliverable') {
    const row = await context.env.DB.prepare(
      'SELECT 1 AS found FROM event_deliverables WHERE event_id = ? AND id = ?',
    )
      .bind(eventId, subjectId)
      .first();
    return Boolean(row);
  }
  if (subjectType === 'asset') {
    const row = await context.env.DB.prepare(
      `SELECT 1 AS found FROM event_asset_versions av
       JOIN event_deliverables d ON d.id = av.deliverable_id
       WHERE d.event_id = ? AND av.id = ?`,
    )
      .bind(eventId, subjectId)
      .first();
    return Boolean(row);
  }
  const row = await context.env.DB.prepare(
    `SELECT 1 AS found FROM event_copy_versions cv
     JOIN event_copy_variants variant ON variant.id = cv.copy_variant_id
     WHERE variant.event_id = ? AND cv.id = ?`,
  )
    .bind(eventId, subjectId)
    .first();
  return Boolean(row);
}

export async function createApproval(context: AppContext) {
  const identity = await eventIdentity(context, 'events.approve');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  const parsed = approvalMutationSchema.safeParse(await context.req.json());
  if (!parsed.success)
    return context.json({ error: 'invalid_approval', issues: parsed.error.issues }, 400);
  if (
    !(await approvalSubjectBelongsToEvent(
      context,
      event.id,
      parsed.data.subjectType,
      parsed.data.subjectId,
    ))
  ) {
    return context.json({ error: 'invalid_approval_subject' }, 400);
  }
  if (
    parsed.data.scope === 'event_ready' &&
    parsed.data.decision === 'approved' &&
    readinessSummary(await eventReadiness(context, event.id)).blockers
  ) {
    return context.json({ error: 'event_not_ready' }, 409);
  }
  const requiresReadiness =
    parsed.data.scope === 'event_ready' && parsed.data.decision === 'approved';
  if (
    requiresReadiness &&
    (parsed.data.subjectType !== 'event' || parsed.data.subjectVersion !== event.version)
  ) {
    return context.json({ error: 'invalid_approval_subject' }, 400);
  }
  const affectedDeliverable =
    parsed.data.subjectType === 'asset'
      ? await context.env.DB.prepare(
          `SELECT d.deliverable_key, d.status FROM event_deliverables d
           JOIN event_asset_versions av ON av.deliverable_id = d.id
           WHERE av.id = ? AND d.event_id = ?`,
        )
          .bind(parsed.data.subjectId, event.id)
          .first<{ deliverable_key: string; status: string }>()
      : parsed.data.subjectType === 'deliverable'
        ? await context.env.DB.prepare(
            `SELECT deliverable_key, status FROM event_deliverables WHERE id = ? AND event_id = ?`,
          )
            .bind(parsed.data.subjectId, event.id)
            .first<{ deliverable_key: string; status: string }>()
        : null;
  const statements: SqlStatement[] = [
    context.env.DB.prepare(
      `INSERT INTO event_approvals (
        event_id, subject_type, subject_id, subject_version, scope, decision,
        approver_user_id, comment
       ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE (? = 0 OR ${readinessGateSql})
         AND (? = 0 OR (SELECT version FROM events WHERE id = ?) = ?)`,
    ).bind(
      event.id,
      parsed.data.subjectType,
      parsed.data.subjectId,
      parsed.data.subjectVersion,
      parsed.data.scope,
      parsed.data.decision,
      identity.user.id,
      parsed.data.comment,
      requiresReadiness ? 1 : 0,
      event.id,
      requiresReadiness ? 1 : 0,
      event.id,
      parsed.data.subjectVersion,
    ),
  ];
  if (parsed.data.subjectType === 'copy') {
    statements.push(
      context.env.DB.prepare(
        `UPDATE event_copy_variants SET approved_version_id = CASE WHEN ? = 'approved' THEN ? ELSE NULL END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = (SELECT copy_variant_id FROM event_copy_versions WHERE id = ?)`,
      ).bind(parsed.data.decision, parsed.data.subjectId, parsed.data.subjectId),
    );
  }
  if (parsed.data.subjectType === 'asset') {
    statements.push(
      context.env.DB.prepare(
        `UPDATE event_deliverables SET
         approved_asset_version_id = CASE WHEN ? = 'approved' THEN ? ELSE NULL END,
         status = CASE WHEN ? = 'approved' THEN 'approved' ELSE 'changes_requested' END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE id = (SELECT deliverable_id FROM event_asset_versions WHERE id = ?)`,
      ).bind(
        parsed.data.decision,
        parsed.data.subjectId,
        parsed.data.decision,
        parsed.data.subjectId,
      ),
    );
  }
  if (parsed.data.subjectType === 'deliverable') {
    statements.push(
      context.env.DB.prepare(
        `UPDATE event_deliverables SET
         status = CASE WHEN ? = 'approved' THEN 'approved' ELSE 'changes_requested' END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
      ).bind(parsed.data.decision, parsed.data.subjectId),
    );
  }
  const nextDeliverableStatus =
    parsed.data.decision === 'approved' ? 'approved' : 'changes_requested';
  if (affectedDeliverable && affectedDeliverable.status !== nextDeliverableStatus) {
    statements.push(
      activityStatement(
        context,
        event.id,
        identity.auditUserId,
        'deliverable.status_changed',
        'deliverable',
        affectedDeliverable.deliverable_key,
        {
          from: affectedDeliverable.status,
          to: nextDeliverableStatus,
          reason: 'approval_decision',
        },
      ),
    );
  }
  statements.push(
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'approval.recorded',
      parsed.data.subjectType,
      String(parsed.data.subjectId),
      {
        decision: parsed.data.decision,
        scope: parsed.data.scope,
        subjectVersion: parsed.data.subjectVersion,
      },
      undefined,
      requiresReadiness,
    ),
  );
  const results = await context.env.DB.batch(statements);
  if (!results[0]?.meta.changes)
    return context.json({ error: 'event_not_ready_or_version_conflict' }, 409);
  return context.json({ approval: { decision: parsed.data.decision } }, 201);
}

export async function createEventComment(context: AppContext) {
  const identity = await eventIdentity(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const event = await accessibleEvent(
    context,
    identity.user.id,
    context.req.param('eventKey') ?? '',
  );
  if (!event) return context.json({ error: 'not_found' }, 404);
  const input = await context.req.json<{
    body?: unknown;
    subjectType?: unknown;
    subjectId?: unknown;
  }>();
  const body = typeof input.body === 'string' ? input.body.trim().slice(0, 10_000) : '';
  const subjectType =
    typeof input.subjectType === 'string' &&
    ['event', 'deliverable', 'copy', 'asset', 'work_item'].includes(input.subjectType)
      ? input.subjectType
      : 'event';
  const subjectId = typeof input.subjectId === 'number' ? input.subjectId : null;
  if (!body) return context.json({ error: 'comment_required' }, 400);
  const result = await context.env.DB.prepare(
    `INSERT INTO event_comments (event_id, subject_type, subject_id, author_user_id, body)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(event.id, subjectType, subjectId, identity.user.id, body)
    .run();
  const commentId = Number(result.meta.last_row_id);
  const mentions = await mentionedUserIds(context.env, body);
  const statements = [
    activityStatement(
      context,
      event.id,
      identity.auditUserId,
      'comment.created',
      subjectType,
      String(subjectId ?? event.id),
      {
        commentId,
      },
    ),
    ...mentions.map((userId) =>
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO comment_mentions (subject_type, comment_id, mentioned_user_id)
         VALUES ('event', ?, ?)`,
      ).bind(commentId, userId),
    ),
  ];
  await context.env.DB.batch([...statements]);
  const notifications: UserNotification[] = mentions.map((userId) => ({
    userId,
    actorUserId: identity.user.id,
    kind: 'mention',
    entityType: 'event',
    entityKey: event.event_key,
    dedupeKey: `mention:event-comment:${commentId}:${userId}`,
    subject: `You were mentioned: ${event.title}`,
    heading: 'You were mentioned in an event comment',
    message: body,
    url: eventUrl(context.env, event.event_key),
  }));
  const mentioned = new Set(mentions);
  for (const userId of new Set([event.owner_user_id, event.created_by_user_id])) {
    if (!userId || userId === identity.user.id || mentioned.has(userId)) continue;
    notifications.push({
      userId,
      actorUserId: identity.user.id,
      kind: 'comment',
      entityType: 'event',
      entityKey: event.event_key,
      dedupeKey: `comment:event:${commentId}:${userId}`,
      subject: `New event comment: ${event.title}`,
      heading: 'An event you follow has a new comment',
      message: body,
      url: eventUrl(context.env, event.event_key),
    });
  }
  scheduleNotifications(context, notifications);
  return context.json({ comment: { id: commentId, body, mentions } }, 201);
}
