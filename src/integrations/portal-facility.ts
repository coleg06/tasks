import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { z } from 'zod';
import { tenantProfile } from '../../shared/tenant-profile';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import type { TaskAppEnv } from '../app-env';
import { constantTimeEqual } from '../auth/google';
import { SESSION_COOKIE, verifySession } from '../auth/session';
import type { Env } from '../env';
import { requireTasksSession } from '../identity/context';
import { D1_PROJECT_ACCESS } from '../persistence/d1-task-backend';
import { publicOrigin } from '../runtime/identity-config';
import { sortKey } from '../tasks/service';

type AppContext = Context<TaskAppEnv>;
const sourceSystem = 'portal-facility-request';
export const PORTAL_FACILITY_MAX_BYTES = 128 * 1024;
export const portalFacilityUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const facilityRequestTypes = [
  'Repair or something is broken',
  'Room or event setup',
  'Cleaning',
  'Supplies or equipment',
  'Safety or security concern',
  'Grounds or parking lot',
  'Something else',
] as const;
export const facilityUrgencies = [
  'Urgent: safety issue or happening right now',
  'This week',
  'Within 2 to 4 weeks',
  'Planning ahead',
] as const;
const answer = z.string().max(20_000);
const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  });
export const portalFacilityRequestSchema = z
  .strictObject({
    version: z.literal(1),
    environment: z.enum(['production', 'dev']),
    submission_id: z.string().regex(portalFacilityUuid),
    submitted_at: z.iso.datetime(),
    requester: z.strictObject({
      name: z
        .string()
        .min(1)
        .max(320)
        .refine((s) => s.trim().length > 0),
      email: z.string().max(320).email(),
    }),
    locale: z.enum(['en', 'es']),
    campus: z
      .string()
      .max(120)
      .refine((value) => value === '' || Object.hasOwn(settings()?.campusLabels ?? {}, value)),
    request_type: z.enum(facilityRequestTypes),
    urgency: z.enum(facilityUrgencies),
    location: z
      .string()
      .max(160)
      .refine((s) => s.trim().length > 0),
    description: answer.refine((s) => s.trim().length > 0),
    needed_by: z
      .union([z.literal(''), calendarDate])
      .optional()
      .default(''),
    event_name: z.string().max(320),
    reference_files: z
      .array(
        z.strictObject({
          name: z
            .string()
            .min(1)
            .max(255)
            .refine((s) => !/[\p{Cc}/\\]/u.test(s)),
          type: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
          size: z
            .number()
            .int()
            .nonnegative()
            .max(3 * 1024 * 1024),
        }),
      )
      .max(3),
  })
  .refine((p) => p.reference_files.reduce((size, file) => size + file.size, 0) <= 3 * 1024 * 1024);
export type PortalFacilityRequest = z.infer<typeof portalFacilityRequestSchema>;

function settings() {
  // Explicit opt-in: an old tenant profile cannot silently enable a new intake queue.
  return tenantExtensions().integrations?.portalFacility;
}
function routing(env: Env) {
  return {
    projectKey: (env.PORTAL_FACILITY_PROJECT_KEY ?? settings()?.projectKey ?? '').trim(),
    assigneeEmail: (env.PORTAL_FACILITY_ASSIGNEE_EMAIL ?? settings()?.assigneeEmail ?? '').trim(),
  };
}
function authorize(context: AppContext) {
  const config = settings();
  const secret = context.env.PORTAL_DESIGN_INGEST_SECRET ?? '';
  if (!config || secret.length < 32)
    return context.json({ error: 'integration_not_configured' }, 503);
  const header = context.req.header('Authorization') ?? '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!constantTimeEqual(candidate, secret)) return context.json({ error: 'unauthorized' }, 401);
  const destination = routing(context.env);
  if (!destination.projectKey || !z.email().safeParse(destination.assigneeEmail).success)
    return context.json(
      {
        error: 'facility_routing_not_configured',
        message:
          'Configure PORTAL_FACILITY_PROJECT_KEY and PORTAL_FACILITY_ASSIGNEE_EMAIL or the corresponding portalFacility profile fields.',
      },
      503,
    );
  return null;
}
function expectedEnvironment(env: Env) {
  const environment = settings()?.environment;
  return environment === 'deployment' ? env.ENVIRONMENT : environment;
}

