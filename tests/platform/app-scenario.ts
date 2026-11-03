import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { app } from '../../src/app';
import { signSession } from '../../src/auth/session';
import type { Env } from '../../src/env';
import type { SqlDatabase } from '../../src/platform/ports';

const legacy = tenantProfile.tasks.apiMode === 'legacy';
const ORIGIN = 'http://tasks.invalid';
const CSRF = 'c'.repeat(43);
const PORTAL_SECRET = 'p'.repeat(40);

export interface AppBackend {
  db: SqlDatabase;
  dispose(): Promise<void>;
}

/**
 * Runs the real Hono application (the same `app.fetch` the Worker and the container use) on a
 * given SQL backend. Regression coverage for the callers whose `meta.changes` checks used to
 * assume a direct row count: the optimistic-concurrency PATCH and the portal-support ingest.
 */
export function describeAppScenario(label: string, open: () => Promise<AppBackend>) {
  describe.skipIf(!legacy)(`application on ${label}`, () => {
    let backend: AppBackend;
    let env: Env;
    let cookie = '';
    const headers = (extra: Record<string, string> = {}) => ({
      'Content-Type': 'application/json',
      Cookie: cookie,
      Origin: ORIGIN,
      'X-CSRF-Token': CSRF,
      ...extra,
    });
    const call = (path: string, init: RequestInit = {}) =>
      app.request(`${ORIGIN}${path}`, init, env);

    beforeAll(async () => {
      backend = await open();
      env = {
        DB: backend.db,
        ASSETS: { fetch: async () => new Response('asset') },
        ENVIRONMENT: 'local',
        RELEASE_SHA: 'scenario',
        SESSION_SECRET: 'scenario-session-secret-0123456789abcdef0123456789',
        PORTAL_SUPPORT_INGEST_SECRET: PORTAL_SECRET,
      } as unknown as Env;
      const email = tenantProfile.identity.initialAdminEmail || 'admin@example.org';
      await env.DB.prepare('INSERT INTO users (email, first_name) VALUES (?, ?)')
        .bind(email, 'Admin')
        .run();
      const user = await env.DB.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
        .bind(email)
        .first<{ id: number }>();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'platform.admin')",
      )
        .bind(user?.id)
        .run();
      await env.DB.prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role) SELECT id, ?, 'owner' FROM workspaces",
      )
        .bind(user?.id)
        .run();
      const keys = (
        await env.DB.prepare('SELECT key FROM permissions ORDER BY key').all<{ key: string }>()
      ).results.map((row) => row.key);
      const token = await signSession(env, { id: Number(user?.id), email }, keys);
      const prefix = tenantProfile.security.cookiePrefix;
      cookie = `${prefix}_session=${token}; ${prefix}_csrf=${CSRF}`;
    }, 120_000);
    afterAll(async () => {
      await backend?.dispose();
    });

    it('commits a task PATCH instead of reporting a version conflict', async () => {
      const created = await call('/api/tasks', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          title: 'Concurrency regression',
          description: '',
          status: 'not_started',
          priority: null,
          effort: null,
          assigneeEmail: null,
          dueDate: null,
          projectKey: tenantProfile.defaultProjectKey,
          taskTypes: [],
        }),
      });
      expect(created.status).toBe(201);
      const { task } = (await created.json()) as { task: { key: string } };

      const patched = await call(`/api/tasks/${task.key}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ title: 'Concurrency regression (edited)' }),
      });
      expect(patched.status).toBe(200);
      const detail = (await patched.json()) as { task: { title: string; version?: number } };
      expect(detail.task.title).toBe('Concurrency regression (edited)');

      const stored = await env.DB.prepare('SELECT title, version FROM tasks WHERE task_key = ?')
        .bind(task.key)
        .first<{ title: string; version: number }>();
      expect(stored).toEqual({ title: 'Concurrency regression (edited)', version: 2 });
      const events = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM task_events WHERE action = 'updated' AND task_id = (SELECT id FROM tasks WHERE task_key = ?)",
      )
        .bind(task.key)
        .first<{ n: number }>();
      expect(events?.n).toBe(1);

      const stale = await call(`/api/tasks/${task.key}`, {
        method: 'PATCH',
        headers: headers({ 'If-Match': '"1"' }),
        body: JSON.stringify({ title: 'stale write' }),
      });
      expect(stale.status).toBe(409);
      const unchanged = await env.DB.prepare('SELECT title FROM tasks WHERE task_key = ?')
        .bind(task.key)
        .first<{ title: string }>();
      expect(unchanged?.title).toBe('Concurrency regression (edited)');

      const comment = await call(`/api/tasks/${task.key}/comments`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ body: 'a comment', mutationKey: `scenario-${task.key}` }),
      });
      expect([200, 201]).toContain(comment.status);
    });

    it.runIf(tenantProfile.capabilities.portalSupport)(
      'records a new portal support ticket once, with history and audit',
      async () => {
        const ticket = {
          ticket_id: 424242,
          subject: 'Projector will not start',
          description: 'Conference room projector',
          requester_email: 'requester@example.test',
          ticket_url: 'https://portal.example.org/support/424242',
        };
        const post = () =>
          call('/api/integrations/portal/support-tickets', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${PORTAL_SECRET}`,
            },
            body: JSON.stringify(ticket),
          });
        const first = await post();
        const firstBody = (await first.json()) as { created: boolean; task: { key: string } };
        expect(first.status).toBe(201);
        expect(firstBody.created).toBe(true);

        const count = async (sql: string) =>
          (await env.DB.prepare(sql).bind(firstBody.task.key).first<{ n: number }>())?.n;
        expect(
          await count(
            "SELECT COUNT(*) AS n FROM task_events WHERE action = 'created' AND task_id = (SELECT id FROM tasks WHERE task_key = ?)",
          ),
        ).toBe(1);
        expect(
          await count(
            "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'task.created' AND entity_key = ?",
          ),
        ).toBe(1);

        const replay = await post();
        const replayBody = (await replay.json()) as { created: boolean; task: { key: string } };
        expect(replay.status).toBe(200);
        expect(replayBody.created).toBe(false);
        expect(replayBody.task.key).toBe(firstBody.task.key);
        expect(
          await count(
            "SELECT COUNT(*) AS n FROM task_events WHERE action = 'created' AND task_id = (SELECT id FROM tasks WHERE task_key = ?)",
          ),
        ).toBe(1);
      },
    );
  });
}
