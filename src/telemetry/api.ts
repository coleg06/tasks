import type { Context } from 'hono';
import { z } from 'zod';
import { recordOperationalEvent } from '../logging';
import { requireTasksSession, type TaskAppEnv } from '../tasks/api';

type AppContext = Context<TaskAppEnv>;

const clientErrorSchema = z.object({
  event: z.enum(['ui.render_error', 'ui.unhandled_error', 'ui.unhandled_rejection']),
  message: z.string().trim().min(1).max(500),
  route: z.string().trim().startsWith('/').max(500),
  componentStack: z.string().trim().max(2_000).optional(),
});

export async function recordClientError(context: AppContext) {
  const identity = await requireTasksSession(context);
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const input = clientErrorSchema.safeParse(await context.req.json().catch(() => null));
  if (!input.success) return context.json({ error: 'invalid_client_error' }, 400);
  await recordOperationalEvent(context.env, {
    event: input.data.event,
    source: 'browser',
    actorUserId: identity.auditUserId,
    ...(context.get('requestId') ? { requestId: context.get('requestId') } : {}),
    method: 'CLIENT',
    path: input.data.route,
    message: input.data.message,
    ...(input.data.componentStack
      ? { details: { componentStack: input.data.componentStack } }
      : {}),
  });
  return context.body(null, 204);
}
