/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import * as profileSupport from '../../shared/tenant-profile-support';
import { app } from '../../src/app';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  signSession,
  verifyOAuthState,
} from '../../src/auth/session';
import type { Env } from '../../src/env';
import {
  formatPortalFacilityRequest,
  type PortalFacilityRequest,
  portalFacilityRequestSchema,
} from '../../src/integrations/portal-facility';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';
import { testOrigins } from '../support/origins';

const secret = 'synthetic-design-secret-for-local-tests-only';
const path = '/api/integrations/portal/facility-requests';
const id = '56f5df3b-10f1-4ecd-b7a8-2e9f79828451';
const originalExtensions = profileSupport.tenantExtensions();
const config = {
  campusLabels: { main: 'Main', espanol: 'Español' },
  projectKey: 'FACILITY',
  assigneeEmail: 'facilities@example.org',
  actorEmail: tenantProfile.agent.email,
  environment: 'deployment' as const,
};
const payload: PortalFacilityRequest = {
  version: 1,
  environment: 'dev',
  submission_id: id,
  submitted_at: '2026-01-02T03:04:05.123Z',
  requester: { name: 'María Pérez', email: 'maria@example.org' },
  locale: 'es',
  campus: Object.keys(config?.campusLabels ?? {})[1] ?? '',
  request_type: 'Repair or something is broken',
  urgency: 'Urgent: safety issue or happening right now',
  location: 'Sala principal',
  description: '  ¡Necesitamos ayuda!\nTexto original.  ',
  event_name: 'Encuentro',
  needed_by: '2026-01-01',
  reference_files: [{ name: 'diseño.pdf', type: 'application/pdf', size: 100 }],
};
let db: SqliteDatabase;
let env: Env;
const origin = testOrigins.development;
function request(body: unknown = payload, headers: Record<string, string> = {}) {
  return app.request(
    `${origin}${path}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        ...headers,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}
async function user(email: string, principal = 'human') {
  await db
    .prepare(
      'INSERT OR IGNORE INTO users (email, first_name, last_name, principal_type) VALUES (?, ?, ?, ?)',
    )
    .bind(email, 'Test', 'User', principal)
    .run();
  const u = await db
    .prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number; email: string }>();
  if (!u) throw new Error('missing fixture');
  await db
    .prepare(
      "INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'tasks.view')",
    )
    .bind(u.id)
    .run();
  await db
    .prepare(
      "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) SELECT id, ?, 'member' FROM workspaces WHERE workspace_key = ?",
    )
    .bind(u.id, tenantProfile.workspaceKey)
    .run();
  return u;
}
async function cookie(email: string) {
  const u = await user(email);
  return `${SESSION_COOKIE}=${await signSession(env, u, [])}`;
}
async function count(table: string) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
}
beforeEach(async () => {
  vi.spyOn(profileSupport, 'tenantExtensions').mockReturnValue({
    ...originalExtensions,
    integrations: { ...originalExtensions.integrations, portalFacility: config },
  });
  db = new SqliteDatabase(':memory:');
  runMigrations(db.raw, readMigrations(effectiveMigrationsDirectory()));
  env = {
    DB: db,
    EVENT_ASSETS: { put: async () => {}, get: async () => null, delete: async () => {} },
    ASSETS: {
      fetch: async () => new Response('spa'),
      connect: () => {
        throw new Error('unused');
      },
    },
    ENVIRONMENT: 'dev',
    RELEASE_SHA: 'test',
    SESSION_SECRET: secret,
    GOOGLE_CLIENT_ID: 'synthetic',
    GOOGLE_CLIENT_SECRET: 'synthetic',
    PORTAL_DESIGN_INGEST_SECRET: secret,
  } as Env;
  const actor = await user(config.actorEmail, 'agent');
  const designer = await user(config.assigneeEmail);
  await db
    .prepare(
      "INSERT INTO projects (project_key, name, workspace_id, visibility) SELECT ?, 'Facilities', id, 'private' FROM workspaces WHERE workspace_key = ?",
    )
    .bind(config.projectKey, tenantProfile.workspaceKey)
    .run();
  for (const [u, role] of [
    [actor.id, 'editor'],
    [designer.id, 'owner'],
  ]) {
    await db
      .prepare(
        'INSERT INTO project_members (project_id, user_id, role) SELECT id, ?, ? FROM projects WHERE project_key = ?',
      )
      .bind(u, role, config.projectKey)
      .run();
  }
});
afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

describe('facility payload and formatter', () => {
  it('preserves Spanish, overdue dates, file names, and full overflow text', () => {
    const formatted = formatPortalFacilityRequest(payload);
    expect(formatted.title).toBe(
      'Facility request: Repair or something is broken - Sala principal',
    );
    expect(formatted.description).toContain(payload.description);
    expect(formatted.description).toContain('Spanish (es)');
    expect(formatted.description).toContain('diseño.pdf');
    const large = {
      ...payload,
      description: 'á'.repeat(20_000),
    };
    const result = formatPortalFacilityRequest(large);
    expect(result.description.length).toBeLessThanOrEqual(10_000);
    expect(result.sourceContent.plainText).toContain(large.description);
    expect(
      formatPortalFacilityRequest({
        ...payload,
        location: 'x'.repeat(160),
      }).title.length,
    ).toBeLessThanOrEqual(240);
  });
  it('rejects malformed dates, uppercase UUIDs, unknown fields, unknown selections and unsafe file metadata', () => {
    for (const patch of [
      { version: 2 },
      { needed_by: '2026-02-30' },
      { submitted_at: '2026-01-01T01:00:00+01:00' },
      { submission_id: id.toUpperCase() },
      { unknown: true },
      { requester: { ...payload.requester, actor: 'x' } },
      { request_type: 'Unknown' },
      { urgency: 'Urgent' },
      { location: '  ' },
      { description: '' },
      { campus: 'unknown' },
      {
        reference_files: Array(3).fill({
          name: 'a.pdf',
          type: 'application/pdf',
          size: 2 * 1024 * 1024,
        }),
      },
      { reference_files: [{ name: 'a', type: 'text/html', size: 10 }] },
      { reference_files: [{ ...payload.reference_files[0], url: 'https://example.org' }] },
      { reference_files: [{ name: '../a.pdf', type: 'application/pdf', size: -1 }] },
    ])
      expect(
        portalFacilityRequestSchema.safeParse({ ...payload, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
  });
});

describe('facility integration default off', () => {
  it('returns 503 without a profile, even with a secret', async () => {
    vi.mocked(profileSupport.tenantExtensions).mockReturnValue({
      ...originalExtensions,
      integrations: { ...originalExtensions.integrations, portalFacility: undefined },
    });
    expect((await request()).status).toBe(503);
    expect(
      (
        await app.request(
          `${origin}${path}/health`,
          { headers: { Authorization: `Bearer ${secret}` } },
          env,
        )
      ).status,
    ).toBe(503);
    expect(await count('tasks')).toBe(0);
  });
});

describe('facility integration with real SQLite transactions', () => {
  it('checks configuration, constant-time bearer credentials, content type, lane and byte limits', async () => {
    const health = (headers = { Authorization: `Bearer ${secret}` }) =>
      app.request(`${origin}${path}/health`, { headers }, env);
    expect((await health()).status).toBe(200);
    delete env.PORTAL_DESIGN_INGEST_SECRET;
    expect((await health()).status).toBe(503);
    env.PORTAL_DESIGN_INGEST_SECRET = secret;
    expect((await health({ Authorization: `Bearer ${'x'.repeat(secret.length)}` })).status).toBe(
      401,
    );
    expect((await request(payload, { 'Content-Type': 'text/plain' })).status).toBe(400);
    expect((await request({ ...payload, environment: 'production' })).status).toBe(400);
    expect((await request({ ...payload, description: '😀'.repeat(40_000) })).status).toBe(400);
    const huge = {
      ...payload,
      description: '😀'.repeat(40_000),
    };
    for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': '200000' }] as Record<
      string,
      string
    >[]) {
      const response = await request(huge, headers);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'payload_too_large' });
    }
    expect(await count('tasks')).toBe(0);
  });
  it('fails readiness for disabled/missing identities, memberships or a public project', async () => {
    const health = () =>
      app.request(
        `${origin}${path}/health`,
        { headers: { Authorization: `Bearer ${secret}` } },
        env,
      );
    for (const sql of [
      "UPDATE users SET status='disabled' WHERE email = ?",
      'DELETE FROM workspace_members WHERE user_id = (SELECT id FROM users WHERE email = ?)',
      'DELETE FROM project_members WHERE user_id = (SELECT id FROM users WHERE email = ?)',
    ]) {
      db.raw.exec('SAVEPOINT readiness');
      await db.prepare(sql).bind(config?.assigneeEmail).run();
      expect((await health()).status).toBe(503);
      expect((await request()).status).toBe(503);
      db.raw.exec('ROLLBACK TO readiness; RELEASE readiness');
    }
    await db
      .prepare("UPDATE projects SET visibility='workspace' WHERE project_key = ?")
      .bind(config?.projectKey)
      .run();
    expect((await health()).status).toBe(503);
  });
  it('uses medium priority and a null due date when no deadline is provided', async () => {
    const { needed_by: _omitted, ...noDeadline } = payload;
    expect((await request({ ...noDeadline, urgency: 'Planning ahead' })).status).toBe(201);
    const row = await db
      .prepare('SELECT priority, due_date, source_metadata_json FROM tasks')
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({ priority: 'medium', due_date: null });
    expect(JSON.parse(String(row?.source_metadata_json)).portalFacilityRequest.requester).toEqual(
      payload.requester,
    );
    expect(
      (await request({ ...noDeadline, needed_by: '', urgency: 'Planning ahead' })).status,
    ).toBe(200);
  });
  it('fails closed on blank routing and does not fall back to a different project', async () => {
    env.PORTAL_FACILITY_PROJECT_KEY = '';
    const response = await app.request(
      `${origin}${path}/health`,
      { headers: { Authorization: `Bearer ${secret}` } },
      env,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('PORTAL_FACILITY_PROJECT_KEY');
    expect((await request()).status).toBe(503);
    expect(await count('tasks')).toBe(0);
    env.PORTAL_FACILITY_PROJECT_KEY = 'MISSING';
    expect((await request()).status).toBe(503);
    delete env.PORTAL_FACILITY_PROJECT_KEY;
    env.PORTAL_FACILITY_ASSIGNEE_EMAIL = 'missing@example.org';
    expect((await request()).status).toBe(503);
    env.PORTAL_FACILITY_ASSIGNEE_EMAIL = config.assigneeEmail.toUpperCase();
    expect((await request()).status).toBe(201);
  });
  it('creates once atomically, replays reordered JSON, retains human edits, and conflicts on changed payload', async () => {
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const data = (await responses[0].json()) as {
      task: { key: string; reference: string; url: string };
    };
    expect(data.task.url).toBe(`${origin}/r/portal-facility-request/${id}`);
    expect(data.task.reference).toMatch(/^T-\d+$/);
    const row = await db
      .prepare('SELECT * FROM tasks WHERE task_key = ?')
      .bind(data.task.key)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      status: 'not_started',
      priority: 'high',
      due_date: payload.needed_by,
      source_system: 'portal-facility-request',
      source_id: id,
    });
    expect(row?.sort_key).toContain(payload.needed_by);
    expect(await count('tasks')).toBe(1);
    expect(await count('task_events')).toBe(1);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) n FROM audit_events WHERE action='task.created'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    await db
      .prepare("UPDATE tasks SET title='Human edit', status='done' WHERE task_key = ?")
      .bind(data.task.key)
      .run();
    const reordered = {
      ...payload,
      requester: { email: payload.requester.email, name: payload.requester.name },
    };
    expect((await request(reordered)).status).toBe(200);
    expect((await request({ ...payload, description: 'changed' })).status).toBe(409);
    expect((await db.prepare('SELECT title FROM tasks').first())?.title).toBe('Human edit');
  });
  it('rolls back task and event if the audit write fails, then retries cleanly', async () => {
    db.raw.exec(
      "CREATE TRIGGER fail_facility_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'task.created' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    expect((await request()).status).toBe(503);
    expect(await count('tasks')).toBe(0);
    expect(await count('task_events')).toBe(0);
    db.raw.exec('DROP TRIGGER fail_facility_audit');
    expect((await request()).status).toBe(201);
  });
  it('redirects through sign-in with returnTo; private denial and malformed ID share a generic page', async () => {
    const url = `${origin}/r/portal-facility-request/${id}`;
    const anonymous = await app.request(url, {}, env);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('Location')).toBe(
      `/auth/login?returnTo=${encodeURIComponent(`/r/portal-facility-request/${id}`)}`,
    );
    const login = await app.request(`${origin}${anonymous.headers.get('Location')}`, {}, env);
    const oauthCookie = login.headers
      .get('set-cookie')
      ?.match(new RegExp(`${OAUTH_COOKIE}=([^;]+)`))?.[1];
    expect(oauthCookie).toBeTruthy();
    expect((await verifyOAuthState(env, oauthCookie ?? '')).returnTo).toBe(
      `/r/portal-facility-request/${id}`,
    );
    const memberCookie = await cookie(config?.assigneeEmail ?? 'designer@example.org');
    const pending = await app.request(url, { headers: { Cookie: memberCookie } }, env);
    expect(pending.status).toBe(200);
    expect(pending.headers.get('Cache-Control')).toBe('no-store');
    expect(await pending.text()).toContain('still being added');
    const outsiderCookie = await cookie('outsider@example.org');
    const denied = await app.request(url, { headers: { Cookie: outsiderCookie } }, env);
    const malformed = await app.request(
      `${origin}/r/portal-facility-request/not-a-uuid`,
      { headers: { Cookie: memberCookie } },
      env,
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await malformed.text());
    expect((await request()).status).toBe(201);
    const found = await app.request(url, { headers: { Cookie: memberCookie } }, env);
    expect(found.status).toBe(302);
    expect(found.headers.get('Location')).toBe(`/tasks/FACILITY-${id}`);
    expect((await app.request(url, { headers: { Cookie: outsiderCookie } }, env)).status).toBe(404);
  });
});

describe('declarative project provisioning APIs', () => {
  async function adminRequest(path: string, body: unknown, method = 'POST', manager = true) {
    env.TASKS_HOSTED_DOMAIN = 'example.org';
    const admin = await user('admin@example.org');
    if (manager)
      await db
        .prepare(
          "INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'platform.admin')",
        )
        .bind(admin.id)
        .run();
    const csrf = 'c'.repeat(43);
    return app.request(
      `${origin}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Origin: origin,
          Cookie: `${await cookie(admin.email)}; ${tenantProfile.security.cookiePrefix}_csrf=${csrf}`,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify(body),
      },
      env,
    );
  }
  it('accepts an explicit unique key, preserves generated keys, and rejects malformed keys and non-managers', async () => {
    expect(
      (
        await adminRequest(
          '/api/projects',
          { key: 'STABLE', name: 'Stable', visibility: 'private' },
          'POST',
          false,
        )
      ).status,
    ).toBe(403);
    for (const key of ['', 'lower', 'A/B', 42, 'X'.repeat(41)]) {
      expect((await adminRequest('/api/projects', { key, name: 'Stable' })).status).toBe(400);
    }
    const admin = await user('admin@example.org');
    const capabilities = await app.request(
      `${origin}/api/projects`,
      { headers: { Cookie: await cookie(admin.email) } },
      env,
    );
    expect(await capabilities.json()).toMatchObject({
      capabilities: { explicitKeys: true, configuredAgentMembership: true },
    });
    const first = await adminRequest('/api/projects', {
      key: 'STABLE',
      name: 'Stable',
      visibility: 'private',
    });
    expect(first.status).toBe(201);
    expect(((await first.json()) as { project: { key: string } }).project.key).toBe('STABLE');
    const before = await count('audit_events');
    expect((await adminRequest('/api/projects', { key: 'STABLE', name: 'Different' })).status).toBe(
      409,
    );
    expect(await count('audit_events')).toBe(before);
    const generated = await adminRequest('/api/projects', { name: 'Generated Project' });
    expect(generated.status).toBe(201);
    expect(((await generated.json()) as { project: { key: string } }).project.key).toMatch(
      /^GP-[A-F0-9]{4}$/,
    );
  });
  it('admits only the active configured agent outside the hosted domain and retains its identity', async () => {
    const path = `/api/projects/${config.projectKey}/members`;
    expect(
      (await adminRequest(path, { email: config.actorEmail, role: 'editor' }, 'PUT', false)).status,
    ).toBe(403);
    const before = await db
      .prepare('SELECT id, principal_type, google_subject FROM users WHERE email = ?')
      .bind(config.actorEmail)
      .first();
    expect(
      (await adminRequest(path, { email: config.actorEmail, role: 'editor' }, 'PUT')).status,
    ).toBe(200);
    expect(
      await db
        .prepare('SELECT id, principal_type, google_subject FROM users WHERE email = ?')
        .bind(config.actorEmail)
        .first(),
    ).toEqual(before);
    expect(
      (await adminRequest(path, { email: 'foreign@external.invalid', role: 'editor' }, 'PUT'))
        .status,
    ).toBe(400);
    await db
      .prepare("UPDATE users SET status='disabled' WHERE email = ?")
      .bind(config.actorEmail)
      .run();
    expect(
      (await adminRequest(path, { email: config.actorEmail, role: 'editor' }, 'PUT')).status,
    ).toBe(400);
    await db
      .prepare("UPDATE users SET status='active', principal_type='human' WHERE email = ?")
      .bind(config.actorEmail)
      .run();
    expect(
      (await adminRequest(path, { email: config.actorEmail, role: 'editor' }, 'PUT')).status,
    ).toBe(400);
  });
});
