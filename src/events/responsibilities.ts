import type { SqlDatabase } from '../platform/ports';
import type { EventIntake } from './schemas';

export const responsibilityAreas = [
  'communications',
  'facilities',
  'production',
  'registration',
  'finance',
  'hospitality',
  'transportation',
  'volunteers',
  'safety_childcare',
  'other',
] as const;
export type ResponsibilityArea = (typeof responsibilityAreas)[number];

export function requestedResponsibilityAreas(input: EventIntake): ResponsibilityArea[] {
  const areas = new Set<ResponsibilityArea>();
  if (input.channels.length) areas.add('communications');
  if (input.registration.required) areas.add('registration');
  if ((input.registration.cost ?? 0) > 0) areas.add('finance');
  for (const operation of input.operations) {
    areas.add(
      operation === 'food'
        ? 'hospitality'
        : operation === 'vendors'
          ? 'other'
          : operation === 'media'
            ? 'communications'
            : operation,
    );
  }
  if (input.resourceRequests.rooms.length || input.resourceRequests.building.length)
    areas.add('facilities');
  if (input.resourceRequests.technology.length) areas.add('production');
  if (input.resourceRequests.transportation.length) areas.add('transportation');
  if (!areas.size) areas.add('other');
  return [...areas];
}

export function seedResponsibilityStatements(db: SqlDatabase, eventId: number, input: EventIntake) {
  return requestedResponsibilityAreas(input).map((area) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO event_responsibilities (responsibility_key, event_id, area)
     VALUES (?, ?, ?)`,
      )
      .bind(
        `ER-${crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`,
        eventId,
        area,
      ),
  );
}

// Shared by detail, list, and the event-ready gate. Legacy generated work stays visible, but
// after conversion only explicitly adopted/created required work participates in readiness.
export const readinessColumns = `
  (SELECT COUNT(*) FROM event_deliverables d WHERE d.event_id = e.id AND d.critical = 1
    AND d.status <> 'not_requested') AS deliverable_count,
  (SELECT COUNT(*) FROM event_deliverables d WHERE d.event_id = e.id AND d.critical = 1
    AND d.status NOT IN ('approved','scheduled','published','retired','not_requested')) AS deliverable_blockers,
  (SELECT COUNT(*) FROM event_work_items wi WHERE wi.event_id = e.id AND wi.critical = 1
    AND (e.workflow_mode = 'legacy' OR wi.responsibility_id IS NOT NULL)) AS work_item_count,
  (SELECT COUNT(*) FROM event_work_items wi WHERE wi.event_id = e.id AND wi.critical = 1
    AND (e.workflow_mode = 'legacy' OR wi.responsibility_id IS NOT NULL)
    AND wi.status NOT IN ('done','not_needed')) AS work_item_blockers,
  (SELECT COUNT(*) FROM event_responsibilities r WHERE r.event_id = e.id
    AND e.workflow_mode = 'responsibilities') AS responsibility_count,
  (SELECT COUNT(*) FROM event_responsibilities r WHERE r.event_id = e.id
    AND e.workflow_mode = 'responsibilities' AND r.status <> 'not_needed'
    AND (r.status <> 'ready' OR r.reviewed_facts_version IS NOT e.facts_version OR NOT EXISTS (
      SELECT 1 FROM users u JOIN workspace_members wm ON wm.user_id = u.id
      WHERE u.id = r.owner_user_id AND u.status = 'active' AND wm.workspace_id = e.workspace_id
    ))) AS responsibility_blockers,
  CASE WHEN e.workflow_mode = 'responsibilities' AND COALESCE((SELECT
    json_extract(f.facts_json, '$.requestApprovalConfirmed') FROM event_fact_versions f
    WHERE f.event_id = e.id AND f.version = e.facts_version), 0) <> 1 THEN 1 ELSE 0 END AS approval_blockers`;

export type ReadinessCounts = {
  deliverable_count: number;
  deliverable_blockers: number;
  work_item_count: number;
  work_item_blockers: number;
  responsibility_count: number;
  responsibility_blockers: number;
  approval_blockers: number;
};
export function readinessSummary(row: ReadinessCounts) {
  const total =
    row.deliverable_count + row.work_item_count + row.responsibility_count + row.approval_blockers;
  const blockers =
    row.deliverable_blockers +
    row.work_item_blockers +
    row.responsibility_blockers +
    row.approval_blockers;
  return {
    total,
    blockers,
    progress: total === 0 ? 0 : Math.round(((total - blockers) / total) * 100),
    readiness: blockers ? ('blocked' as const) : ('ready' as const),
  };
}
