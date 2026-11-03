/// <reference types="node" />

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { app } from '../../src/app';
import { admitGoogleSignIn, SignInDeniedError } from '../../src/auth/provision';
import type { Env } from '../../src/env';
import {
  authModeProblems,
  configuredAuthMode,
  trustedUpstreamSettings,
} from '../../src/identity/auth-mode';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import {
  configuredHostedDomain,
  initialAdminEmails,
  isHostedEmail,
  isInitialAdminEmail,
  publicOrigin,
} from '../../src/runtime/identity-config';
import { tenantRuntimeAdapters } from '../../src/runtime/tenant-adapters';
import { missingIdentityVariables } from '../../src/self-hosted/platform';
import { effectiveMigrationsDirectory } from '../support/migrations';

const origin = 'https://tasks.example.org';
const complete = {
  TASKS_AUTH_MODE: 'trusted-upstream',
  TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER: 'X-Forwarded-Email',
  TASKS_TRUSTED_UPSTREAM_NAME_HEADER: 'X-Forwarded-User',
  TASKS_TRUSTED_UPSTREAM_TRUST: 'proxy-replaces-headers',
} as const;

describe('authentication mode configuration', () => {
  it('defaults to session sign-in and rejects unknown modes', () => {
    expect(configuredAuthMode({})).toBe('session');
    expect(configuredAuthMode({ TASKS_AUTH_MODE: 'session' })).toBe('session');
    expect(configuredAuthMode({ TASKS_AUTH_MODE: ' trusted-upstream ' })).toBe('trusted-upstream');
    expect(configuredAuthMode({ TASKS_AUTH_MODE: 'password' })).toBe('invalid');
    expect(authModeProblems({ TASKS_AUTH_MODE: 'password' })).toEqual(['TASKS_AUTH_MODE']);
  });

  it('names every missing or malformed trusted-upstream setting and no values', () => {
    expect(authModeProblems({ TASKS_AUTH_MODE: 'trusted-upstream' })).toEqual([
      'TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER',
      'TASKS_TRUSTED_UPSTREAM_TRUST',
    ]);
    expect(
      authModeProblems({
        ...complete,
        TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER: 'bad header',
        TASKS_TRUSTED_UPSTREAM_NAME_HEADER: 'bad\nname',
        TASKS_TRUSTED_UPSTREAM_TRUST: 'yes',
      }),
    ).toEqual([
      'TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER',
      'TASKS_TRUSTED_UPSTREAM_NAME_HEADER',
      'TASKS_TRUSTED_UPSTREAM_TRUST',
    ]);
    expect(authModeProblems(complete)).toEqual([]);
    expect(trustedUpstreamSettings(complete)).toEqual({
      emailHeader: 'X-Forwarded-Email',
      nameHeader: 'X-Forwarded-User',
    });
    expect(trustedUpstreamSettings({ ...complete, TASKS_TRUSTED_UPSTREAM_TRUST: '' })).toBeNull();
    expect(trustedUpstreamSettings({ TASKS_AUTH_MODE: 'session' })).toBeNull();
  });

  it.runIf(tenantProfile.tasks.apiMode === 'legacy')(
    'reports the variables the selected mode needs at startup',
    () => {
      expect(missingIdentityVariables({})).toEqual([
        'SESSION_SECRET',
        'GOOGLE_CLIENT_ID',
        'GOOGLE_CLIENT_SECRET',
      ]);
      expect(missingIdentityVariables({ TASKS_AUTH_MODE: 'trusted-upstream' })).toEqual([
        'TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER',
        'TASKS_TRUSTED_UPSTREAM_TRUST',
      ]);
      // Trusted-upstream needs no Google or session-secret variables.
      expect(missingIdentityVariables(complete)).toEqual([]);
    },
  );
});