type Dependencies = {
  project_id: number;
  workspace_id: number;
  actor_user_id: number;
  assignee_user_id: number;
};
async function dependencies(env: Env) {
  const config = settings();
  if (
    !config ||
    !['dev', 'production'].includes(String(expectedEnvironment(env))) ||
    expectedEnvironment(env) !== env.ENVIRONMENT
  )
    return null;
  return env.DB.prepare(`SELECT p.id AS project_id, p.workspace_id,
    actor.id AS actor_user_id, assignee.id AS assignee_user_id
    FROM projects p JOIN workspaces w ON w.id = p.workspace_id
    JOIN users actor ON actor.email = ? COLLATE NOCASE AND actor.status = 'active' AND actor.principal_type = 'agent'
    JOIN users assignee ON assignee.email = ? COLLATE NOCASE AND assignee.status = 'active'
    JOIN workspace_members aw ON aw.workspace_id = w.id AND aw.user_id = actor.id
    JOIN workspace_members sw ON sw.workspace_id = w.id AND sw.user_id = assignee.id
    JOIN project_members ap ON ap.project_id = p.id AND ap.user_id = actor.id
    JOIN project_members sp ON sp.project_id = p.id AND sp.user_id = assignee.id
    WHERE p.project_key = ? AND w.workspace_key = ? AND w.archived_at IS NULL
      AND p.archived_at IS NULL AND p.visibility = 'private' AND p.project_type = 'shared'
      AND sp.role IN ('owner', 'editor') AND ap.role IN ('owner', 'editor')
      AND EXISTS (SELECT 1 FROM effective_user_permissions up WHERE up.user_id = assignee.id AND up.permission_key = 'tasks.view')
      AND EXISTS (SELECT 1 FROM effective_user_permissions up WHERE up.user_id = actor.id AND up.permission_key = 'tasks.view')`)
    .bind(
      config.actorEmail,
      routing(env).assigneeEmail,
      routing(env).projectKey,
      tenantProfile.workspaceKey,
    )
    .first<Dependencies>();
}

const campusLabel = (campus: string) => settings()?.campusLabels?.[campus] ?? 'Not specified';
export function formatPortalFacilityRequest(request: PortalFacilityRequest) {
  const p = request;
  const oneLine = (text: string) => text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ');
  const title = `Facility request: ${p.request_type} - ${oneLine(p.location)}`.slice(0, 240);
  const suffix = [
    `Needed by: ${p.needed_by || 'Not specified'}`,
    `Related event: ${p.event_name || 'None'}`,
    `Submitted at: ${p.submitted_at}`,
    `Request language: ${p.locale === 'es' ? 'Spanish (es)' : 'English (en)'}`,
    `Reference files: ${p.reference_files.map((file) => `${file.name} (${file.type}, ${file.size} bytes)`).join(', ') || 'None'}`,
    'Files are attached to the facility request email; Forms deletes them 90 days after submission.',
  ];
  const prefix = [
    `Requester: ${p.requester.name} <${p.requester.email}>`,
    `Campus: ${campusLabel(p.campus)}`,
    `Request type: ${p.request_type}`,
    `Urgency: ${p.urgency}`,
    `Location: ${p.location}`,
  ];
  const sections: [string, string][] = [['Description', p.description]];
  const format = (preview: boolean) =>
    [
      ...prefix,
      ...sections.map(
        ([label, text]) =>
          `${label}:\n${preview && text.length > 2000 ? `${text.slice(0, 2000)}\n[Preview; full text in Imported details.]` : text}`,
      ),
      ...suffix,
    ].join('\n\n');
  const fullText = format(false);
  return {
    title,
    description: fullText.length <= 10_000 ? fullText : format(true),
    sourceContent: fullText.length <= 10_000 ? {} : { plainText: fullText },
  };
}

