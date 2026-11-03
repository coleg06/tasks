import type { Context } from 'hono';
import type { TaskAppEnv } from '../app-env';

type AppContext = Context<TaskAppEnv>;

export type D1AuditEntityType = 'task' | 'comment' | 'project' | 'membership' | 'user' | 'system';

/** Builds the existing D1 audit insert for inclusion in the caller's atomic batch. */
export function auditStatement(
  context: AppContext,
  actorUserId: number,
  entityType: D1AuditEntityType,
  entityKey: string,
  action: string,
  changes: Record<string, unknown>,
  requestIdOverride?: string,
  onlyAfterChange = false,
) {
  const requestId =
    requestIdOverride ??
    context.get('requestId') ??
    context.req.header('cf-ray') ??
    context.req.header('x-request-id') ??
    crypto.randomUUID();
  return context.env.DB.prepare(
    `INSERT INTO audit_events (
      actor_user_id, entity_type, entity_key, action, changes_json, request_id
     ) SELECT ?, ?, ?, ?, ?, ? WHERE ? = 0 OR changes() = 1`,
  ).bind(
    actorUserId,
    entityType,
    entityKey,
    action,
    JSON.stringify(changes),
    requestId,
    onlyAfterChange ? 1 : 0,
  );
}