describe('runtime identity settings', () => {
  it('applies the hosted domain and treats an unset domain as unrestricted', () => {
    const domain = configuredHostedDomain({ TASKS_HOSTED_DOMAIN: ' @Example.ORG ' });
    // A domain compiled into the profile always wins over the runtime setting.
    expect(domain).toBe(tenantProfile.identity.hostedDomain || 'example.org');
    if (!tenantProfile.identity.hostedDomain) {
      expect(isHostedEmail({ TASKS_HOSTED_DOMAIN: 'example.org' }, 'a@example.org')).toBe(true);
      expect(isHostedEmail({ TASKS_HOSTED_DOMAIN: 'example.org' }, 'a@example.net')).toBe(false);
      expect(isHostedEmail({}, 'a@example.net')).toBe(true);
    }
    expect(isHostedEmail({}, 'not-an-email')).toBe(false);
  });

  it('adds the configured first administrator to the profile administrator', () => {
    const emails = initialAdminEmails({ TASKS_INITIAL_ADMIN_EMAIL: ' Admin@Example.org ' });
    expect(emails).toContain('admin@example.org');
    expect(
      isInitialAdminEmail({ TASKS_INITIAL_ADMIN_EMAIL: 'admin@example.org' }, 'ADMIN@example.org'),
    ).toBe(true);
    expect(isInitialAdminEmail({}, 'admin@example.org')).toBe(
      tenantProfile.identity.initialAdminEmail.toLowerCase() === 'admin@example.org',
    );
    // No default: with nothing configured nobody is an administrator by address.
    expect(isInitialAdminEmail({}, 'anyone@example.org')).toBe(false);
  });

  it('prefers TASKS_PUBLIC_ORIGIN and rejects a malformed value', () => {
    const env = {
      ENVIRONMENT: 'production',
      TASKS_PUBLIC_ORIGIN: 'https://tasks.example.org/',
    } as Env;
    expect(publicOrigin(env, 'http://internal:8080/x')).toBe('https://tasks.example.org');
    expect(() =>
      publicOrigin({ ...env, TASKS_PUBLIC_ORIGIN: 'ftp://x' } as Env, 'http://a/'),
    ).toThrow();
  });
});

