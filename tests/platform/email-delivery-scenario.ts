import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { updateAccountPreferences } from '../../src/account/api';
import { registerAccountEmailRoutes } from '../../src/account/email';
import { registerAdminEmailRoutes } from '../../src/admin/email-settings';
import { app as application } from '../../src/app';
import type { TaskAppEnv } from '../../src/app-env';
import { CSRF_COOKIE } from '../../src/auth/cookies';
import { SESSION_COOKIE, signSession } from '../../src/auth/session';
import type { Env } from '../../src/env';
import { sendDeadlineNotifications } from '../../src/notifications/deadlines';
import {
  aggregateDigest,
  claimEmailSend,
  defaultEmailDeliveryPreferences,
  digestDueAt,
  emailDeliveryPreferenceStatements,
  readEmailDeliveryPreferences,
  reserveEmailQuota,
} from '../../src/notifications/delivery';
import { prepareDigestDetails, sendEmailDigests } from '../../src/notifications/digests';
import {
  prepareScheduledEmail,
  sendUserNotification,
  type UserNotification,
} from '../../src/notifications/email';
import type { SqlDatabase, SqlStatement } from '../../src/platform/ports';

function afterStatementRun(
  statement: SqlStatement,
  after: () => void | Promise<void>,
): SqlStatement {
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'bind')
        return (...args: unknown[]) => afterStatementRun(target.bind(...args), after);
      if (property === 'run')
        return async () => {
          const result = await target.run();
          await after();
          return result;
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function describeEmailDelivery(
  label: string,
  open: () => Promise<{ db: SqlDatabase; dispose(): Promise<void> }>,
) {
  describe(`email delivery on ${label}`, { timeout: 30_000 }, () => {
    let backend: Awaited<ReturnType<typeof open>>;
    let env: Env;
    let userId: number;
    let otherId: number;
    let projectId: number;
    const gateway = vi.fn(async (_input?: unknown, _init?: RequestInit) =>
      Response.json({ ok: true }),
    );
    const run = (sql: string, ...args: unknown[]) =>
      env.DB.prepare(sql)
        .bind(...args)
        .run();
    const count = async (table: string) =>
      (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n;
    const notification = (key = 'notice-1', target = 'EMAIL-1'): UserNotification => ({
      userId,
      kind: 'assignment',
      entityType: 'task',
      entityKey: target,
      dedupeKey: key,
      subject: 'Synthetic assignment',
      heading: 'Synthetic heading',
      message: 'Synthetic message',
      url: 'https://tasks.example.org/',
    });
    const preferences = (extra = {}) => ({ ...defaultEmailDeliveryPreferences, ...extra });
    const save = (extra = {}) =>
      env.DB.batch(emailDeliveryPreferenceStatements(env, userId, preferences(extra)));
    async function dueBuckets(age = 1) {
      const buckets = await env.DB.prepare(
        'SELECT user_id, frequency, due_at FROM email_digest_buckets',
      ).all<{ user_id: number; frequency: string; due_at: number }>();
      for (const row of buckets.results) {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO email_digest_buckets (user_id, frequency, due_at) VALUES (?, ?, unixepoch() - ?)`,
          ).bind(row.user_id, row.frequency, age),
          env.DB.prepare(
            'UPDATE email_digest_items SET due_at = unixepoch() - ? WHERE user_id = ? AND frequency = ? AND due_at = ?',
          ).bind(age, row.user_id, row.frequency, row.due_at),
          env.DB.prepare(
            'DELETE FROM email_digest_buckets WHERE user_id = ? AND frequency = ? AND due_at = ?',
          ).bind(row.user_id, row.frequency, row.due_at),
        ]);
      }
    }
    async function seedScheduledRecipients(prefix: string, frequency: 'hourly' | 'immediate') {
      const ids: number[] = [];
      for (let i = 0; i < 8; i++) {
        const row = await env.DB.prepare('INSERT INTO users (email) VALUES (?) RETURNING id')
          .bind(`${prefix}-${i}@example.org`)
          .first<{ id: number }>();
        const id = Number(row?.id);
        ids.push(id);
        await run(
          "INSERT INTO workspace_members (workspace_id,user_id,role) SELECT id,?,'member' FROM workspaces",
          id,
        );
        await run(
          "INSERT INTO project_members (project_id,user_id,role) VALUES (?,?,'viewer')",
          projectId,
          id,
        );
        await run(
          "INSERT INTO user_permissions (user_id,permission_key) VALUES (?,'tasks.view')",
          id,
        );
        await env.DB.batch(
          emailDeliveryPreferenceStatements(env, id, preferences({ assignments: frequency })),
        );
        if (frequency === 'hourly') {
          await run(
            "INSERT INTO email_digest_buckets (user_id,frequency,due_at) VALUES (?,'hourly',unixepoch()-1)",
            id,
          );
          await run(
            "INSERT INTO email_digest_items (user_id,frequency,due_at,kind,entity_type,entity_key) SELECT user_id,frequency,due_at,'assignment','task','EMAIL-1' FROM email_digest_buckets WHERE user_id=?",
            id,
          );
        } else {
          await run(
            "INSERT INTO tasks (task_key,seq,title,created_by_user_id,assignee_user_id,sort_key,project_id,due_date) VALUES (?,?,?,?,?,'a0',?,?)",
            `${prefix}-${i}`,
            100000 + id,
            `Scheduled task ${i}`,
            id,
            id,
            projectId,
            new Date().toISOString().slice(0, 10),
          );
        }
      }
      return ids;
    }
    beforeAll(async () => {
      backend = await open();
      env = {
        DB: backend.db,
        ENVIRONMENT: 'production',
        TASKS_PUBLIC_ORIGIN: 'https://tasks.example.org',
        EMAIL_API_ENDPOINT: tenantProfile.integrations.emailGateway.productionOrigin,
        EMAIL_API_CLIENT_ID: tenantProfile.integrations.emailGateway.clientId,
        EMAIL_FROM: tenantProfile.integrations.emailGateway.fromEmail,
        EMAIL_API_SECRET: 'synthetic-only-secret-'.repeat(3),
      } as Env;
      userId = Number(
        (
          await env.DB.prepare(
            "INSERT INTO users (email) VALUES ('email-user@example.org') RETURNING id",
          ).first<{ id: number }>()
        )?.id,
      );
      otherId = Number(
        (
          await env.DB.prepare(
            "INSERT INTO users (email) VALUES ('email-other@example.org') RETURNING id",
          ).first<{ id: number }>()
        )?.id,
      );
      projectId = Number(
        (
          await env.DB.prepare(
            "INSERT INTO projects (workspace_id, project_key, name, visibility) SELECT id, 'EMAIL-TEST', 'Synthetic project', 'private' FROM workspaces LIMIT 1 RETURNING id",
          ).first<{ id: number }>()
        )?.id,
      );
      for (let i = 1; i <= 30; i++) {
        await run(
          'INSERT INTO tasks (task_key, seq, title, created_by_user_id, assignee_user_id, sort_key, project_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          `EMAIL-${i}`,
          90000 + i,
          `Synthetic task ${i}`,
          userId,
          userId,
          `a${i}`,
          projectId,
        );
      }
    }, 120_000);
    afterAll(async () => {
      await backend?.dispose();
      vi.unstubAllGlobals();
    });
    beforeEach(async () => {
      vi.stubGlobal('fetch', gateway);
      gateway.mockClear();
      gateway.mockImplementation(async () => Response.json({ ok: true }));
      await env.DB.batch([
        env.DB.prepare('DELETE FROM email_digest_buckets'),
        env.DB.prepare('DELETE FROM email_send_attempts'),
        env.DB.prepare('DELETE FROM email_dispatch_runs'),
        env.DB.prepare('DELETE FROM notification_deliveries'),
        env.DB.prepare('DELETE FROM email_delivery_preferences'),
        env.DB.prepare('DELETE FROM user_notification_preferences'),
        env.DB.prepare('UPDATE email_delivery_settings SET per_minute = 5'),
        env.DB.prepare("UPDATE users SET status = 'active' WHERE id IN (?, ?)").bind(
          userId,
          otherId,
        ),
        env.DB.prepare(
          "INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) SELECT id, ?, 'member' FROM workspaces",
        ).bind(userId),
        env.DB.prepare(
          "INSERT OR IGNORE INTO project_members (project_id, user_id, role) VALUES (?, ?, 'viewer')",
        ).bind(projectId, userId),
        env.DB.prepare(
          "INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, 'tasks.view')",
        ).bind(userId),
        env.DB.prepare(
          "DELETE FROM user_permissions WHERE user_id = ? AND permission_key <> 'tasks.view'",
        ).bind(userId),
      ]);
    });

    it('registers email routes behind the real application authentication and CSRF boundary', async () => {
      const origin = 'https://tasks.example.org';
      const csrf = 'synthetic-email-route-csrf-proof-123456789';
      const environment = {
        ...env,
        SESSION_SECRET: 'synthetic-email-route-session-secret-123456789',
        GOOGLE_CLIENT_ID: 'synthetic-client',
        GOOGLE_CLIENT_SECRET: 'synthetic-client-secret',
      };
      const token = await signSession(
        environment,
        { id: userId, email: 'email-user@example.org' },
        ['tasks.view'],
      );
      const cookie = `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${csrf}`;
      const request = (
        path: string,
        method = 'GET',
        headers: Record<string, string> = {},
        body?: unknown,
      ) =>
        application.request(
          `${origin}${path}`,
          {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
          environment,
        );
      expect((await request('/api/account/email-preferences')).status).toBe(401);
      expect(
        (await request('/api/account/email-preferences', 'GET', { Cookie: cookie })).status,
      ).toBe(tenantProfile.capabilities.emailNotifications ? 200 : 403);
      for (const path of ['/api/account/email-preferences', '/api/admin/email-settings']) {
        expect((await request(path, 'PATCH', { Cookie: cookie }, preferences())).status).toBe(403);
        expect(
          (
            await request(
              path,
              'PATCH',
              { Cookie: cookie, Origin: 'https://foreign.invalid', 'X-CSRF-Token': csrf },
              preferences(),
            )
          ).status,
        ).toBe(403);
      }
      const headers = { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf };
      expect(
        (await request('/api/admin/email-settings', 'PATCH', headers, { perMinute: 4 })).status,
      ).toBe(403);
      if (tenantProfile.capabilities.emailNotifications) {
        expect(
          (
            await request(
              '/api/account/email-preferences',
              'PATCH',
              headers,
              preferences({ hardLimit: 20, period: 'week' }),
            )
          ).status,
        ).toBe(200);
        await run(
          "INSERT INTO user_permissions (user_id, permission_key) VALUES (?, 'platform.admin')",
          userId,
        );
        expect(
          (await request('/api/admin/email-settings', 'PATCH', headers, { perMinute: 4 })).status,
        ).toBe(200);
      }
    });
    it('defaults to immediate categories and five per rolling day, and persists all policy choices', async () => {
      expect(await readEmailDeliveryPreferences(env, userId)).toEqual(
        defaultEmailDeliveryPreferences,
      );
      await save({
        hardLimit: 2,
        period: 'week',
        assignments: 'hourly',
        comments: 'daily',
        mentions: 'weekly',
        deadlines: 'off',
      });
      expect(await readEmailDeliveryPreferences(env, userId)).toEqual(
        preferences({
          hardLimit: 2,
          period: 'week',
          assignments: 'hourly',
          comments: 'daily',
          mentions: 'weekly',
          deadlines: 'off',
        }),
      );
      await run(
        'UPDATE user_notification_preferences SET comment_email = 0 WHERE user_id = ?',
        userId,
      );
      expect((await readEmailDeliveryPreferences(env, userId)).comments).toBe('off');
    });
    it('atomically caps concurrent reservations across users at five, without storing denials', async () => {
      const results = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          reserveEmailQuota(env, i % 2 ? userId : otherId, `parallel-${i}`),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(5);
      expect(await count('email_send_attempts')).toBe(5);
    });
    it('atomically rechecks the current cap and permits only one send claim per reservation', async () => {
      await run('UPDATE email_delivery_settings SET per_minute = 100');
      await save({ hardLimit: 100 });
      await Promise.all(
        Array.from({ length: 20 }, (_, i) => reserveEmailQuota(env, userId, `claim-${i}`)),
      );
      await run('UPDATE email_delivery_settings SET per_minute = 1');
      // Keep one fresh reservation so D1 contention cannot race its expiry; age is tested separately.
      await run(
        "UPDATE email_send_attempts SET reserved_at = unixepoch() - 61 WHERE dedupe_key <> 'claim-0'",
      );
      const results = await Promise.all(
        Array.from({ length: 20 }, () => claimEmailSend(env, 'claim-0')),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await claimEmailSend(env, 'claim-0')).toBe(false);
    });
    it('keeps the personal rolling week cap after the platform minute has reset, and supports disabling', async () => {
      await save({ hardLimit: 2, period: 'week' });
      expect(await reserveEmailQuota(env, userId, 'personal-1')).toBe(true);
      expect(await reserveEmailQuota(env, userId, 'personal-2')).toBe(true);
      await run('UPDATE email_send_attempts SET reserved_at = unixepoch() - 120');
      expect(await reserveEmailQuota(env, userId, 'personal-3')).toBe(false);
      expect(await reserveEmailQuota(env, otherId, 'other')).toBe(true);
      await save({ hardLimit: 0 });
      expect(await reserveEmailQuota(env, userId, 'disabled')).toBe(false);
      await run('UPDATE email_delivery_settings SET per_minute = 0');
      expect(await reserveEmailQuota(env, otherId, 'platform-disabled')).toBe(false);
    });
    it('enforces independent minute and personal limits across successive minutes', async () => {
      await save({ hardLimit: 7, period: 'week' });
      for (let i = 0; i < 5; i++)
        expect(await reserveEmailQuota(env, userId, `first-minute-${i}`)).toBe(true);
      expect(await reserveEmailQuota(env, userId, 'minute-denied')).toBe(false);
      await run('UPDATE email_send_attempts SET reserved_at = unixepoch() - 120');
      expect(await reserveEmailQuota(env, userId, 'next-minute-1')).toBe(true);
      expect(await reserveEmailQuota(env, userId, 'next-minute-2')).toBe(true);
      expect(await reserveEmailQuota(env, userId, 'personal-denied')).toBe(false);
    });
    it('bounds each interval to 25 references, deduplicates items, and clears references on a policy change', async () => {
      await save({ assignments: 'hourly' });
      await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          aggregateDigest(env, notification(`event-${i}`, `EMAIL-${i + 1}`), 'hourly'),
        ),
      );
      expect(await count('email_digest_items')).toBe(25);
      await aggregateDigest(env, notification('same-item'), 'hourly');
      expect(await count('email_digest_items')).toBe(25);
      await save({ assignments: 'daily' });
      expect(await count('email_digest_items')).toBe(0);
      expect(
        new Date(
          digestDueAt('weekly', Date.parse('2026-11-05T12:00:00Z') / 1000) * 1000,
        ).toISOString(),
      ).toBe('2026-11-09T00:00:00.000Z');
    });
    it('rechecks private project access and current category choices before including digest titles', async () => {
      await save({ assignments: 'daily', comments: 'off' });
      const items = [
        { kind: 'assignment' as const, entity_type: 'task' as const, entity_key: 'EMAIL-1' },
        { kind: 'comment' as const, entity_type: 'task' as const, entity_key: 'EMAIL-2' },
      ];
      expect((await prepareDigestDetails(env, userId, 'daily', items)).details).toHaveLength(1);
      await run(
        'DELETE FROM project_members WHERE project_id = ? AND user_id = ?',
        projectId,
        userId,
      );
      expect((await prepareDigestDetails(env, userId, 'daily', items)).details).toHaveLength(0);
    });
    it('requires authentication and fresh platform administrator permission for admin settings', async () => {
      const app = new Hono<TaskAppEnv>();
      app.use('*', async (c, next) => {
        if (c.req.header('X-Synthetic-Identity') === 'yes')
          c.set('taskIdentity', {
            user: { id: userId, email: 'email-user@example.org', status: 'active' },
            auditUserId: userId,
            session: {
              sub: String(userId),
              email: 'email-user@example.org',
              perms: ['platform.admin'],
              exp: 9999999999,
            },
          });
        await next();
      });
      app.patch('/api/account/preferences', updateAccountPreferences);
      registerAccountEmailRoutes(app);
      registerAdminEmailRoutes(app);
      const request = (path: string, method = 'GET', body?: unknown, authenticated = true) =>
        app.request(
          `http://tasks.invalid${path}`,
          {
            method,
            headers: {
              'Content-Type': 'application/json',
              ...(authenticated ? { 'X-Synthetic-Identity': 'yes' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          },
          env,
        );
      expect(
        (await request('/api/account/email-preferences', 'GET', undefined, false)).status,
      ).toBe(401);
      expect((await request('/api/admin/email-settings')).status).toBe(403);
      await run(
        "INSERT INTO user_permissions (user_id, permission_key) VALUES (?, 'platform.admin')",
        userId,
      );
      if (!tenantProfile.capabilities.emailNotifications) {
        expect((await request('/api/admin/email-settings')).status).toBe(403);
        expect((await request('/api/account/email-preferences')).status).toBe(403);
        return;
      }
      expect((await request('/api/admin/email-settings', 'PATCH', { perMinute: 3 })).status).toBe(
        200,
      );
      expect(
        (await request('/api/admin/email-settings', 'PATCH', { perMinute: 1001 })).status,
      ).toBe(400);
      expect(
        (await request('/api/account/email-preferences', 'PATCH', preferences({ hardLimit: 1001 })))
          .status,
      ).toBe(400);
      expect(
        (
          await request(
            '/api/account/email-preferences',
            'PATCH',
            preferences({ hardLimit: 20, assignments: 'weekly' }),
          )
        ).status,
      ).toBe(200);
      expect((await readEmailDeliveryPreferences(env, userId)).assignments).toBe('weekly');
      expect(
        (
          await request('/api/account/preferences', 'PATCH', {
            taskCreationMode: 'quick',
            emailDelivery: preferences({ hardLimit: 1, assignments: 'hourly' }),
            notificationEmails: {
              assignments: true,
              comments: true,
              mentions: true,
              deadlines: true,
            },
          })
        ).status,
      ).toBe(200);
      expect((await readEmailDeliveryPreferences(env, userId)).assignments).toBe('hourly');
      expect((await readEmailDeliveryPreferences(env, userId)).hardLimit).toBe(1);
      expect(
        await env.DB.prepare('SELECT task_creation_mode FROM user_preferences WHERE user_id = ?')
          .bind(userId)
          .first(),
      ).toEqual({ task_creation_mode: 'quick' });

      const audit = await env.DB.prepare(
        "SELECT changes_json FROM audit_events WHERE action = 'platform.email_settings_updated' ORDER BY id DESC LIMIT 1",
      ).first<{ changes_json: string }>();
      expect(JSON.parse(audit?.changes_json ?? '{}')).toEqual({ after: { perMinute: 3 } });
      await run(
        "DELETE FROM user_permissions WHERE user_id = ? AND permission_key <> 'tasks.view'",
        userId,
      );
      expect((await request('/api/admin/email-settings')).status).toBe(403);
    });

    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'terminally suppresses excess immediate mail even after quota becomes available',
      async () => {
        const results = await Promise.all(
          Array.from({ length: 16 }, (_, i) =>
            sendUserNotification(env, notification(`immediate-${i}`)),
          ),
        );
        expect(results.filter((r) => r.status === 'accepted')).toHaveLength(5);
        expect(results.filter((r) => r.status === 'suppressed')).toHaveLength(11);
        expect(gateway).toHaveBeenCalledTimes(5);
        await run('DELETE FROM email_send_attempts');
        const suppressed = results.findIndex((r) => r.status === 'suppressed');
        expect(
          (await sendUserNotification(env, notification(`immediate-${suppressed}`))).status,
        ).toBe('duplicate');
        expect(gateway).toHaveBeenCalledTimes(5);
        expect(await count('email_digest_items')).toBe(0);
        expect(await count('notification_outbox')).toBe(0);
      },
    );
    for (const mode of ['immediate', 'scheduled'] as const) {
      for (const phase of ['reservation', 'send claim'] as const) {
        it.runIf(tenantProfile.capabilities.emailNotifications)(
          `suppresses a delayed ${mode} ${phase} after a fresh message uses cap=1`,
          async () => {
            await run('UPDATE email_delivery_settings SET per_minute = 1');
            await save({ hardLimit: 100 });
            let unblock = () => {};
            let announce = () => {};
            const held = new Promise<void>((resolve) => {
              unblock = resolve;
            });
            const committed = new Promise<void>((resolve) => {
              announce = resolve;
            });
            let paused = false;
            let monotonic = 0;
            const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
            const delayedEnv = {
              ...env,
              DB: {
                prepare(sql: string) {
                  const statement = env.DB.prepare(sql);
                  const match =
                    phase === 'reservation'
                      ? sql.startsWith('INSERT OR IGNORE INTO email_send_attempts')
                      : sql.startsWith('UPDATE email_send_attempts');
                  return match
                    ? afterStatementRun(statement, async () => {
                        if (!paused) {
                          paused = true;
                          announce();
                          await held;
                        }
                      })
                    : statement;
                },
                batch: env.DB.batch.bind(env.DB),
              },
            };
            const send = async () => {
              if (mode === 'immediate')
                return sendUserNotification(delayedEnv, notification('stalled'));
              const prepared = await prepareScheduledEmail(
                delayedEnv,
                notification('stalled'),
                'hourly',
                Math.floor(Date.now() / 1000),
              );
              return prepared?.();
            };
            const pending = send();
            try {
              await committed;
              // Reproduce the reviewer's post-commit response stall on the real database.
              await run(
                "UPDATE email_send_attempts SET reserved_at = unixepoch() - 61 WHERE dedupe_key = 'stalled'",
              );
              monotonic += 61_000;
              expect((await sendUserNotification(env, notification('fresh'))).status).toBe(
                'accepted',
              );
              unblock();
              expect((await pending)?.status).toBe('suppressed');
              expect(gateway).toHaveBeenCalledTimes(1);
              expect((await sendUserNotification(env, notification('stalled'))).status).toBe(
                'duplicate',
              );
              expect(gateway).toHaveBeenCalledTimes(1);
            } finally {
              unblock();
              await pending;
              clock.mockRestore();
            }
          },
        );
      }
    }
    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'expires a send claim after five seconds even within the initial admission minute',
      async () => {
        let monotonic = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
        const slowEnv = {
          ...env,
          DB: {
            prepare(sql: string) {
              const statement = env.DB.prepare(sql);
              return sql.startsWith('UPDATE email_send_attempts')
                ? afterStatementRun(statement, () => {
                    monotonic += 6_000;
                  })
                : statement;
            },
            batch: env.DB.batch.bind(env.DB),
          },
        };
        try {
          expect((await sendUserNotification(slowEnv, notification('slow-claim'))).status).toBe(
            'suppressed',
          );
          expect(gateway).not.toHaveBeenCalled();
          expect((await sendUserNotification(slowEnv, notification('slow-claim'))).status).toBe(
            'duplicate',
          );
          expect(await count('email_send_attempts')).toBe(1);
        } finally {
          clock.mockRestore();
        }
      },
    );
    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'does not retry failed gateway sends or refund quota',
      async () => {
        gateway.mockImplementation(async () =>
          Response.json({ error: 'synthetic_failure' }, { status: 503 }),
        );
        expect((await sendUserNotification(env, notification())).status).toBe('failed');
        expect((await sendUserNotification(env, notification())).status).toBe('duplicate');
        expect(gateway).toHaveBeenCalledTimes(1);
        expect(await count('email_send_attempts')).toBe(1);
      },
    );
    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'combines selected categories into one summary and claims it once under concurrent cron runs',
      async () => {
        await save({ assignments: 'hourly', comments: 'hourly' });
        expect((await sendUserNotification(env, notification())).status).toBe('aggregated');
        expect(
          (
            await sendUserNotification(env, {
              ...notification('comment-1', 'EMAIL-2'),
              kind: 'comment',
            })
          ).status,
        ).toBe('aggregated');
        expect(gateway).toHaveBeenCalledTimes(0);
        await dueBuckets();
        await Promise.all([sendEmailDigests(env), sendEmailDigests(env)]);
        expect(gateway).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(String(gateway.mock.calls[0]?.[1]?.body));
        expect(payload.text).toContain('Synthetic task 1');
        expect(payload.text).toContain('Synthetic task 2');
        expect(await count('email_digest_items')).toBe(0);
        await sendEmailDigests(env);
        expect(gateway).toHaveBeenCalledTimes(1);
      },
    );
    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'consumes the whole due cohort even when preparation is interrupted',
      async () => {
        await seedScheduledRecipients('interrupted', 'hourly');
        let batches = 0;
        const failing = {
          ...env,
          DB: {
            prepare: env.DB.prepare.bind(env.DB),
            batch: (async (statements) => {
              if (batches++ > 0) throw new Error('synthetic preparation interruption');
              return env.DB.batch(statements);
            }) as SqlDatabase['batch'],
          },
        };
        await expect(sendEmailDigests(failing)).rejects.toThrow(
          'synthetic preparation interruption',
        );
        const remaining = await env.DB.prepare(
          'SELECT COUNT(*) AS n FROM email_digest_buckets WHERE claimed = 0',
        ).first<{ n: number }>();
        expect(remaining?.n).toBe(0);
        await sendEmailDigests(env);
        expect(gateway).not.toHaveBeenCalled();
      },
    );
    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'discards admitted messages if preparation has crossed the fixed dispatch deadline',
      async () => {
        const now = await env.DB.prepare('SELECT unixepoch() AS now').first<{ now: number }>();
        const dispatchAt = Number(now?.now);
        const send = await prepareScheduledEmail(
          env,
          notification('late-admitted'),
          'daily',
          dispatchAt,
        );
        expect(send).toBeTypeOf('function');
        const clock = vi.spyOn(Date, 'now').mockReturnValue((dispatchAt + 61) * 1000);
        try {
          await send?.();
        } finally {
          clock.mockRestore();
        }
        expect(gateway).not.toHaveBeenCalled();
        expect(await count('email_send_attempts')).toBe(1);
        expect(
          await prepareScheduledEmail(
            env,
            notification('late-admission'),
            'daily',
            dispatchAt - 61,
          ),
        ).toBeUndefined();
        expect(await count('email_send_attempts')).toBe(1);
      },
    );

    for (const category of ['digest', 'deadline'] as const) {
      it.runIf(tenantProfile.capabilities.emailNotifications)(
        `admits the entire ${category} batch before sending and never consumes a later quota window`,
        async () => {
          await seedScheduledRecipients(
            `batch-${category}`,
            category === 'digest' ? 'hourly' : 'immediate',
          );
          const dispatch = () =>
            category === 'digest' ? sendEmailDigests(env) : sendDeadlineNotifications(env);
          gateway.mockImplementation(async () => {
            // Every decision must precede even the first network send. A slow provider
            // may outlast a quota window; making quota available cannot admit more mail.
            expect(await count('notification_deliveries')).toBe(8);
            if (category === 'digest') expect(await count('email_digest_buckets')).toBe(0);
            await run(
              'UPDATE email_send_attempts SET reserved_at = unixepoch() - 120 WHERE send_claimed = 1',
            );
            return Response.json({ ok: true });
          });
          await dispatch();
          expect(gateway).toHaveBeenCalledTimes(5);
          expect(await count('notification_deliveries')).toBe(8);
          await dispatch();
          expect(gateway).toHaveBeenCalledTimes(5);
        },
      );
    }

    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'discards due overflow recipients rather than carrying them into later quota minutes',
      async () => {
        await run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 51)
          INSERT INTO users (email) SELECT 'overflow-' || i || '@example.org' FROM n`);
        await run(`INSERT INTO email_digest_buckets (user_id, frequency, due_at)
          SELECT id, 'hourly', unixepoch() - 1 FROM users WHERE email LIKE 'overflow-%@example.org'`);
        expect(await count('email_digest_buckets')).toBe(51);
        await sendEmailDigests(env);
        expect(await count('email_digest_buckets')).toBe(0);
        expect(gateway).toHaveBeenCalledTimes(0);
      },
    );

    it.runIf(tenantProfile.capabilities.emailNotifications)(
      'discards due summaries denied quota and never drains them later; expires old intervals',
      async () => {
        await save({ assignments: 'daily' });
        await sendUserNotification(env, notification());
        await dueBuckets();
        await run('UPDATE email_delivery_settings SET per_minute = 0');
        await sendEmailDigests(env);
        expect(gateway).toHaveBeenCalledTimes(0);
        expect(await count('email_digest_items')).toBe(0);
        await run('UPDATE email_delivery_settings SET per_minute = 5');
        await sendEmailDigests(env);
        expect(gateway).toHaveBeenCalledTimes(0);
        await sendUserNotification(env, notification('expired'));
        await dueBuckets(600);
        await sendEmailDigests(env);
        expect(gateway).toHaveBeenCalledTimes(0);
        expect(await count('email_digest_items')).toBe(0);
      },
    );
  });
}
