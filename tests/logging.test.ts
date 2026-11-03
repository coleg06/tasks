import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { recordOperationalEvent } from '../src/logging';

describe('operational logging', () => {
  it('stores bounded scalar diagnostics without accepting nested request data', async () => {
    const run = vi.fn(async () => ({ success: true }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    await recordOperationalEvent({ DB: { prepare }, ENVIRONMENT: 'dev' } as unknown as Env, {
      event: 'integration.failed',
      source: 'integration',
      requestId: 'ray-1',
      message: 'Gateway failed',
      details: {
        errorName: 'TimeoutError',
        attempt: 2,
        accessToken: 'must-not-be-recorded',
        requestBody: { secret: 'must-not-be-recorded' },
        headers: ['must-not-be-recorded'],
      },
    });

    expect(run).toHaveBeenCalledOnce();
    const details = String((bind.mock.calls[0] as unknown[] | undefined)?.[9]);
    expect(details).toContain('TimeoutError');
    expect(details).toContain('"attempt":2');
    expect(details).not.toContain('requestBody');
    expect(details).not.toContain('headers');
    expect(details).not.toContain('must-not-be-recorded');
  });
});
