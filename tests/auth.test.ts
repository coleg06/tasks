import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from '../src/auth/google';

describe('OAuth state comparison', () => {
  it('accepts only exact byte-for-byte matches', () => {
    expect(constantTimeEqual('state-value', 'state-value')).toBe(true);
    expect(constantTimeEqual('state-value', 'state-valuE')).toBe(false);
    expect(constantTimeEqual('state-value', 'state-value-longer')).toBe(false);
  });
});
