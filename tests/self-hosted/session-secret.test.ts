import { describe, expect, it } from 'vitest';
import { missingIdentityVariables } from '../../src/self-hosted/platform';

const google = { GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret' };

describe('production startup settings', () => {
  it('treats a short session secret as missing, since it could be guessed and sessions forged', () => {
    const missing = (secret: string) =>
      missingIdentityVariables({ ...google, SESSION_SECRET: secret } as NodeJS.ProcessEnv);
    expect(missing('short')).toEqual(['SESSION_SECRET']);
    expect(missing('x'.repeat(31))).toEqual(['SESSION_SECRET']);
    expect(missing(' '.repeat(40))).toEqual(['SESSION_SECRET']);
    expect(missing('x'.repeat(32))).toEqual([]);
  });
});
