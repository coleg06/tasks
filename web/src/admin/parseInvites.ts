export type InviteEntry = { email: string; firstName: string; lastName: string };

const EMAIL = /[^\s<>,;"'()]+@[^\s<>,;"'()]+/g;

/**
 * Turns a pasted list into invitation entries. One person per line is the norm, and these all
 * work: `pat@example.org`, `Pat Example <pat@example.org>` and `pat@example.org, Pat, Example`
 * (the first word is the first name, the rest the last name). Several addresses on one line,
 * separated by commas, semicolons or spaces, become one entry each, without names.
 * Anything that is not an address is ignored here and flagged by the server preview if wrong.
 */
export function parseInviteList(text: string): InviteEntry[] {
  const entries: InviteEntry[] = [];
  for (const line of text.split(/\r?\n|;/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const addresses = trimmed.match(EMAIL) ?? [];
    if (addresses.length === 0) {
      // Not an address at all: keep it so the preview can point at the offending row.
      entries.push({ email: trimmed.slice(0, 254), firstName: '', lastName: '' });
      continue;
    }
    if (addresses.length > 1) {
      for (const address of addresses) {
        entries.push({ email: address, firstName: '', lastName: '' });
      }
      continue;
    }
    const address = addresses[0] ?? '';
    const names = trimmed
      .replace(address, ' ')
      .replace(/[<>"'(),\t]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    entries.push({
      email: address,
      firstName: names[0] ?? '',
      lastName: names.slice(1).join(' '),
    });
  }
  return entries;
}
