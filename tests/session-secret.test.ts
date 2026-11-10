import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { authIsConfigured } from '../src/auth/google';
import { signOAuthState, signSession, verifyOAuthState, verifySession } from '../src/auth/session';
import type { Env } from '../src/env';
import { withBrowserSessionStore } from './support/browser-session-store';

const user = { id: 1, email: 'user@example.org' };
const state = { state: 'state', verifier: 'verifier', returnTo: '/' };
const environment = (secret: string | undefined) =>
  withBrowserSessionStore({
    SESSION_SECRET: secret,
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'test',
  } as Env);

describe('session signing configuration on every runtime', () => {
  it.each([undefined, '', 'short', 'x'.repeat(31), ' '.repeat(40), ` ${'x'.repeat(30)} `])(
    'fails closed for an absent, blank or short key (case %#)',
    async (secret) => {
      const env = environment(secret);
      expect(authIsConfigured(env)).toBe(false);
      await expect(signSession(env, user, [])).rejects.toThrow('SESSION_SECRET');
      await expect(signOAuthState(env, state)).rejects.toThrow('SESSION_SECRET');
      await expect(verifySession(env, 'invalid')).rejects.toThrow('SESSION_SECRET');
      await expect(verifyOAuthState(env, 'invalid')).rejects.toThrow('SESSION_SECRET');
    },
  );

  it('rejects correctly signed tokens made with a weak configured key', async () => {
    const env = environment('weak');
    for (const oauth of [false, true]) {
      const forged = await new SignJWT(oauth ? state : { email: user.email, perms: [] })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject('1')
        .setIssuer(tenantProfile.security.tokenIssuer)
        .setAudience(`${tenantProfile.security.tokenIssuer}${oauth ? '-oauth' : ''}`)
        .setExpirationTime('10m')
        .sign(new TextEncoder().encode('weak'));
      await expect((oauth ? verifyOAuthState : verifySession)(env, forged)).rejects.toThrow(
        'SESSION_SECRET',
      );
    }
  });

  it('round trips sessions and OAuth state with a sufficiently long key', async () => {
    const env = environment('synthetic-session-key-for-tests-only');
    expect(authIsConfigured(env)).toBe(true);
    await expect(
      verifySession(env, await signSession(env, user, ['tasks.view'])),
    ).resolves.toMatchObject({
      sub: '1',
      email: user.email,
      perms: ['tasks.view'],
    });
    await expect(verifyOAuthState(env, await signOAuthState(env, state))).resolves.toMatchObject(
      state,
    );
  });
});
