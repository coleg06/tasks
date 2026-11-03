import type { Context } from 'hono';
import { requireTasksSession, type TaskAppEnv } from '../tasks/api';

type AppContext = Context<TaskAppEnv>;

type DurationRow = { created_at: string; completed_at: string | null };

function hoursBetween(start: string, end: string | null) {
  if (!end) return null;
  const milliseconds = Date.parse(end) - Date.parse(start);
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? milliseconds / 3_600_000 : null;
}

function summarize(rows: DurationRow[]) {
  const values = rows
    .map((row) => hoursBetween(row.created_at, row.completed_at))
    .filter((value): value is number => value !== null);
  if (!values.length) return { averageHours: null, medianHours: null, sampleSize: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  return {
    averageHours:
      Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10,
    medianHours: Math.round(median * 10) / 10,
    sampleSize: values.length,
  };
}

export async function getWorkflowAnalytics(context: AppContext) {
  const identity =
    (await requireTasksSession(context, 'events.view')) ??
    (await requireTasksSession(context, 'tasks.view'));
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  if (
    !identity.session.perms.includes('events.manage') &&
    !identity.session.perms.includes('tasks.manage')
  ) {
    return context.json({ error: 'forbidden' }, 403);
  }
  const requestedDays = Number(context.req.query('days') ?? 90);
  const days = [30, 90, 180, 365].includes(requestedDays) ? requestedDays : 90;
  const since = new Date(Date.now() - days * 86_400_000).toISOString().replace('.000Z', 'Z');

  const [tracking, tasks, events, workItems, deliverables, revisions, stages, recentEvents] =
    await Promise.all([
      context.env.DB.prepare(
        'SELECT started_at FROM workflow_tracking_started WHERE id = 1',
      ).first<{
        started_at: string;
      }>(),
      context.env.DB.prepare(
        `SELECT t.created_at, t.completed_at FROM tasks t
         JOIN projects p ON p.id = t.project_id
         WHERE t.completed_at IS NOT NULL AND t.completed_at >= ? AND t.archived_at IS NULL
           AND p.project_type = 'shared'`,
      )
        .bind(since)
        .all<DurationRow>(),
      context.env.DB.prepare(
        `SELECT e.created_at,
          MIN(CASE WHEN a.action = 'event.stage_changed'
            AND json_extract(a.changes_json, '$.to') IN ('event_ready','post_event','archived')
            THEN a.created_at END) AS completed_at
         FROM events e LEFT JOIN event_activity a ON a.event_id = e.id
         WHERE e.created_at >= ? GROUP BY e.id`,
      )
        .bind(since)
        .all<DurationRow>(),
      context.env.DB.prepare(
        `SELECT wi.phase, wi.created_at,
          MIN(CASE WHEN a.action = 'work_item.status_changed'
            AND a.entity_key = wi.work_item_key
            AND json_extract(a.changes_json, '$.status.to') IN ('done','not_needed')
            THEN a.created_at END) AS completed_at
         FROM event_work_items wi
         JOIN events e ON e.id = wi.event_id
         LEFT JOIN event_activity a ON a.event_id = wi.event_id
         WHERE wi.created_at >= ? GROUP BY wi.id`,
      )
        .bind(since)
        .all<DurationRow & { phase: string }>(),
      context.env.DB.prepare(
        `SELECT d.created_at,
          COALESCE(
            (SELECT MIN(a.created_at) FROM event_approvals a
             WHERE a.event_id = d.event_id AND a.subject_type = 'deliverable'
               AND a.subject_id = d.id AND a.decision = 'approved'),
            (SELECT MIN(a.created_at) FROM event_approvals a
             JOIN event_asset_versions av ON av.id = a.subject_id
             WHERE a.event_id = d.event_id AND a.subject_type = 'asset'
               AND av.deliverable_id = d.id AND a.decision = 'approved')
          ) AS completed_at
         FROM event_deliverables d WHERE d.created_at >= ?`,
      )
        .bind(since)
        .all<DurationRow>(),
      context.env.DB.prepare(
        `SELECT COUNT(*) AS deliverables,
          COALESCE(SUM(CASE WHEN versions > 1 THEN 1 ELSE 0 END), 0) AS revised,
          COALESCE(AVG(versions), 0) AS average_versions
         FROM (
           SELECT d.id, COUNT(av.id) AS versions
           FROM event_deliverables d
           JOIN events e ON e.id = d.event_id
           LEFT JOIN event_asset_versions av ON av.deliverable_id = d.id
           WHERE e.created_at >= ? GROUP BY d.id HAVING versions > 0
         )`,
      )
        .bind(since)
        .first<{ deliverables: number; revised: number; average_versions: number }>(),
      context.env.DB.prepare(
        `SELECT stage, COUNT(*) AS count FROM events
         WHERE archived_at IS NULL GROUP BY stage ORDER BY count DESC`,
      ).all<{ stage: string; count: number }>(),
      context.env.DB.prepare(
        `SELECT e.event_key, e.seq, e.title, e.created_at,
          MIN(CASE WHEN a.action = 'event.stage_changed'
            AND json_extract(a.changes_json, '$.to') IN ('event_ready','post_event','archived')
            THEN a.created_at END) AS completed_at
         FROM events e LEFT JOIN event_activity a ON a.event_id = e.id
         WHERE e.created_at >= ? GROUP BY e.id HAVING completed_at IS NOT NULL
         ORDER BY completed_at DESC LIMIT 8`,
      )
        .bind(since)
        .all<DurationRow & { event_key: string; seq: number; title: string }>(),
    ]);

  const phaseRows = new Map<string, DurationRow[]>();
  for (const row of workItems.results) {
    phaseRows.set(row.phase, [...(phaseRows.get(row.phase) ?? []), row]);
  }
  const revisionDeliverables = Number(revisions?.deliverables ?? 0);
  return context.json({
    periodDays: days,
    trackingStartedAt: tracking?.started_at ?? null,
    metrics: {
      eventLeadTime: summarize(events.results),
      eventTaskLeadTime: summarize(workItems.results),
      standardTaskLeadTime: summarize(tasks.results),
      deliverableApprovalTime: summarize(deliverables.results),
      averageAssetVersions: Math.round(Number(revisions?.average_versions ?? 0) * 10) / 10,
      revisionRate:
        revisionDeliverables > 0
          ? Math.round((Number(revisions?.revised ?? 0) / revisionDeliverables) * 100)
          : 0,
    },
    phases: [...phaseRows.entries()]
      .map(([phase, rows]) => ({ phase, ...summarize(rows) }))
      .sort((left, right) => (right.averageHours ?? -1) - (left.averageHours ?? -1)),
    stages: stages.results,
    recentEvents: recentEvents.results.map((row) => ({
      key: row.event_key,
      reference: `E-${row.seq}`,
      title: row.title,
      completedAt: row.completed_at,
      elapsedHours: hoursBetween(row.created_at, row.completed_at),
    })),
  });
}
