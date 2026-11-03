import { describe, expect, it } from 'vitest';
import { parseInviteList } from '../../web/src/admin/parseInvites';

describe('parseInviteList', () => {
  it('reads one person per line in the common formats', () => {
    expect(
      parseInviteList(
        [
          'sam@example.org',
          'Pat Example <pat@example.org>',
          'lee@example.org, Lee, Example Jr',
          '"Robin" <robin@example.org>',
        ].join('\n'),
      ),
    ).toEqual([
      { email: 'sam@example.org', firstName: '', lastName: '' },
      { email: 'pat@example.org', firstName: 'Pat', lastName: 'Example' },
      { email: 'lee@example.org', firstName: 'Lee', lastName: 'Example Jr' },
      { email: 'robin@example.org', firstName: 'Robin', lastName: '' },
    ]);
  });

  it('splits several addresses on one line and across semicolons', () => {
    expect(
      parseInviteList(
        'a@example.org, b@example.org; c@example.org d@example.org\r\ne@example.org',
      ).map((entry) => entry.email),
    ).toEqual([
      'a@example.org',
      'b@example.org',
      'c@example.org',
      'd@example.org',
      'e@example.org',
    ]);
  });

  it('skips blank lines and keeps non-addresses so they can be flagged', () => {
    expect(parseInviteList('\n  \nnot an address\n')).toEqual([
      { email: 'not an address', firstName: '', lastName: '' },
    ]);
    expect(parseInviteList('')).toEqual([]);
  });
});
