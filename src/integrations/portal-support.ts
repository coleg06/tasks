import type { Context } from 'hono';
import { z } from 'zod';
import { tenantProfile } from '../../shared/tenant-profile';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import { constantTimeEqual } from '../auth/google';
import type { Env } from '../env';
import { logApplicationError } from '../logging';
import type { TaskAppEnv } from '../tasks/api';

type AppContext = Context<TaskAppEnv>;

export const portalSupportTicketSchema = z.object({
  ticket_id: z.number().int().positive(),
  subject: z.string().trim().min(1).max(240),
  description: z.string().trim().max(10_000),
  priority: z.string().trim().max(40).default('Normal'),
  area: z.string().trim().max(120).default('Tech Help'),
  owner: z.string().trim().max(120).default(''),
  owner_email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(320)
    .refine((value) => {
      const owners = tenantExtensions().integrations?.portalSupport?.ownerEmails ?? [];
      return owners.length === 0 || owners.some((owner) => owner.toLowerCase() === value);
    })
    .nullable()
    .default(null),
  requester_name: z.string().trim().max(120).default(''),
  requester_email: z.string().trim().email().max(320),
  location: z.string().trim().max(160).default(''),
  impact: z.string().trim().max(160).default(''),
  ticket_url: z
    .string()
    .url()
    .max(1_000)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        (tenantExtensions().integrations?.portalSupport?.ticketHosts ?? []).includes(url.hostname)
      );
    }),
});

type PortalSupportTicket = z.infer<typeof portalSupportTicketSchema>;

type IntegrationDependencies = {
  project_id: number;
  workspace_id: number;
  actor_user_id: number | null;
};

function authorizePortal(context: AppContext) {
  if (!tenantExtensions().integrations?.portalSupport) {
    return context.json({ error: 'integration_not_configured' }, 503);
  }
  const secret = context.env.PORTAL_SUPPORT_INGEST_SECRET?.trim() ?? '';
  if (secret.length < 32) {
    return context.json({ error: 'integration_not_configured' }, 503);
  }
  const authorization = context.req.header('Authorization') ?? '';
  const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (candidate.length !== secret.length || !constantTimeEqual(candidate, secret)) {
    return context.json({ error: 'unauthorized' }, 401);
  }
  return null;
}

async function integrationDependencies(env: Env) {
  const actorEmail = tenantExtensions().integrations?.portalSupport?.actorEmail ?? '';
  return env.DB.prepare(
    `SELECT p.id AS project_id, p.workspace_id,
       (SELECT u.id FROM users u
          WHERE u.status = 'active'
          ORDER BY CASE WHEN u.email = ? COLLATE NOCASE THEN 0 ELSE 1 END, u.id
          LIMIT 1) AS actor_user_id
     FROM projects p
     WHERE p.project_key = ? AND p.archived_at IS NULL`,
  )
    .bind(actorEmail, tenantProfile.defaultProjectKey)
    .first<IntegrationDependencies>();
}

function taskPriority(priority: string): 'high' | 'medium' | 'low' {
  const normalized = priority.toLowerCase();
  if (normalized === 'urgent' || normalized === 'high') return 'high';
  if (normalized === 'low') return 'low';
  return 'medium';
}

function taskMetadata(ticket: PortalSupportTicket) {
  return {
    taskTypes: ['Tech support'],
    portalTicket: {
      id: ticket.ticket_id,
      area: ticket.area,
      owner: ticket.owner,
      requester: { name: ticket.requester_name, email: ticket.requester_email },
      location: ticket.location,
      impact: ticket.impact,
    },
  };
}

function taskUrl(context: AppContext, taskKey: string) {
  const origin = new URL(context.req.url).origin;
  return `${origin}/tasks/${encodeURIComponent(taskKey)}`;
}

export async function portalSupportHealth(context: AppContext) {
  const unauthorized = authorizePortal(context);
  if (unauthorized) return unauthorized;
  const dependencies = await integrationDependencies(context.env);
  if (!dependencies?.actor_user_id) {
    return context.json({ error: 'integration_dependency_unavailable' }, 503);
  }
  return context.json({ ok: true, project: tenantProfile.defaultProjectKey });
}

