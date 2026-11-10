import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Env } from '../env';
import { configuredHostedDomain, isHostedEmail } from '../runtime/identity-config';
import { sessionSecretIsConfigured } from './session';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function authIsConfigured(env: Env) {
  return Boolean(
    env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      sessionSecretIsConfigured(env.SESSION_SECRET),
  );
}

export function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function constantTimeEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export async function exchangeCode(
  env: Env,
  values: { code: string; verifier: string; redirectUri: string },
) {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
    code: values.code,
    code_verifier: values.verifier,
    grant_type: 'authorization_code',
    redirect_uri: values.redirectUri,
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    body,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  const result = (await response.json()) as { id_token?: string; error?: string };
  if (!response.ok || !result.id_token) {
    throw new Error(`Google token exchange failed: ${result.error ?? response.status}`);
  }
  return result.id_token;
}

export async function verifyGoogleIdentity(env: Env, idToken: string) {
  if (!env.GOOGLE_CLIENT_ID) throw new Error('Google authentication is not configured.');
  const { payload } = await jwtVerify(idToken, googleKeys, {
    algorithms: ['RS256'],
    audience: env.GOOGLE_CLIENT_ID,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
  });
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  if (payload.email_verified !== true || !isHostedEmail(env, email)) {
    const domain = configuredHostedDomain(env);
    throw new Error(
      domain
        ? `Only verified @${domain} accounts may sign in.`
        : 'Only verified email accounts may sign in.',
    );
  }
  if (typeof payload.sub !== 'string' || !/^[0-9]{6,64}$/.test(payload.sub)) {
    throw new Error('Google returned an invalid subject identifier.');
  }
  return {
    email,
    firstName: typeof payload.given_name === 'string' ? payload.given_name : '',
    lastName: typeof payload.family_name === 'string' ? payload.family_name : '',
    photoUrl: typeof payload.picture === 'string' ? payload.picture : null,
    subject: `google-oauth2|${payload.sub}`,
  };
}
