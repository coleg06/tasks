import type { Context } from 'hono';
import type { TaskAppEnv } from '../tasks/api';
import { sha256Hex } from './assertion';

const keyPattern = /^[A-Za-z0-9._:-]{8,128}$/;

export async function withMobileIdempotency(
  context: Context<TaskAppEnv>,
  operation: () => Promise<Response>,
) {
  const identity = context.get('taskIdentity');
  if (!identity) return context.json({ error: 'unauthorized' }, 401);
  const key = context.req.header('Idempotency-Key') ?? '';
  if (!keyPattern.test(key)) return context.json({ error: 'invalid_idempotency_key' }, 400);

  const url = new URL(context.req.url);
  const requestHash = await sha256Hex(
    [
      context.req.method.toUpperCase(),
      url.pathname,
      url.search.slice(1),
      await sha256Hex(await context.req.raw.clone().arrayBuffer()),
      context.req.header('If-Match') ?? '',
    ].join('\n'),
  );
  const scope = `${context.req.method.toUpperCase()}:${url.pathname}`;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 7 * 24 * 60 * 60;

  await context.env.DB.prepare('DELETE FROM mobile_idempotency_keys WHERE expires_at < ?')
    .bind(now)
    .run();
  const reservation = await context.env.DB.prepare(
    `INSERT OR IGNORE INTO mobile_idempotency_keys
       (user_id, scope, idempotency_key, request_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(identity.user.id, scope, key, requestHash, expiresAt)
    .run();

  if (reservation.meta.changes !== 1) {
    const existing = await context.env.DB.prepare(
      `SELECT request_hash, status, response_status, response_body
       FROM mobile_idempotency_keys
       WHERE user_id = ? AND scope = ? AND idempotency_key = ?`,
    )
      .bind(identity.user.id, scope, key)
      .first<{
        request_hash: string;
        status: string;
        response_status: number | null;
        response_body: string | null;
      }>();
    if (!existing || existing.request_hash !== requestHash) {
      return context.json({ error: 'idempotency_key_reused' }, 409);
    }
    if (existing.status !== 'completed' || existing.response_status === null) {
      return context.json({ error: 'request_in_progress' }, 409);
    }
    return new Response(existing.response_body ?? null, {
      status: existing.response_status,
      headers: {
        'Content-Type': existing.response_status === 204 ? '' : 'application/json; charset=UTF-8',
        'X-Idempotent-Replay': 'true',
      },
    });
  }

  const response = await operation();
  const body = await response.clone().text();
  if (response.status >= 500) {
    await context.env.DB.prepare(
      `DELETE FROM mobile_idempotency_keys
       WHERE user_id = ? AND scope = ? AND idempotency_key = ?`,
    )
      .bind(identity.user.id, scope, key)
      .run();
    return response;
  }
  await context.env.DB.prepare(
    `UPDATE mobile_idempotency_keys
     SET status = 'completed', response_status = ?, response_body = ?,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE user_id = ? AND scope = ? AND idempotency_key = ?`,
  )
    .bind(response.status, body, identity.user.id, scope, key)
    .run();
  return response;
}