describe.runIf(
  tenantProfile.tasks.apiMode === 'legacy' &&
    tenantRuntimeAdapters.browserAuthentication === 'session-cookie',
)('trusted-upstream sign-in on SQLite', () => {
  let directory: string;
  let database: SqliteDatabase;
  const env = (extra: Record<string, string> = {}) =>
    ({
      DB: database,
      ASSETS: { fetch: async () => new Response('asset') },
      ENVIRONMENT: 'production',
      RELEASE_SHA: 'test',
      TASKS_PUBLIC_ORIGIN: origin,
      TASKS_INITIAL_ADMIN_EMAIL: 'admin@example.org',
      ...complete,
      ...extra,
    }) as unknown as Env;
  const get = (path: string, headers: Record<string, string>, extra?: Record<string, string>) =>
    app.request(`${origin}${path}`, { headers }, env(extra));

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'tasks-trusted-'));
    database = new SqliteDatabase(join(directory, 'tasks.db'));
    runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
  });
  afterAll(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('fails closed with 503 when the selected mode is not fully configured', async () => {
    for (const missing of [
      'TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER',
      'TASKS_TRUSTED_UPSTREAM_TRUST',
    ] as const) {
      const response = await get(
        '/api/bootstrap',
        { 'X-Forwarded-Email': 'admin@example.org' },
        {
          [missing]: '',
        },
      );
      expect(response.status, missing).toBe(503);
      expect(await response.json()).toEqual({ error: 'trusted_upstream_not_configured' });
    }
    const unknownMode = await get('/api/bootstrap', {}, { TASKS_AUTH_MODE: 'password' });
    expect(unknownMode.status).toBe(503);
  });

  it('authenticates only the configured header, case-insensitively, and nothing else', async () => {
    expect((await get('/api/bootstrap', {})).status).toBe(401);
    expect((await get('/api/bootstrap', { 'X-Authentik-Email': 'admin@example.org' })).status).toBe(
      401,
    );
    // A forged session cookie is ignored even when it would verify and no header is sent.
    expect((await get('/api/bootstrap', { Cookie: 'tasks_session=forged' })).status).toBe(401);
    expect((await get('/auth/login', {})).status).toBe(404);
  });

  it('bootstraps the configured first administrator once and grants full access', async () => {
    const first = await get('/api/bootstrap', {
      'x-forwarded-email': 'Admin@Example.org',
      'x-forwarded-user': 'Ada Admin',
    });
    expect(first.status).toBe(200);
    const body = (await first.json()) as {
      permissions: string[];
      release: string;
      user: { email: string; first_name: string };
    };
    expect(body.release).toBe('test');
    expect(body.user).toMatchObject({ email: 'admin@example.org', first_name: 'Ada' });
    expect(body.permissions).toEqual(expect.arrayContaining(['tasks.manage', 'platform.admin']));
    const users = await database
      .prepare('SELECT COUNT(*) AS n FROM users WHERE email = ? COLLATE NOCASE')
      .bind('admin@example.org')
      .first<{ n: number }>();
    expect(users?.n).toBe(1);
    expect((await get('/api/bootstrap', { 'X-Forwarded-Email': 'admin@example.org' })).status).toBe(
      200,
    );
  });

  it('does not make any other address an administrator', async () => {
    const response = await get(
      '/api/bootstrap',
      { 'X-Forwarded-Email': 'person@example.org' },
      { TASKS_HOSTED_DOMAIN: 'example.org' },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { permissions: string[] };
    expect(body.permissions).not.toContain('tasks.manage');
    expect(body.permissions).not.toContain('platform.admin');
    const admin = await get(
      '/api/admin',
      { 'X-Forwarded-Email': 'person@example.org' },
      { TASKS_HOSTED_DOMAIN: 'example.org' },
    );
    expect(admin.status).toBe(403);
  });

  it('never signs in the agent principal as a person', async () => {
    const response = await get('/api/bootstrap', {
      'X-Forwarded-Email': tenantProfile.agent.email.toUpperCase(),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'access_denied' });
  });

  it('denies unknown addresses by default and creates no row or grant for them', async () => {
    const count = async (email: string) =>
      (
        await database
          .prepare('SELECT COUNT(*) AS n FROM users WHERE email = ? COLLATE NOCASE')
          .bind(email)
          .first<{ n: number }>()
      )?.n;
    const response = await get('/api/bootstrap', { 'X-Forwarded-Email': 'nobody@example.org' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'access_denied' });
    expect(await count('nobody@example.org')).toBe(0);
    // A user an administrator created in advance may sign in, with or without a hosted domain.
    await database
      .prepare("INSERT INTO users (email, first_name) VALUES ('invited@example.org', 'Invited')")
      .run();
    expect(
      (await get('/api/bootstrap', { 'X-Forwarded-Email': 'invited@example.org' })).status,
    ).toBe(200);
    // With a hosted domain, addresses in it are created on first sight.
    const created = await get(
      '/api/bootstrap',
      { 'X-Forwarded-Email': 'newcomer@example.org' },
      { TASKS_HOSTED_DOMAIN: 'example.org' },
    );
    expect(created.status).toBe(200);
    expect(await count('newcomer@example.org')).toBe(1);
  });

  it('rejects addresses outside the hosted domain and malformed header values', async () => {
    const withDomain = { TASKS_HOSTED_DOMAIN: 'example.org' };
    expect(
      (await get('/api/bootstrap', { 'X-Forwarded-Email': 'x@elsewhere.test' }, withDomain)).status,
    ).toBe(401);
    expect((await get('/api/bootstrap', { 'X-Forwarded-Email': 'not-an-email' })).status).toBe(401);
    expect(
      (await get('/api/bootstrap', { 'X-Forwarded-Email': `${'a'.repeat(260)}@example.org` }))
        .status,
    ).toBe(401);
  });

  it('keeps CSRF protection for header-authenticated writes', async () => {
    const response = await app.request(
      `${origin}/api/tasks`,
      {
        method: 'POST',
        headers: { 'X-Forwarded-Email': 'admin@example.org', 'Content-Type': 'application/json' },
        body: '{}',
      },
      env(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'csrf_rejected' });
  });

  it('keeps Google sign-in unrestricted by default and restricts it only when configured', async () => {
    const session = {
      TASKS_AUTH_MODE: '',
      GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret-for-test-only',
      SESSION_SECRET: 's'.repeat(40),
    };
    const open = await get('/auth/login', {}, session);
    expect(open.status).toBe(302);
    const unrestricted = new URL(open.headers.get('location') ?? '');
    expect(unrestricted.searchParams.has('hd')).toBe(tenantProfile.identity.hostedDomain !== '');
    expect(unrestricted.searchParams.get('redirect_uri')).toBe(`${origin}/auth/callback`);
    const restricted = await get(
      '/auth/login',
      {},
      { ...session, TASKS_HOSTED_DOMAIN: 'example.org' },
    );
    expect(new URL(restricted.headers.get('location') ?? '').searchParams.get('hd')).toBe(
      tenantProfile.identity.hostedDomain || 'example.org',
    );
    const unconfigured = await get('/auth/login', {}, { ...session, GOOGLE_CLIENT_SECRET: '' });
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: 'auth_not_configured' });
  });

  it('refuses a disabled user', async () => {
    await database
      .prepare("UPDATE users SET status = 'disabled' WHERE email = ? COLLATE NOCASE")
      .bind('person@example.org')
      .run();
    expect(
      (await get('/api/bootstrap', { 'X-Forwarded-Email': 'person@example.org' })).status,
    ).toBe(401);
  });
});

