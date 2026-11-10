import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { tenantProfile } from '../../shared/tenant-profile';
import { base64Url } from './google';
import { SESSION_COOKIE } from './session';

export const CSRF_COOKIE = `${tenantProfile.security.cookiePrefix}_csrf`;
type CookieContext = Parameters<typeof setCookie>[0];

export function issueCsrfCookie(context: CookieContext, maxAge = 43_200) {
  // Reuse the double-submit proof: rotating it during concurrent requests breaks other tabs.
  const existing = getCookie(context, CSRF_COOKIE);
  const token =
    existing && /^[A-Za-z0-9_-]{32,128}$/.test(existing)
      ? existing
      : base64Url(crypto.getRandomValues(new Uint8Array(32)));
  setCookie(context, CSRF_COOKIE, token, {
    httpOnly: false,
    maxAge,
    path: '/',
    sameSite: 'Strict',
    secure: true,
  });
  return token;
}

export function setSessionCookie(context: CookieContext, token: string, expiresAt: number) {
  const maxAge = Math.max(0, expiresAt - Math.floor(Date.now() / 1000));
  setCookie(context, SESSION_COOKIE, token, {
    httpOnly: true,
    maxAge,
    expires: new Date(expiresAt * 1000),
    path: '/',
    sameSite: 'Lax',
    secure: true,
  });
  issueCsrfCookie(context, maxAge);
}

export function clearSessionCookies(context: CookieContext) {
  deleteCookie(context, SESSION_COOKIE, { path: '/', secure: true });
  deleteCookie(context, CSRF_COOKIE, { path: '/', secure: true });
}
