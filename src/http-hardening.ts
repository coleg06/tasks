import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

/** Largest JSON (or other non-upload) request body any `/api` route accepts. */
export const API_BODY_LIMIT_BYTES = 1024 * 1024;

/** Slack above the asset size limit for multipart framing and the other form fields. */
const UPLOAD_ENVELOPE_BYTES = 1024 * 1024;

const UPLOAD_PATH = /^\/api\/events\/[^/]+\/deliverables\/[^/]+\/assets\/upload$/;

/**
 * Bounds the bytes read for a request before any handler parses it. Handlers validate sizes only
 * after the whole body is buffered, so without this an authenticated caller could make the process
 * hold an arbitrarily large body in memory. The upload route gets the asset limit plus envelope.
 */
export function apiBodyLimit(maximumUploadBytes: number): MiddlewareHandler {
  const json = bodyLimit({
    maxSize: API_BODY_LIMIT_BYTES,
    onError: (context) => context.json({ error: 'payload_too_large' }, 413),
  });
  const upload = bodyLimit({
    maxSize: maximumUploadBytes + UPLOAD_ENVELOPE_BYTES,
    onError: (context) => context.json({ error: 'payload_too_large' }, 413),
  });
  return (context, next) => (UPLOAD_PATH.test(context.req.path) ? upload : json)(context, next);
}

/**
 * Response headers that need no per-deployment decisions: no MIME sniffing, no framing of the
 * application, and no referrer leakage to other origins. A full Content-Security-Policy and
 * Strict-Transport-Security depend on the deployment and are left to the reverse proxy.
 */
export const securityHeaders: MiddlewareHandler = async (context, next) => {
  await next();
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('X-Frame-Options', 'DENY');
  context.header('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'");
  context.header('Referrer-Policy', 'same-origin');
};
