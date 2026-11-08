/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import { app } from '../../src/app';
import { admitGoogleSignIn } from '../../src/auth/provision';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  signSession,
  verifyOAuthState,
} from '../../src/auth/session';
import type { Env } from '../../src/env';
import {
  formatPortalDesignRequest,
  type PortalDesignRequest,
  portalDesignRequestSchema,
} from '../../src/integrations/portal-design';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import { readMigrations, runMigrations } from '../../src/platform/sqlite/migrate';
import { effectiveMigrationsDirectory } from '../support/migrations';
import { testOrigins } from '../support/origins';

const secret = 'synthetic-design-secret-for-local-tests-only';
const path = '/api/integrations/portal/design-requests';
const id = '56f5df3b-10f1-4ecd-b7a8-2e9f79828451';
const config = tenantExtensions().integrations?.portalDesign;
const payload: PortalDesignRequest = {
  version: 1,
  environment: 'dev',
  submission_id: id,
  submitted_at: '2026-01-02T03:04:05.123Z',
  requester: { name: 'María Pérez', email: 'maria@example.org' },
  locale: 'es',
  campus: Object.keys(config?.campusLabels ?? {})[1] ?? '',
  design_assets: ['Service Slide', 'Reprint'],
  reprint_details: '  Cincuenta copias\npor favor.  ',
  design_details: '¡Bienvenidos!\nTexto original.',
  specific_elements: '',
  needed_by: '2026-01-01',
  reference_files: [{ name: 'diseño.pdf', type: 'application/pdf', size: 100 }],
};
let db: SqliteDatabase;
let env: Env;
const enabled = Boolean(config);
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
  if (!config) return;
  const actor = await user(config.actorEmail, 'agent');
  const designer = await user(config.assigneeEmail);
  await db
    .prepare(
      "INSERT INTO projects (project_key, name, workspace_id, visibility) SELECT ?, 'Design', id, 'private' FROM workspaces WHERE workspace_key = ?",
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
afterEach(() => db.close());

describe('design payload and formatter', () => {
  it('preserves Spanish, overdue dates, file names, and full overflow text', () => {
    const formatted = formatPortalDesignRequest(payload);
    expect(formatted.title).toBe(
      `Design request: María Pérez — ${config?.campusLabels?.[payload.campus] ?? 'No campus'} — due 2026-01-01`,
    );
    expect(formatted.description).toContain(payload.reprint_details);
    expect(formatted.description).toContain('Spanish (es)');
    expect(formatted.description).toContain('diseño.pdf');
    const large = {
      ...payload,
      design_details: 'á'.repeat(20_000),
      specific_elements: 'z'.repeat(20_000),
      reprint_details: 'r'.repeat(20_000),
    };
    const result = formatPortalDesignRequest(large);
    expect(result.description.length).toBeLessThanOrEqual(10_000);
    expect(result.sourceContent.plainText).toContain(large.design_details);
    expect(result.sourceContent.plainText).toContain(large.specific_elements);
    expect(result.sourceContent.plainText).toContain(large.reprint_details);
    expect(
      formatPortalDesignRequest({
        ...payload,
        requester: { ...payload.requester, name: 'x'.repeat(320) },
      }).title.length,
    ).toBeLessThanOrEqual(240);
  });
  it('rejects malformed dates, uppercase UUIDs, unknown fields, duplicate assets and unsafe file metadata', () => {
    for (const patch of [
      { version: 2 },
      { needed_by: '2026-02-30' },
      { submitted_at: '2026-01-01T01:00:00+01:00' },
      { submission_id: id.toUpperCase() },
      { unknown: true },
      { requester: { ...payload.requester, actor: 'x' } },
      { design_assets: ['Service Slide', 'Service Slide'] },
      { design_assets: ['Unknown'] },
      { reference_files: [{ name: 'a', type: 'text/html', size: 10 }] },
      { reference_files: [{ ...payload.reference_files[0], url: 'https://example.org' }] },
      { reference_files: [{ name: '../a.pdf', type: 'application/pdf', size: -1 }] },
    ])
      expect(
        portalDesignRequestSchema.safeParse({ ...payload, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
  });
});

describe.runIf(!enabled)('design integration default off', () => {
  it('returns 503 without a profile, even with a secret', async () => {
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

describe.runIf(enabled)('design integration with real SQLite transactions', () => {
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
    expect((await request({ ...payload, design_details: '😀'.repeat(40_000) })).status).toBe(400);
    const huge = {
      ...payload,
      design_details: '😀'.repeat(20_000),
      specific_elements: '😀'.repeat(20_000),
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
  it('creates once atomically, replays reordered JSON, retains human edits, and conflicts on changed payload', async () => {
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201]);
    const data = (await responses[0].json()) as {
      task: { key: string; reference: string; url: string };
    };
    expect(data.task.url).toBe(`${origin}/r/portal-design-request/${id}`);
    expect(data.task.reference).toMatch(/^T-\d+$/);
    const row = await db
      .prepare('SELECT * FROM tasks WHERE task_key = ?')
      .bind(data.task.key)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      status: 'not_started',
      priority: 'medium',
      due_date: payload.needed_by,
      source_system: 'portal-design-request',
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
    expect((await request({ ...payload, design_details: 'changed' })).status).toBe(409);
    expect((await db.prepare('SELECT title FROM tasks').first())?.title).toBe('Human edit');
  });
  it('rolls back task and event if the audit write fails, then retries cleanly', async () => {
    db.raw.exec(
      "CREATE TRIGGER fail_design_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'task.created' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    expect((await request()).status).toBe(503);
    expect(await count('tasks')).toBe(0);
    expect(await count('task_events')).toBe(0);
    db.raw.exec('DROP TRIGGER fail_design_audit');
    expect((await request()).status).toBe(201);
  });
  it('attaches a later Google sign-in to the pre-created designer without changing its identity', async () => {
    const before = await db
      .prepare('SELECT id, google_subject FROM users WHERE email = ?')
      .bind(config?.assigneeEmail)
      .first<{ id: number; google_subject: string | null }>();
    expect(before?.google_subject).toBeNull();
    const after = await admitGoogleSignIn(env, {
      email: config?.assigneeEmail ?? '',
      firstName: 'Design',
      lastName: 'User',
      photoUrl: null,
      subject: 'synthetic-google-subject',
    });
    expect(after.id).toBe(before?.id);
  });
  it('redirects through sign-in with returnTo; private denial and malformed ID share a generic page', async () => {
    const url = `${origin}/r/portal-design-request/${id}`;
    const anonymous = await app.request(url, {}, env);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get('Location')).toBe(
      `/auth/login?returnTo=${encodeURIComponent(`/r/portal-design-request/${id}`)}`,
    );
    const login = await app.request(`${origin}${anonymous.headers.get('Location')}`, {}, env);
    const oauthCookie = login.headers
      .get('set-cookie')
      ?.match(new RegExp(`${OAUTH_COOKIE}=([^;]+)`))?.[1];
    expect(oauthCookie).toBeTruthy();
    expect((await verifyOAuthState(env, oauthCookie ?? '')).returnTo).toBe(
      `/r/portal-design-request/${id}`,
    );
    const memberCookie = await cookie(config?.assigneeEmail ?? 'designer@example.org');
    const pending = await app.request(url, { headers: { Cookie: memberCookie } }, env);
    expect(pending.status).toBe(200);
    expect(pending.headers.get('Cache-Control')).toBe('no-store');
    expect(await pending.text()).toContain('still being added');
    const outsiderCookie = await cookie('outsider@example.org');
    const denied = await app.request(url, { headers: { Cookie: outsiderCookie } }, env);
    const malformed = await app.request(
      `${origin}/r/portal-design-request/not-a-uuid`,
      { headers: { Cookie: memberCookie } },
      env,
    );
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await malformed.text());
    expect((await request()).status).toBe(201);
    const found = await app.request(url, { headers: { Cookie: memberCookie } }, env);
    expect(found.status).toBe(302);
    expect(found.headers.get('Location')).toBe(`/tasks/DESIGN-${id}`);
    expect((await app.request(url, { headers: { Cookie: outsiderCookie } }, env)).status).toBe(404);
  });
});
