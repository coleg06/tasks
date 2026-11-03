/// <reference types="node" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { app } from '../../src/app';
import type { TaskAppEnv } from '../../src/app-env';
import { SESSION_COOKIE } from '../../src/auth/session';
import type { Env } from '../../src/env';
import {
  assetVersionMutationSchema,
  eventIntakeSchema,
  eventSourceSchema,
} from '../../src/events/schemas';
import { withMobileIdempotency } from '../../src/mobile/idempotency';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { tenantRuntimeAdapters } from '../../src/runtime/tenant-adapters';
import { effectiveMigrationsDirectory } from '../support/migrations';

const origin = 'https://tasks.example.org';
const CSRF = 'c'.repeat(43);
const trustedUpstream = {
  TASKS_AUTH_MODE: 'trusted-upstream',
  TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER: 'X-Forwarded-Email',
  TASKS_TRUSTED_UPSTREAM_TRUST: 'proxy-replaces-headers',
} as const;

describe('web link validation', () => {
  const registrationUrl = eventIntakeSchema.shape.registration.shape.url;

  it('accepts only http and https addresses for stored links', () => {
    for (const good of ['https://example.org/form', 'http://example.org/x']) {
      expect(assetVersionMutationSchema.shape.url.safeParse(good).success, good).toBe(true);
      expect(registrationUrl.safeParse(good).success, good).toBe(true);
    }
    expect(registrationUrl.parse('')).toBeNull();
    for (const bad of ['javascript:void(0)', 'data:text/plain,x', 'ftp://example.org/x']) {
      expect(assetVersionMutationSchema.shape.url.safeParse(bad).success, bad).toBe(false);
      expect(registrationUrl.safeParse(bad).success, bad).toBe(false);
      expect(eventSourceSchema.safeParse({ system: 's', id: '1', url: bad }).success, bad).toBe(
        false,
      );
    }
  });
});

describe.runIf(
  tenantProfile.tasks.apiMode === 'legacy' &&
    tenantRuntimeAdapters.browserAuthentication === 'session-cookie',
)('request hardening on SQLite', () => {
  let directory: string;
  let database: SqliteDatabase;
  const env = () =>
    ({
      DB: database,
      ASSETS: { fetch: async () => new Response('asset') },
      ENVIRONMENT: 'production',
      RELEASE_SHA: 'test',
      TASKS_PUBLIC_ORIGIN: origin,
      TASKS_INITIAL_ADMIN_EMAIL: 'admin@example.org',
      ...trustedUpstream,
    }) as unknown as Env;
  // A trusted-upstream request carries the same-origin and double-submit CSRF proof a browser sends.
  const post = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    app.request(
      `${origin}${path}`,
      {
        method: 'POST',
        body,
        headers: {
          'X-Forwarded-Email': 'admin@example.org',
          Origin: origin,
          Cookie: `${tenantProfile.security.cookiePrefix}_csrf=${CSRF}`,
          'X-CSRF-Token': CSRF,
          ...headers,
        },
      },
      env(),
    );

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'tasks-hardening-'));
    database = new SqliteDatabase(join(directory, 'tasks.db'));
    runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
  });
  afterAll(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('marks every response non-sniffable, unframeable and referrer-limited', async () => {
    for (const path of ['/healthz', '/api/bootstrap', '/some/page']) {
      const response = await app.request(`${origin}${path}`, {}, env());
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('x-frame-options'), path).toBe('DENY');
      expect(response.headers.get('content-security-policy'), path).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get('referrer-policy'), path).toBe('same-origin');
    }
  });

  it('refuses an oversized JSON body before parsing it', async () => {
    const body = JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024) });
    const response = await post('/api/tasks', body, { 'Content-Type': 'application/json' });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
  });

  it('refuses an upload above the asset limit plus envelope before parsing it', async () => {
    const form = new FormData();
    form.append(
      'file',
      new File([new Uint8Array(53 * 1024 * 1024)], 'big.png', { type: 'image/png' }),
    );
    const response = await post('/api/events/EVT-1/deliverables/DEL-1/assets/upload', form);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'payload_too_large' });
  });

  it('answers a body that is not JSON with 400, not a server error', async () => {
    const response = await post('/api/tasks', '{not json', { 'Content-Type': 'application/json' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_json' });
  });

  it('rejects a cross-site sign-out but allows a same-origin one', async () => {
    const cross = await app.request(
      `${origin}/auth/logout`,
      { method: 'POST', headers: { Origin: 'https://evil.example' } },
      env(),
    );
    expect(cross.status).toBe(403);
    expect(cross.headers.get('set-cookie')).toBeNull();
    const same = await app.request(
      `${origin}/auth/logout`,
      { method: 'POST', headers: { Origin: origin } },
      env(),
    );
    expect(same.status).toBe(302);
    expect(same.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=`);
  });
});

describe('idempotent operations that throw', () => {
  let directory: string;
  let database: SqliteDatabase;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'tasks-idempotency-'));
    database = new SqliteDatabase(join(directory, 'tasks.db'));
    runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
    database.raw.exec("INSERT INTO users (email, first_name) VALUES ('idem@example.org', 'Idem')");
  });
  afterAll(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('releases the key so a retry runs again instead of answering request_in_progress', async () => {
    let attempts = 0;
    const small = new Hono<TaskAppEnv>();
    small.use('*', async (context, next) => {
      context.set('taskIdentity', {
        session: { sub: '1', email: 'idem@example.org', perms: [], exp: 0 },
        user: { id: 1, email: 'idem@example.org', status: 'active' },
        auditUserId: 1,
      });
      await next();
    });
    small.post('/work', (context) =>
      withMobileIdempotency(context, async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient failure');
        return context.json({ ok: true }, 201);
      }),
    );
    const send = () =>
      small.request(
        '/work',
        { method: 'POST', headers: { 'Idempotency-Key': 'retry-after-throw-1' }, body: '{}' },
        { DB: database } as unknown as Env,
      );
    await expect(send()).resolves.toMatchObject({ status: 500 });
    const retry = await send();
    expect(retry.status).toBe(201);
    expect(attempts).toBe(2);
  });
});
