import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { TaskAppEnv } from '../src/app-env';
import { auditStatement } from '../src/persistence/d1-audit';
import { auditStatement as compatibilityAuditStatement } from '../src/tasks/api';

function auditContext(input: { requestId?: string; cfRay?: string; forwardedRequestId?: string }) {
  const captured: { sql?: string; values?: unknown[] } = {};
  const prepared = {
    bind(...values: unknown[]) {
      captured.values = values;
      return prepared;
    },
  };
  const context = {
    env: {
      DB: {
        prepare(sql: string) {
          captured.sql = sql;
          return prepared;
        },
      },
    },
    get(key: string) {
      return key === 'requestId' ? input.requestId : undefined;
    },
    req: {
      header(name: string) {
        if (name.toLowerCase() === 'cf-ray') return input.cfRay;
        if (name.toLowerCase() === 'x-request-id') return input.forwardedRequestId;
        return undefined;
      },
    },
  } as unknown as Context<TaskAppEnv>;
  return { captured, context, prepared };
}

describe('D1 audit statement extraction', () => {
  it('preserves the atomic changes guard and explicit request override', () => {
    const { captured, context, prepared } = auditContext({
      requestId: 'middleware-request',
      cfRay: 'cloudflare-request',
    });
    const result = auditStatement(
      context,
      99,
      'task',
      'TASK-1',
      'task.updated',
      { title: { before: 'Old', after: 'New' } },
      'explicit-request',
      true,
    );

    expect(result).toBe(prepared);
    expect(captured.sql).toContain('WHERE ? = 0 OR changes() = 1');
    expect(captured.values).toEqual([
      99,
      'task',
      'TASK-1',
      'task.updated',
      JSON.stringify({ title: { before: 'Old', after: 'New' } }),
      'explicit-request',
      1,
    ]);
  });

  it('keeps middleware, Cloudflare, and forwarded request ID precedence', () => {
    const middleware = auditContext({
      requestId: 'middleware-request',
      cfRay: 'cloudflare-request',
      forwardedRequestId: 'forwarded-request',
    });
    auditStatement(middleware.context, 1, 'system', 'health', 'checked', {});
    expect(middleware.captured.values?.[5]).toBe('middleware-request');

    const cloudflare = auditContext({
      cfRay: 'cloudflare-request',
      forwardedRequestId: 'forwarded-request',
    });
    auditStatement(cloudflare.context, 1, 'system', 'health', 'checked', {});
    expect(cloudflare.captured.values?.[5]).toBe('cloudflare-request');

    const forwarded = auditContext({ forwardedRequestId: 'forwarded-request' });
    auditStatement(forwarded.context, 1, 'system', 'health', 'checked', {});
    expect(forwarded.captured.values?.[5]).toBe('forwarded-request');
    expect(forwarded.captured.values?.[6]).toBe(0);
  });

  it('retains the task API compatibility export during extraction', () => {
    expect(compatibilityAuditStatement).toBe(auditStatement);
  });
});
