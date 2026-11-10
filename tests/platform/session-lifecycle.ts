import { jwtVerify, SignJWT } from 'jose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { app } from '../../src/app';
import { CSRF_COOKIE } from '../../src/auth/cookies';
import {
  BROWSER_SESSION_AUDIENCE,
  IMPERSONATION_SECONDS,
  renewSession,
  restoreActorSession,
  revokeSession,
  revokeSessionToken,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_COOKIE,
  SESSION_IDLE_SECONDS,
  signSession,
  verifySession,
} from '../../src/auth/session';
import type { Env } from '../../src/env';
import { SessionIdentityProvider } from '../../src/identity/session';
import type { SqlDatabase } from '../../src/platform/ports';

const ORIGIN = 'https://tasks.example.test';
const START = Math.floor(new Date('2026-10-01T12:00:00Z').getTime() / 1000);
const CSRF = 'synthetic-csrf-proof-for-session-fixtures-123456';
const user = { id: 61, email: 'session-user@example.test' };
const actor = { id: 62, email: 'session-actor@example.test' };
const permissions = ['tasks.view', 'tasks.comment'];

export type SessionBackend = {
  db: SqlDatabase;
  restart?(): Promise<SqlDatabase>;
  dispose(): Promise<void>;
};

export function describeSessionLifecycle(label: string, open: () => Promise<SessionBackend>) {
  describe(`browser session lifecycle on ${label}`, () => {
    let backend: SessionBackend;
    let env: Env;
    const time = (seconds: number) => vi.setSystemTime(seconds * 1000);
    const evidence = (token: string) => ({
      kind: 'browser' as const,
      token,
      permission: 'tasks.view',
    });
    const resolve = (token: string, environment = env) =>
      new SessionIdentityProvider(environment).resolve(evidence(token));
    const claims = (token: string) => verifySession(env, token);
    const headers = (token: string) => ({
      Cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${CSRF}`,
      Origin: ORIGIN,
      'X-CSRF-Token': CSRF,
    });
    const bootstrap = (token: string) =>
      app.request(`${ORIGIN}/api/bootstrap`, { headers: headers(token) }, env);
    const signed = () => signSession(env, user, permissions);
    const asActor = () => signSession(env, actor, ['tasks.view', 'tasks.comment', 'tasks.manage']);
    const impersonate = async () => {
      const rootToken = await asActor();
      const root = await claims(rootToken);
      const token = await signSession(env, user, permissions, actor, root);
      return { rootToken, root, token, session: await claims(token) };
    };
    async function forged(values: Record<string, unknown>, algorithm = 'HS256') {
      return new SignJWT(values)
        .setProtectedHeader({ alg: algorithm })
        .setIssuer(tenantProfile.security.tokenIssuer)
        .setAudience(BROWSER_SESSION_AUDIENCE)
        .sign(new TextEncoder().encode(env.SESSION_SECRET));
    }
    beforeAll(async () => {
      backend = await open();
      env = {
        DB: backend.db,
        ASSETS: { fetch: async () => new Response('asset') },
        ENVIRONMENT: 'local',
        RELEASE_SHA: 'session-fixture',
        GOOGLE_CLIENT_ID: 'synthetic-client',
        GOOGLE_CLIENT_SECRET: 'synthetic-secret',
        SESSION_SECRET: 'synthetic-browser-session-key-at-least-32-characters',
        TASKS_PUBLIC_ORIGIN: ORIGIN,
      } as unknown as Env;
      for (const person of [user, actor]) {
        await env.DB.prepare('INSERT INTO users (id, email) VALUES (?, ?)')
          .bind(person.id, person.email)
          .run();
      }
    }, 120_000);
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      time(START);
      await env.DB.prepare('DELETE FROM browser_sessions').run();
      await env.DB.prepare("UPDATE users SET status = 'active' WHERE id IN (?, ?)")
        .bind(user.id, actor.id)
        .run();
      await env.DB.prepare('DELETE FROM user_roles WHERE user_id IN (?, ?)')
        .bind(user.id, actor.id)
        .run();
      await env.DB.prepare('DELETE FROM user_permissions WHERE user_id IN (?, ?)')
        .bind(user.id, actor.id)
        .run();
      for (const person of [user, actor]) {
        for (const permission of [...permissions, ...(person === actor ? ['tasks.manage'] : [])]) {
          await env.DB.prepare(
            'INSERT INTO user_permissions (user_id, permission_key) VALUES (?, ?)',
          )
            .bind(person.id, permission)
            .run();
        }
      }
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });
    afterAll(async () => backend?.dispose());

    it('issues a seven-day JWT with the original authentication time and a fixed 30-day cap', async () => {
      const session = await claims(await signed());
      expect(session).toMatchObject({
        sub: String(user.id),
        auth_time: START,
        iat: START,
        exp: START + SESSION_IDLE_SECONDS,
        absolute_exp: START + SESSION_ABSOLUTE_SECONDS,
      });
      expect(await resolve(await signed())).not.toBeNull();
    });

    it('separates durable cookies from legacy audiences so rollback cannot bypass revocation', async () => {
      const token = await signed();
      await expect(
        jwtVerify(token, new TextEncoder().encode(env.SESSION_SECRET), {
          algorithms: ['HS256'],
          issuer: tenantProfile.security.tokenIssuer,
          audience: tenantProfile.security.tokenIssuer,
        }),
      ).rejects.toThrow('aud');
      const legacy = await new SignJWT({ email: user.email, perms: permissions })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(String(user.id))
        .setIssuer(tenantProfile.security.tokenIssuer)
        .setAudience(tenantProfile.security.tokenIssuer)
        .setIssuedAt(START)
        .setJti(crypto.randomUUID())
        .setExpirationTime(START + 43_200)
        .sign(new TextEncoder().encode(env.SESSION_SECRET));
      expect(await resolve(legacy)).toBeNull();
    });

    it('rejects absent, malformed, incorrectly signed, wrong-algorithm and legacy evidence', async () => {
      const token = await signed();
      for (const invalid of [
        '',
        'invalid',
        `${token}tampered`,
        await forged({
          sub: String(user.id),
          email: user.email,
          perms: permissions,
          exp: START + 43_200,
        }),
        await forged({ ...(await claims(token)) }, 'HS384'),
      ]) {
        expect(await resolve(invalid)).toBeNull();
      }
    });

    it('rejects signed malformed or unbounded claims even when the session row exists', async () => {
      const session = await claims(await signed());
      for (const patch of [
        { auth_time: START + 1 },
        { iat: START + 1 },
        { absolute_exp: START + SESSION_ABSOLUTE_SECONDS + 1 },
        { exp: START + SESSION_ABSOLUTE_SECONDS + 1 },
        { sub: '0' },
        { sub: '61.0' },
        { actor_session: session.jti },
        { perms: [1] },
        { jti: crypto.randomUUID() },
      ]) {
        expect(
          await resolve(await forged({ ...session, ...patch })),
          JSON.stringify(patch),
        ).toBeNull();
      }
    });

    it('rejects JWT expiry, database idle expiry, missing state and database outages', async () => {
      const token = await signed();
      const session = await claims(token);
      time(session.exp);
      expect(await resolve(token)).toBeNull();
      time(START);
      await env.DB.prepare('UPDATE browser_sessions SET expires_at = ? WHERE id = ?')
        .bind(START + 1, session.jti)
        .run();
      time(START + 1);
      expect(await resolve(token)).toBeNull();
      await env.DB.prepare('DELETE FROM browser_sessions WHERE id = ?').bind(session.jti).run();
      time(START);
      expect(await resolve(token)).toBeNull();
      const unavailable = {
        ...env,
        DB: {
          prepare: () => {
            throw new Error('synthetic database outage');
          },
        },
      } as unknown as Env;
      expect(await resolve(token, unavailable)).toBeNull();
    });

    it('renews a valid authorized session while retaining its ID and authentication bound', async () => {
      const token = await signed();
      const original = await claims(token);
      time(START + 3_600);
      const renewed = await renewSession(env, original);
      expect(renewed).not.toBeNull();
      const next = await claims(renewed?.token ?? '');
      expect(next).toMatchObject({
        jti: original.jti,
        auth_time: START,
        absolute_exp: original.absolute_exp,
        iat: START + 3_600,
        exp: START + 3_600 + SESSION_IDLE_SECONDS,
      });
      expect(await renewSession(env, next)).toBeNull();
      expect(await claims(token)).toMatchObject({ jti: original.jti });
    });

    it('never refreshes past the absolute bound and expires even with continuous activity', async () => {
      let token = await signed();
      for (const day of [6, 12, 18, 24, 29]) {
        time(START + day * 86_400);
        const session = await claims(token);
        const renewed = await renewSession(env, session);
        if (renewed) token = renewed.token;
        const next = await claims(token);
        expect(next.auth_time).toBe(START);
        expect(next.exp).toBeLessThanOrEqual(START + SESSION_ABSOLUTE_SECONDS);
      }
      expect((await claims(token)).exp).toBe(START + SESSION_ABSOLUTE_SECONDS);
      time(START + SESSION_ABSOLUTE_SECONDS);
      expect(await resolve(token)).toBeNull();
    });

    it('logout invalidates copied and renewed cookies across independently created providers', async () => {
      const token = await signed();
      const original = await claims(token);
      time(START + 3_600);
      const renewed = await renewSession(env, original);
      await revokeSession(env, original);
      expect(await resolve(token, { ...env })).toBeNull();
      expect(await resolve(renewed?.token ?? '', { ...env })).toBeNull();
      await expect(renewSession(env, original)).rejects.toThrow();
      expect(
        await env.DB.prepare('SELECT revoked_at FROM browser_sessions WHERE id = ?')
          .bind(original.jti)
          .first(),
      ).toMatchObject({ revoked_at: START + 3_600 });
    });

    it('a refresh paused before its UPDATE cannot resurrect concurrent logout', async () => {
      const original = await claims(await signed());
      time(START + 3_600);
      const database = env.DB;
      const raced = {
        ...env,
        DB: {
          ...database,
          prepare(sql: string) {
            const statement = database.prepare(sql);
            if (!sql.startsWith('UPDATE browser_sessions SET expires_at')) return statement;
            return {
              ...statement,
              bind(...values: unknown[]) {
                const bound = statement.bind(...values);
                return {
                  ...bound,
                  async run() {
                    await revokeSession(env, original);
                    return bound.run();
                  },
                };
              },
            };
          },
        },
      } as unknown as Env;
      await expect(renewSession(raced, original)).rejects.toThrow('renewal rejected');
      expect(
        await env.DB.prepare('SELECT expires_at, revoked_at FROM browser_sessions WHERE id = ?')
          .bind(original.jti)
          .first(),
      ).toMatchObject({ expires_at: original.exp, revoked_at: START + 3_600 });
    });

    it('disabling permanently revokes existing sessions even after re-enabling the user', async () => {
      const token = await signed();
      await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").bind(user.id).run();
      expect(await resolve(token)).toBeNull();
      await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(user.id).run();
      expect(await resolve(token)).toBeNull();
      expect(await resolve(await signed())).not.toBeNull();
    });

    it('rechecks current user identity and authorization rather than trusting JWT hints', async () => {
      const token = await signSession(env, user, ['platform.admin']);
      expect((await resolve(token))?.permissions).not.toContain('platform.admin');
      await env.DB.prepare('DELETE FROM user_permissions WHERE user_id = ?').bind(user.id).run();
      expect(await resolve(token)).toBeNull();
      time(START + 3_600);
      const original = await claims(token);
      await expect(renewSession(env, original)).rejects.toThrow('authorization revoked');
      await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
        .bind('changed@example.test', user.id)
        .run();
      expect(await resolve(token)).toBeNull();
      await expect(renewSession(env, original)).rejects.toThrow('user unavailable');
      await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?')
        .bind(user.email, user.id)
        .run();
    });

    it('persists both validity and revocation across a database restart or a new Worker environment', async () => {
      const active = await signed();
      const revoked = await signed();
      await revokeSession(env, await claims(revoked));
      if (backend.restart) env.DB = await backend.restart();
      expect(await resolve(active, { ...env })).not.toBeNull();
      expect(await resolve(revoked, { ...env })).toBeNull();
    });

    it('requires the actor session and limits impersonation to twelve hours and the actor expiry', async () => {
      await expect(signSession(env, user, permissions, actor)).rejects.toThrow('actor session');
      const root = await claims(await asActor());
      time(root.exp - 7_200);
      const token = await signSession(env, user, permissions, actor, root);
      const session = await claims(token);
      expect(session).toMatchObject({
        auth_time: root.auth_time,
        absolute_exp: root.absolute_exp,
        actor_session: root.jti,
        exp: root.exp,
      });
      expect(await renewSession(env, session)).toBeNull();
      expect(await resolve(token)).not.toBeNull();
      time(root.exp);
      expect(await resolve(token)).toBeNull();
    });

    it('never extends an impersonation and re-authorizes its actor on every request', async () => {
      const { root, token, session } = await impersonate();
      expect(session.exp).toBe(START + IMPERSONATION_SECONDS);
      time(START + 3_600);
      expect(await renewSession(env, session)).toBeNull();
      await env.DB.prepare(
        "DELETE FROM user_permissions WHERE user_id = ? AND permission_key = 'tasks.manage'",
      )
        .bind(actor.id)
        .run();
      expect(await resolve(token)).toBeNull();
      await revokeSession(env, root);
      await expect(claims(token)).rejects.toThrow();
    });

    it('stopping impersonation revokes replay and restores the original actor session bounds', async () => {
      const { root, token, session } = await impersonate();
      time(START + 3_600);
      const restored = await restoreActorSession(env, session, actor, ['tasks.manage']);
      const restoredClaims = await claims(restored.token);
      expect(restoredClaims).toMatchObject({
        jti: root.jti,
        auth_time: root.auth_time,
        absolute_exp: root.absolute_exp,
        exp: root.exp,
        sub: String(actor.id),
      });
      expect(restoredClaims.act).toBeUndefined();
      expect(await resolve(token)).toBeNull();
      await expect(restoreActorSession(env, session, actor, [])).rejects.toThrow();
    });

    it('restoring near the actor idle deadline permits later authorized activity within its absolute cap', async () => {
      const root = await claims(await asActor());
      time(root.exp - 60);
      const child = await claims(await signSession(env, user, permissions, actor, root));
      const restored = await restoreActorSession(env, child, actor, ['tasks.manage']);
      expect(restored.expiresAt).toBe(root.exp);
      const renewed = await renewSession(env, await claims(restored.token));
      expect(renewed?.expiresAt).toBeLessThanOrEqual(root.absolute_exp);
      expect(renewed?.expiresAt).toBeGreaterThan(root.exp);
    });

    it('logout from impersonation revokes both the child and the original actor session', async () => {
      const { rootToken, token, session } = await impersonate();
      await revokeSession(env, session);
      expect(await resolve(rootToken)).toBeNull();
      expect(await resolve(token)).toBeNull();
      await expect(restoreActorSession(env, session, actor, [])).rejects.toThrow();
    });

    it('expired impersonation evidence may only log out its family, never renew or restore it', async () => {
      const { rootToken, token, session } = await impersonate();
      time(session.exp);
      expect(await resolve(token)).toBeNull();
      await expect(renewSession(env, session)).rejects.toThrow();
      await expect(restoreActorSession(env, session, actor, [])).rejects.toThrow();
      expect(await resolve(rootToken)).not.toBeNull();
      await revokeSessionToken(env, token);
      expect(await resolve(rootToken)).toBeNull();
    });

    it('does not report logout success when durable revocation fails', async () => {
      const token = await signed();
      const database = env.DB;
      const unavailable = {
        ...env,
        DB: {
          ...database,
          prepare(sql: string) {
            if (sql.startsWith('UPDATE browser_sessions SET revoked_at')) {
              throw new Error('synthetic revocation write failure');
            }
            return database.prepare(sql);
          },
        },
      } as unknown as Env;
      await expect(revokeSessionToken(unavailable, token)).rejects.toThrow(
        'revocation write failure',
      );
      expect(await resolve(token)).not.toBeNull();
    });

    it('disabling the actor revokes its impersonation family durably', async () => {
      const { rootToken, token } = await impersonate();
      await env.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
        .bind(actor.id)
        .run();
      await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(actor.id).run();
      expect(await resolve(rootToken)).toBeNull();
      expect(await resolve(token)).toBeNull();
    });

    describe.skipIf(tenantProfile.tasks.apiMode !== 'legacy')('browser HTTP integration', () => {
      it('refreshes on authorized activity, aligns cookie/JWT expiry and preserves the CSRF proof', async () => {
        const token = await signed();
        time(START + 3_600);
        const response = await bootstrap(token);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const cookies = response.headers.getSetCookie();
        const sessionCookie =
          cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)) ?? '';
        const renewedToken = sessionCookie.split(';')[0].slice(SESSION_COOKIE.length + 1);
        const session = await claims(renewedToken);
        const ttl = session.exp - (START + 3_600);
        expect(sessionCookie).toContain(`Max-Age=${ttl}`);
        expect(sessionCookie).toContain(`Expires=${new Date(session.exp * 1000).toUTCString()}`);
        for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'])
          expect(sessionCookie).toContain(attribute);
        const csrf = cookies.findLast((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`)) ?? '';
        expect(csrf).toContain(`${CSRF_COOKIE}=${CSRF}`);
        expect(csrf).toContain(`Max-Age=${ttl}`);
        expect(csrf).toContain('SameSite=Strict');
        expect(csrf).not.toContain('HttpOnly');
      });

      it('does not renew unauthorized, expired, revoked or disabled sessions', async () => {
        const token = await signed();
        const session = await claims(token);
        time(START + 3_600);
        await env.DB.prepare('DELETE FROM user_permissions WHERE user_id = ?').bind(user.id).run();
        expect((await bootstrap(token)).status).toBe(403);
        expect(
          await env.DB.prepare('SELECT expires_at FROM browser_sessions WHERE id = ?')
            .bind(session.jti)
            .first(),
        ).toMatchObject({ expires_at: session.exp });
        await revokeSession(env, session);
        expect((await bootstrap(token)).status).toBe(401);
      });

      it('HTTP logout clears both cookies, rejects cross-origin requests and prevents replay', async () => {
        const token = await signed();
        const hostile = await app.request(
          `${ORIGIN}/auth/logout`,
          { method: 'POST', headers: { ...headers(token), Origin: 'https://other.example.test' } },
          env,
        );
        expect(hostile.status).toBe(403);
        expect(await resolve(token)).not.toBeNull();
        const response = await app.request(
          `${ORIGIN}/auth/logout`,
          { method: 'POST', headers: headers(token) },
          env,
        );
        expect(response.status).toBe(302);
        for (const name of [SESSION_COOKIE, CSRF_COOKIE]) {
          expect(
            response.headers
              .getSetCookie()
              .some((cookie) => cookie.startsWith(`${name}=`) && cookie.includes('Max-Age=0')),
          ).toBe(true);
        }
        expect(await resolve(token)).toBeNull();
      });

      it('HTTP stop-impersonation revokes the child cookie and preserves actor expiry', async () => {
        const { root, token } = await impersonate();
        const response = await app.request(
          `${ORIGIN}/api/admin/impersonation/stop`,
          { method: 'POST', headers: headers(token) },
          env,
        );
        expect(response.status).toBe(200);
        const cookie =
          response.headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`)) ??
          '';
        const restored = await claims(cookie.split(';')[0].slice(SESSION_COOKIE.length + 1));
        expect(restored).toMatchObject({
          jti: root.jti,
          exp: root.exp,
          auth_time: root.auth_time,
          absolute_exp: root.absolute_exp,
        });
        expect(await resolve(token)).toBeNull();
      });
    });
  });
}
