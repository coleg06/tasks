import { isTenantHostedEmail, tenantProfile } from '../../shared/tenant-profile';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import type { Env } from '../env';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const GATEWAY_HEADER_PREFIX =
  tenantExtensions().integrations?.mobileGateway?.headerPrefix ?? 'X-Tasks';
export const GATEWAY_ASSERTION_HEADER = `${GATEWAY_HEADER_PREFIX}-Assertion`;
export const GATEWAY_SIGNATURE_HEADER = `${GATEWAY_HEADER_PREFIX}-Signature`;

const unsafeForwardedHeaders = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'x-forwarded-authorization',
  'x-original-authorization',
] as const;

export type GatewayAssertion = {
  v: 1;
  iss: string;
  aud: string;
  env: string;
  sub: string;
  email: string;
  permissions: string[];
  method: string;
  path: string;
  query: string;
  body_sha256: string;
  request_id: string;
  iat: number;
  exp: number;
};

export type GatewayUser = {
  id: number;
  email: string;
  status: string;
  portal_db_id: number | null;
};

export class GatewayAssertionError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 503 = 401,
  ) {
    super(code);
    this.name = 'GatewayAssertionError';
  }
}

function bytesToHex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string) {
  const bytes =
    typeof value === 'string'
      ? encoder.encode(value)
      : value instanceof Uint8Array
        ? value
        : new Uint8Array(value);
  return bytesToHex(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
}

export async function gatewayHmacHex(secret: string, assertion: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return bytesToHex(await crypto.subtle.sign('HMAC', key, encoder.encode(assertion)));
}

function constantTimeHexEqual(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  let mismatch = 0;
  for (let index = 0; index < 64; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

function decodeAssertion(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new GatewayAssertionError('invalid_assertion');
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = `${base64}${'='.repeat((4 - (base64.length % 4)) % 4)}`;
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new GatewayAssertionError('invalid_assertion');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validatedClaims(value: unknown): GatewayAssertion {
  if (!isRecord(value)) throw new GatewayAssertionError('invalid_assertion');
  const expectedKeys = [
    'aud',
    'body_sha256',
    'email',
    'env',
    'exp',
    'iat',
    'iss',
    'method',
    'path',
    'permissions',
    'query',
    'request_id',
    'sub',
    'v',
  ];
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)) {
    throw new GatewayAssertionError('invalid_assertion');
  }
  const permissions = value.permissions;
  if (
    value.v !== 1 ||
    value.iss !== tenantProfile.integrations.mobileGateway.issuer ||
    value.aud !== tenantProfile.integrations.mobileGateway.audience ||
    value.env !== tenantProfile.integrations.mobileGateway.environment ||
    typeof value.sub !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.sub) ||
    !Number.isSafeInteger(Number(value.sub)) ||
    typeof value.email !== 'string' ||
    value.email !== value.email.trim().toLowerCase() ||
    !isTenantHostedEmail(value.email) ||
    !Array.isArray(permissions) ||
    permissions.length > 128 ||
    !permissions.every(
      (permission) => typeof permission === 'string' && /^[a-z][a-z0-9_.-]{1,95}$/.test(permission),
    ) ||
    new Set(permissions).size !== permissions.length ||
    JSON.stringify(permissions) !== JSON.stringify([...permissions].sort()) ||
    typeof value.method !== 'string' ||
    !/^(GET|POST|PATCH|DELETE)$/.test(value.method) ||
    typeof value.path !== 'string' ||
    !value.path.startsWith('/api/mobile/v1/') ||
    typeof value.query !== 'string' ||
    typeof value.body_sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.body_sha256) ||
    typeof value.request_id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.request_id,
    ) ||
    !Number.isInteger(value.iat) ||
    !Number.isInteger(value.exp)
  ) {
    throw new GatewayAssertionError('invalid_assertion');
  }
  return value as GatewayAssertion;
}

