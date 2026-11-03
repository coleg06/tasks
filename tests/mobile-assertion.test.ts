import { describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import type { Env } from '../src/env';
import {
  GATEWAY_ASSERTION_HEADER,
  GATEWAY_SIGNATURE_HEADER,
  type GatewayAssertion,
  GatewayAssertionError,
  gatewayHmacHex,
  resolveGatewayUser,
  sha256Hex,
  verifyGatewayAssertion,
} from '../src/mobile/assertion';

const secret = 'g'.repeat(32);

function base64Url(value: string) {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function signedRequest(
  url = 'https://tasks-dev.example.org/api/mobile/v1/tasks?view=mine',
  overrides: Partial<GatewayAssertion> = {},
  init: RequestInit = {},
) {
  const now = 1_787_310_000;
  const body = typeof init.body === 'string' ? init.body : '';
  const parsedUrl = new URL(url);
  const claims: GatewayAssertion = {
    v: 1,
    iss: tenantProfile.integrations.mobileGateway.issuer,
    aud: tenantProfile.integrations.mobileGateway.audience,
    env: 'dev',
    sub: '42',
    email: 'staff@example.org',
    permissions: ['dashboard.view', 'events.view'],
    method: (init.method ?? 'GET').toUpperCase(),
    path: parsedUrl.pathname,
    query: parsedUrl.search.slice(1),
    body_sha256: await sha256Hex(body),
    request_id: '00000000-0000-4000-8000-000000000001',
    iat: now,
    exp: now + 30,
    ...overrides,
  };
  const assertion = base64Url(JSON.stringify(claims));
  const headers = new Headers(init.headers);
  headers.set(GATEWAY_ASSERTION_HEADER, assertion);
  headers.set(GATEWAY_SIGNATURE_HEADER, `v1=${await gatewayHmacHex(secret, assertion)}`);
  return {
    now,
    request: new Request(url, { ...init, headers }),
  };
}

const env = {
  ENVIRONMENT: 'dev',
  TASKS_GATEWAY_ASSERTION_SECRET: secret,
} as unknown as Env;

describe.runIf(tenantProfile.capabilities.mobileApi)('Portal mobile gateway assertion', () => {
  it('accepts the exact signed method, path, query, body, identity, and time window', async () => {
    const { now, request } = await signedRequest();
    await expect(verifyGatewayAssertion(request, env, now)).resolves.toMatchObject({
      sub: '42',
      email: 'staff@example.org',
      permissions: ['dashboard.view', 'events.view'],
    });
  });

  it('rejects request binding changes even when the assertion itself is valid', async () => {
    const { now, request } = await signedRequest(
      'https://tasks-dev.example.org/api/mobile/v1/tasks?view=open',
      { query: 'view=mine' },
    );
    await expect(verifyGatewayAssertion(request, env, now)).rejects.toMatchObject({
      code: 'request_binding_mismatch',
    });
  });

  it('rejects expired assertions, forwarded credentials, and production use', async () => {
    const expired = await signedRequest(undefined, { iat: 1_787_309_900, exp: 1_787_309_930 });
    await expect(verifyGatewayAssertion(expired.request, env, expired.now)).rejects.toMatchObject({
      code: 'assertion_expired',
    });

    const forwarded = await signedRequest(undefined, {}, { headers: { Cookie: 'session=unsafe' } });
    await expect(
      verifyGatewayAssertion(forwarded.request, env, forwarded.now),
    ).rejects.toMatchObject({ code: 'forwarded_credentials_rejected' });

    const valid = await signedRequest();
    await expect(
      verifyGatewayAssertion(valid.request, { ...env, ENVIRONMENT: 'production' }, valid.now),
    ).rejects.toEqual(new GatewayAssertionError('not_found', 404));
  });

  it('fails closed instead of choosing between duplicate normalized email candidates', async () => {
    const first = vi.fn(async () => null);
    const all = vi.fn(async () => ({
      results: [
        { id: 1, email: 'staff@example.org', status: 'active', portal_db_id: null },
        { id: 2, email: 'STAFF@example.org', status: 'active', portal_db_id: null },
      ],
    }));
    const bind = vi.fn(() => ({ first, all }));
    const batch = vi.fn();
    const duplicateEnv = {
      ...env,
      DB: { prepare: vi.fn(() => ({ bind })), batch },
    } as unknown as Env;
    const { now, request } = await signedRequest();
    const claims = await verifyGatewayAssertion(request, env, now);
    await expect(resolveGatewayUser(duplicateEnv, claims)).rejects.toMatchObject({
      code: 'tasks_user_not_found',
    });
    expect(batch).not.toHaveBeenCalled();
  });
});
