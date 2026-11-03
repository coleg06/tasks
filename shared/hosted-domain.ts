// Leaf module: email-domain helpers shared by the profile, the runtime and the web UI.

/** Normalizes a configured hosted domain: lower case, no leading `@`; '' when unset. */
export function normalizeHostedDomain(value: string | undefined | null): string {
  return (value ?? '').trim().replace(/^@/, '').toLowerCase();
}

/**
 * True for a syntactically plain email address inside `hostedDomain`. With no domain (empty) every
 * plain address is accepted.
 */
export function hostedEmailMatches(value: string, hostedDomain: string): boolean {
  const email = value.trim().toLowerCase();
  const separator = email.lastIndexOf('@');
  if (!(separator > 0 && separator === email.indexOf('@') && !/\s/.test(email))) return false;
  const domain = email.slice(separator + 1);
  if (!domain) return false;
  const hosted = normalizeHostedDomain(hostedDomain);
  return hosted === '' || domain === hosted;
}