export async function verifyGatewayAssertion(
  request: Request,
  env: Env,
  now = Math.floor(Date.now() / 1000),
) {
  if (env.ENVIRONMENT !== 'dev') throw new GatewayAssertionError('not_found', 404);
  if (!env.TASKS_GATEWAY_ASSERTION_SECRET || env.TASKS_GATEWAY_ASSERTION_SECRET.length < 32) {
    throw new GatewayAssertionError('mobile_adapter_not_configured', 503);
  }
  if (unsafeForwardedHeaders.some((header) => request.headers.has(header))) {
    throw new GatewayAssertionError('forwarded_credentials_rejected', 400);
  }

  const encoded = request.headers.get(GATEWAY_ASSERTION_HEADER) ?? '';
  const signatureHeader = request.headers.get(GATEWAY_SIGNATURE_HEADER) ?? '';
  const signatureMatch = /^v1=([a-f0-9]{64})$/.exec(signatureHeader);
  if (!encoded || !signatureMatch?.[1]) throw new GatewayAssertionError('missing_assertion');
  const expectedSignature = await gatewayHmacHex(env.TASKS_GATEWAY_ASSERTION_SECRET, encoded);
  if (!constantTimeHexEqual(signatureMatch[1], expectedSignature)) {
    throw new GatewayAssertionError('invalid_signature');
  }

  const claims = validatedClaims(decodeAssertion(encoded));
  const url = new URL(request.url);
  const bodyDigest = await sha256Hex(await request.clone().arrayBuffer());
  if (
    claims.method !== request.method.toUpperCase() ||
    claims.path !== url.pathname ||
    claims.query !== url.search.slice(1) ||
    claims.body_sha256 !== bodyDigest
  ) {
    throw new GatewayAssertionError('request_binding_mismatch');
  }
  if (
    claims.exp !== claims.iat + 30 ||
    claims.iat < now - 30 ||
    claims.iat > now + 30 ||
    claims.exp <= now
  ) {
    throw new GatewayAssertionError('assertion_expired');
  }
  return claims;
}

export async function resolveGatewayUser(env: Env, claims: GatewayAssertion) {
  const portalUserId = Number(claims.sub);
  let user = await env.DB.prepare(
    'SELECT id, email, status, portal_db_id FROM users WHERE portal_db_id = ?',
  )
    .bind(portalUserId)
    .first<GatewayUser>();
  if (user) {
    if (user.status !== 'active') throw new GatewayAssertionError('tasks_access_disabled', 403);
    if (user.email.toLowerCase() !== claims.email) {
      throw new GatewayAssertionError('identity_binding_mismatch', 403);
    }
    return user;
  }

  const candidates = await env.DB.prepare(
    `SELECT id, email, status, portal_db_id FROM users
     WHERE lower(trim(email)) = ? AND status = 'active'
     ORDER BY id LIMIT 2`,
  )
    .bind(claims.email)
    .all<GatewayUser>();
  if (candidates.results.length !== 1 || !candidates.results[0]) {
    throw new GatewayAssertionError('tasks_user_not_found', 403);
  }
  user = candidates.results[0];
  if (user.portal_db_id !== null && user.portal_db_id !== portalUserId) {
    throw new GatewayAssertionError('identity_binding_mismatch', 403);
  }
  if (user.portal_db_id === null) {
    try {
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE users SET portal_db_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
           WHERE id = ? AND portal_db_id IS NULL`,
        ).bind(portalUserId, user.id),
        env.DB.prepare(
          `INSERT INTO audit_events (
             actor_user_id, entity_type, entity_key, action, changes_json, request_id
           ) SELECT ?, 'user', ?, 'user.portal_identity_linked', ?, ?
           WHERE EXISTS (
             SELECT 1 FROM users WHERE id = ? AND portal_db_id = ?
           )`,
        ).bind(
          user.id,
          String(user.id),
          JSON.stringify({ portalDbId: portalUserId }),
          claims.request_id,
          user.id,
          portalUserId,
        ),
      ]);
      if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
        throw new GatewayAssertionError('identity_binding_conflict', 409);
      }
    } catch (error) {
      if (error instanceof GatewayAssertionError) throw error;
      throw new GatewayAssertionError('identity_binding_conflict', 409);
    }
    user = { ...user, portal_db_id: portalUserId };
  }
  return user;
}

export async function reserveGatewayRequest(env: Env, claims: GatewayAssertion, userId: number) {
  await env.DB.prepare('DELETE FROM mobile_gateway_requests WHERE expires_at < ?')
    .bind(Math.floor(Date.now() / 1000) - 60)
    .run();
  const reservation = await env.DB.prepare(
    `INSERT OR IGNORE INTO mobile_gateway_requests
       (request_id, user_id, portal_user_id, expires_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(claims.request_id, userId, Number(claims.sub), claims.exp)
    .run();
  if (reservation.meta.changes !== 1) throw new GatewayAssertionError('assertion_replayed', 409);
}