export async function ingestPortalSupportTicket(context: AppContext) {
  const unauthorized = authorizePortal(context);
  if (unauthorized) return unauthorized;

  const contentLength = Number(context.req.header('Content-Length') ?? '0');
  if (Number.isFinite(contentLength) && contentLength > 20_000) {
    return context.json({ error: 'payload_too_large' }, 413);
  }
  let body: unknown;
  try {
    const rawBody = await context.req.text();
    if (new TextEncoder().encode(rawBody).byteLength > 20_000) {
      return context.json({ error: 'payload_too_large' }, 413);
    }
    body = JSON.parse(rawBody);
  } catch {
    return context.json({ error: 'invalid_json' }, 400);
  }
  const parsed = portalSupportTicketSchema.safeParse(body);
  if (!parsed.success) {
    return context.json({ error: 'invalid_ticket', issues: parsed.error.issues }, 400);
  }
  const ticket = parsed.data;
  const sourceSystem = 'portal-support-ticket';
  const sourceId = String(ticket.ticket_id);
  const existing = await context.env.DB.prepare(
    'SELECT task_key FROM tasks WHERE source_system = ? AND source_id = ? LIMIT 1',
  )
    .bind(sourceSystem, sourceId)
    .first<{ task_key: string }>();
  if (existing) {
    return context.json({
      ok: true,
      created: false,
      task: { key: existing.task_key, url: taskUrl(context, existing.task_key) },
    });
  }

  const dependencies = await integrationDependencies(context.env);
  if (!dependencies?.actor_user_id) {
    return context.json({ error: 'integration_dependency_unavailable' }, 503);
  }
  const assignee = ticket.owner_email
    ? await context.env.DB.prepare(
        `SELECT u.id FROM users u
         JOIN workspace_members wm ON wm.user_id = u.id
         WHERE wm.workspace_id = ? AND u.email = ? COLLATE NOCASE AND u.status = 'active'
         LIMIT 1`,
      )
        .bind(dependencies.workspace_id, ticket.owner_email)
        .first<{ id: number }>()
    : null;
  const taskKey = `SUPPORT-${ticket.ticket_id}`;
  const priority = taskPriority(ticket.priority);
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const changes = {
    source: sourceSystem,
    portalTicketId: ticket.ticket_id,
    projectKey: tenantProfile.defaultProjectKey,
    assigneeEmail: assignee ? ticket.owner_email : null,
  };

  try {
    const inserted = await context.env.DB.prepare(
      `INSERT OR IGNORE INTO tasks (
        task_key, seq, title, description, status, priority, effort, assignee_user_id,
        created_by_user_id, due_date, sort_key, completed_at, source_system, source_id,
        source_url, source_created_at, source_updated_at, source_metadata_json,
        workspace_id, project_id, created_at, updated_at
       ) VALUES (
        ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), ?, ?, 'not_started', ?, NULL, ?,
        ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       )`,
    )
      .bind(
        taskKey,
        ticket.subject,
        ticket.description,
        priority,
        assignee?.id ?? null,
        dependencies.actor_user_id,
        `02:${priority}:9999-12-31:${taskKey}`,
        sourceSystem,
        sourceId,
        ticket.ticket_url,
        timestamp,
        timestamp,
        JSON.stringify(taskMetadata(ticket)),
        dependencies.workspace_id,
        dependencies.project_id,
        timestamp,
        timestamp,
      )
      .run();

    // D1's meta.changes includes FTS trigger writes on tasks: any positive count is a new row,
    // zero means INSERT OR IGNORE hit the existing source ticket.
    const created = inserted.meta.changes > 0;
    if (created) {
      await context.env.DB.batch([
        context.env.DB.prepare(
          `INSERT INTO task_events (task_id, actor_user_id, action, changes_json)
           SELECT id, ?, 'created', ? FROM tasks WHERE task_key = ?`,
        ).bind(dependencies.actor_user_id, JSON.stringify(changes), taskKey),
        context.env.DB.prepare(
          `INSERT INTO audit_events (
             actor_user_id, entity_type, entity_key, action, changes_json, request_id
           ) VALUES (?, 'task', ?, 'task.created', ?, ?)`,
        ).bind(
          dependencies.actor_user_id,
          taskKey,
          JSON.stringify(changes),
          context.get('requestId') ?? crypto.randomUUID(),
        ),
      ]);
    }
    const createdTask = await context.env.DB.prepare(
      'SELECT task_key FROM tasks WHERE source_system = ? AND source_id = ? LIMIT 1',
    )
      .bind(sourceSystem, sourceId)
      .first<{ task_key: string }>();
    if (!createdTask) return context.json({ error: 'task_creation_failed' }, 503);
    return context.json(
      {
        ok: true,
        created,
        task: { key: createdTask.task_key, url: taskUrl(context, createdTask.task_key) },
      },
      created ? 201 : 200,
    );
  } catch (error) {
    await logApplicationError(
      'portal_support.ingest_failed',
      error,
      context.env,
      context.get('requestId'),
      { ticketId: ticket.ticket_id },
    );
    return context.json({ error: 'task_creation_failed' }, 503);
  }
}