// Schema construction fixes object key order. No trimming, translation or text normalization:
// a changed answer under the same UUID is always a conflict, even after a human edits the task.
async function payloadHash(payload: PortalFacilityRequest) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
type Receipt = { task_key: string; seq: number; source_id: string; payload_hash: string | null };
function receipt(context: AppContext, id: string) {
  return context.env.DB.prepare(`SELECT task_key, seq, source_id,
    json_extract(source_metadata_json, '$.portalFacilityRequest.payloadHash') AS payload_hash
    FROM tasks WHERE source_system = ? AND source_id = ?`)
    .bind(sourceSystem, id)
    .first<Receipt>();
}
function result(context: AppContext, row: Receipt, hash: string, created: boolean) {
  if (row.payload_hash !== hash) return context.json({ error: 'submission_payload_conflict' }, 409);
  return context.json(
    {
      ok: true,
      created,
      task: {
        key: row.task_key,
        reference: `T-${row.seq}`,
        url: `${publicOrigin(context.env, context.req.url)}/r/portal-facility-request/${row.source_id}`,
      },
    },
    created ? 201 : 200,
  );
}
export async function portalFacilityHealth(context: AppContext) {
  const denied = authorize(context);
  if (denied) return denied;
  try {
    if (await dependencies(context.env)) return context.json({ ok: true });
  } catch {
    /* Not ready while a deployment or database is unavailable. */
  }
  return context.json(
    {
      error: 'integration_dependency_unavailable',
      message:
        'The configured private shared facility project, active agent and assignee require workspace membership, project editor/owner membership and tasks.view in this deployment lane.',
    },
    503,
  );
}
export async function ingestPortalFacilityRequest(context: AppContext) {
  const denied = authorize(context);
  if (denied) return denied;
  if (
    context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    return context.json({ error: 'invalid_content_type' }, 400);
  let body: unknown;
  try {
    // Count bytes even when Content-Length is absent or inaccurate. Never buffer an
    // unbounded stream; the outer middleware alone may trust a supplied length.
    const reader = context.req.raw.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > PORTAL_FACILITY_MAX_BYTES) {
          await reader.cancel();
          return context.json({ error: 'payload_too_large' }, 400);
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return context.json({ error: 'invalid_json' }, 400);
  }
  const parsed = portalFacilityRequestSchema.safeParse(body);
  if (
    !parsed.success ||
    parsed.data.environment !== expectedEnvironment(context.env) ||
    parsed.data.environment !== context.env.ENVIRONMENT
  )
    return context.json({ error: 'invalid_facility_request' }, 400);
  const payload = parsed.data;
  const hash = await payloadHash(payload);
  try {
    const existing = await receipt(context, payload.submission_id);
    if (existing) return result(context, existing, hash, false);
    const config = await dependencies(context.env);
    if (!config)
      return context.json(
        {
          error: 'integration_dependency_unavailable',
          message:
            'The configured private shared facility project, active agent and assignee require workspace membership, project editor/owner membership and tasks.view in this deployment lane.',
        },
        503,
      );
    const key = `FACILITY-${payload.submission_id}`;
    const formatted = formatPortalFacilityRequest(payload);
    const changes = JSON.stringify({
      source: sourceSystem,
      submissionId: payload.submission_id,
      projectKey: routing(context.env).projectKey,
      assigneeEmail: routing(context.env).assigneeEmail,
    });
    const timestamp = new Date().toISOString();
    const priority = payload.urgency.startsWith('Urgent') ? 'high' : 'medium';
    const dueDate = payload.needed_by || null;
    try {
      await context.env.DB.batch([
        context.env.DB.prepare(`INSERT INTO tasks (
          task_key, seq, title, description, status, priority, assignee_user_id, created_by_user_id,
          due_date, sort_key, source_system, source_id, source_created_at, source_updated_at,
          source_metadata_json, source_content_json, workspace_id, project_id, created_at, updated_at
        ) VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), ?, ?, 'not_started', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
          key,
          formatted.title,
          formatted.description,
          priority,
          config.assignee_user_id,
          config.actor_user_id,
          dueDate,
          sortKey('not_started', priority, dueDate, key),
          sourceSystem,
          payload.submission_id,
          payload.submitted_at,
          payload.submitted_at,
          JSON.stringify({ portalFacilityRequest: { ...payload, payloadHash: hash } }),
          JSON.stringify(formatted.sourceContent),
          config.workspace_id,
          config.project_id,
          timestamp,
          timestamp,
        ),
        context.env.DB.prepare(`INSERT INTO task_events (task_id, actor_user_id, action, changes_json)
          SELECT id, ?, 'created', ? FROM tasks WHERE task_key = ?`).bind(
          config.actor_user_id,
          changes,
          key,
        ),
        context.env.DB.prepare(`INSERT INTO audit_events (actor_user_id, entity_type, entity_key, action, changes_json, request_id)
          VALUES (?, 'task', ?, 'task.created', ?, ?)`).bind(
          config.actor_user_id,
          key,
          changes,
          context.get('requestId') ?? crypto.randomUUID(),
        ),
      ]);
    } catch {
      // A competing source insert rolls the entire batch back. Never reinterpret an unrelated
      // failure as success; only this exact immutable source receipt can satisfy a replay.
      const competing = await receipt(context, payload.submission_id);
      if (competing) return result(context, competing, hash, false);
      return context.json({ error: 'task_creation_failed' }, 503);
    }
    const created = await receipt(context, payload.submission_id);
    if (created) return result(context, created, hash, true);
  } catch {
    /* Return retryable failure without logging request text or credentials. */
  }
  return context.json({ error: 'task_creation_failed' }, 503);
}

export async function redirectPortalFacilityRequest(context: AppContext) {
  context.header('Cache-Control', 'no-store');
  const notFound = () =>
    context.html(
      '<!doctype html><html lang="en"><title>Not found</title><body><p>Not found.</p></body></html>',
      404,
    );
  if (!settings()) return notFound();
  const id = context.req.param('submissionId') ?? '';
  if (!portalFacilityUuid.test(id)) return notFound();
  const identity = await requireTasksSession(context);
  if (!identity) {
    // A valid but unauthorized session is a denial; an absent/expired one enters the normal
    // sign-in flow, which preserves this path in its signed OAuth returnTo state.
    try {
      await verifySession(context.env, getCookie(context, SESSION_COOKIE) ?? '');
      return notFound();
    } catch {
      return context.redirect(`/auth/login?returnTo=${encodeURIComponent(context.req.path)}`, 302);
    }
  }
  const task = await context.env.DB.prepare(
    `SELECT task_key FROM tasks WHERE source_system = ? AND source_id = ?`,
  )
    .bind(sourceSystem, id)
    .first<{ task_key: string }>();
  if (task) {
    const accessible =
      await context.env.DB.prepare(`SELECT t.task_key FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.task_key = ? AND t.archived_at IS NULL AND p.archived_at IS NULL AND ${D1_PROJECT_ACCESS}`)
        .bind(task.task_key, identity.user.id)
        .first<{ task_key: string }>();
    if (!accessible) return notFound();
    return context.redirect(`/tasks/${encodeURIComponent(accessible.task_key)}`, 302);
  }
  const project = await context.env.DB.prepare(`SELECT p.id FROM projects p
    WHERE p.project_key = ? AND p.archived_at IS NULL AND ${D1_PROJECT_ACCESS}`)
    .bind(routing(context.env).projectKey, identity.user.id)
    .first<{ id: number }>();
  if (!project) return notFound();
  return context.html(
    '<!doctype html><html lang="en"><title>Facility request</title><body><p>This facility request is still being added to Tasks. Refresh in a minute.</p></body></html>',
  );
}