describe.runIf(tenantProfile.tasks.apiMode === 'legacy')('Google sign-in admission', () => {
  let directory: string;
  let database: SqliteDatabase;
  const identity = (email: string) => ({
    email,
    firstName: 'Test',
    lastName: 'Person',
    photoUrl: null,
    subject: `google-oauth2|${Math.abs([...email].reduce((h, c) => h * 31 + c.charCodeAt(0), 7))}`,
  });
  const env = (extra: Record<string, string> = {}) =>
    ({ DB: database, ...extra }) as unknown as Env;
  const rows = async (email: string) =>
    (
      await database
        .prepare('SELECT COUNT(*) AS n FROM users WHERE email = ? COLLATE NOCASE')
        .bind(email)
        .first<{ n: number }>()
    )?.n;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'tasks-admit-'));
    database = new SqliteDatabase(join(directory, 'tasks.db'));
    runMigrations(database.raw, readMigrations(effectiveMigrationsDirectory()));
  });
  afterAll(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('denies an unknown address without a hosted domain and writes nothing', async () => {
    await expect(admitGoogleSignIn(env(), identity('stranger@example.org'))).rejects.toBeInstanceOf(
      SignInDeniedError,
    );
    expect(await rows('stranger@example.org')).toBe(0);
    // A configured domain that the address is not in does not admit it either.
    await expect(
      admitGoogleSignIn(env({ TASKS_HOSTED_DOMAIN: 'example.org' }), identity('who@example.net')),
    ).rejects.toBeInstanceOf(SignInDeniedError);
    expect(await rows('who@example.net')).toBe(0);
  });

  it('creates only the configured first administrator, with every permission', async () => {
    const admin = await admitGoogleSignIn(
      env({ TASKS_INITIAL_ADMIN_EMAIL: 'first@example.org' }),
      identity('first@example.org'),
    );
    const grants = await database
      .prepare('SELECT COUNT(*) AS n FROM user_permissions WHERE user_id = ?')
      .bind(admin.id)
      .first<{ n: number }>();
    const available = await database
      .prepare('SELECT COUNT(*) AS n FROM permissions')
      .first<{ n: number }>();
    expect(grants?.n).toBe(available?.n);
  });

  it('admits administrator-created users, and domain members when a domain is configured', async () => {
    await database
      .prepare("INSERT INTO users (email, first_name) VALUES ('invited@example.org', 'Invited')")
      .run();
    const invited = await admitGoogleSignIn(env(), identity('invited@example.org'));
    expect(invited.email).toBe('invited@example.org');
    const member = await admitGoogleSignIn(
      env({ TASKS_HOSTED_DOMAIN: 'example.org' }),
      identity('member@example.org'),
    );
    expect(member.email).toBe('member@example.org');
    expect(await rows('member@example.org')).toBe(1);
  });

  it('refuses a disabled user', async () => {
    await database
      .prepare("UPDATE users SET status = 'disabled' WHERE email = 'invited@example.org'")
      .run();
    await expect(admitGoogleSignIn(env(), identity('invited@example.org'))).rejects.toThrow(
      'disabled',
    );
  });
});
