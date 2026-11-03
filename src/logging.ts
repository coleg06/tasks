import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from './env';

type LoggingAppEnv = {
  Bindings: Env;
  Variables: { requestId?: string };
};

export type OperationalEvent = {
  severity?: 'warning' | 'error';
  event: string;
  source: string;
  actorUserId?: number | null;
  requestId?: string | null;
  method?: string | null;
  path?: string | null;
  statusCode?: number | null;
  message: string;
  details?: Record<string, unknown>;
};

const limit = (value: string, length: number) =>
  value.replaceAll(/\s+/g, ' ').trim().slice(0, length);

function safeDetails(details: Record<string, unknown> | undefined) {
  if (!details) return '{}';
  const allowed: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(details)) {
    const key = limit(rawKey, 80);
    if (/token|secret|password|authorization|cookie|request.?body|content/i.test(key)) continue;
    if (rawValue !== null && !['string', 'number', 'boolean'].includes(typeof rawValue)) continue;
    const value = typeof rawValue === 'string' ? limit(rawValue, 500) : rawValue;
    if (JSON.stringify({ ...allowed, [key]: value }).length > 4_000) break;
    allowed[key] = value;
  }
  return JSON.stringify(allowed);
}

export function requestIdFor(context: Context<LoggingAppEnv>) {
  return (
    context.get('requestId') ??
    context.req.header('cf-ray') ??
    context.req.header('x-request-id') ??
    crypto.randomUUID()
  );
}

export async function recordOperationalEvent(env: Env, input: OperationalEvent) {
  try {
    await env.DB.prepare(
      `INSERT INTO operational_events (
        severity, event, source, actor_user_id, request_id, method, path,
        status_code, message, details_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        input.severity ?? 'error',
        limit(input.event, 120),
        limit(input.source, 60),
        input.actorUserId ?? null,
        input.requestId ? limit(input.requestId, 120) : null,
        input.method ? limit(input.method.toUpperCase(), 12) : null,
        input.path ? limit(input.path, 500) : null,
        input.statusCode ?? null,
        limit(input.message, 500),
        safeDetails(input.details),
      )
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        type: 'operational_log_write_failed',
        environment: env.ENVIRONMENT,
        event: input.event,
        error: error instanceof Error ? error.name : 'unknown_error',
      }),
    );
  }
}

export async function pruneOperationalEvents(env: Env) {
  return env.DB.prepare(
    `DELETE FROM operational_events
     WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-90 days')`,
  ).run();
}

export const requestLogger: MiddlewareHandler<LoggingAppEnv> = async (context, next) => {
  const startedAt = Date.now();
  const requestId =
    context.req.header('cf-ray') ?? context.req.header('x-request-id') ?? crypto.randomUUID();
  context.set('requestId', requestId);
  context.header('x-request-id', requestId);
  try {
    await next();
  } finally {
    console.log(
      JSON.stringify({
        type: 'http_request',
        requestId,
        environment: context.env.ENVIRONMENT,
        method: context.req.method,
        path: new URL(context.req.url).pathname,
        status: context.res.status,
        durationMs: Date.now() - startedAt,
      }),
    );
  }
};

export async function logUnhandledError(
  error: Error,
  request: Request,
  env: Env,
  requestIdOverride?: string,
) {
  const requestId =
    requestIdOverride ?? request.headers.get('cf-ray') ?? request.headers.get('x-request-id');
  const path = new URL(request.url).pathname;
  console.error(
    JSON.stringify({
      type: 'unhandled_error',
      requestId,
      environment: env.ENVIRONMENT,
      method: request.method,
      path,
      error: { name: error.name, message: error.message, stack: error.stack },
    }),
  );
  await recordOperationalEvent(env, {
    event: 'http.unhandled_error',
    source: 'worker',
    requestId,
    method: request.method,
    path,
    statusCode: 500,
    message: error.message || error.name,
    details: { errorName: error.name },
  });
}

export async function logApplicationError(
  event: string,
  error: unknown,
  env: Env,
  requestId?: string | null,
  details?: Record<string, unknown>,
) {
  const normalized = error instanceof Error ? error : new Error(String(error));
  console.error(
    JSON.stringify({
      type: 'application_error',
      event,
      requestId,
      environment: env.ENVIRONMENT,
      error: { name: normalized.name, message: normalized.message, stack: normalized.stack },
    }),
  );
  await recordOperationalEvent(env, {
    event,
    source: event.split('.')[0] || 'application',
    ...(requestId !== undefined ? { requestId } : {}),
    message: normalized.message || normalized.name,
    details: { errorName: normalized.name, ...details },
  });
}
