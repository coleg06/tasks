import { afterEach, describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { tenantExtensions } from '../shared/tenant-profile-support';
import type { Env } from '../src/env';
import { deliverTaskAlertOutboxEvent } from '../src/notifications/portal';

describe.runIf(tenantProfile.capabilities.portalAlerts)('Portal task alert publisher', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('publishes only neutral routing metadata with the signed dev contract', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    const prepare = vi.fn(() => ({ bind }));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const env = {
      DB: { prepare },
      ENVIRONMENT: 'dev',
      TASK_ALERT_PUBLISHER_SECRET: 'p'.repeat(32),
    } as unknown as Env;

    await expect(
      deliverTaskAlertOutboxEvent(env, {
        id: 1,
        kind: 'mention',
        occurredAt: '2026-08-21T15:00:00Z',
        taskKey: 'TASK-ABC',
        taskVersion: 4,
        recipientPortalUserId: 42,
        attempts: 0,
      }),
    ).resolves.toEqual({ status: 'delivered' });

    const [url, init] = fetchMock.mock.calls[0] ?? [undefined, undefined];
    expect(url).toBe(tenantExtensions().integrations?.portalAlerts?.endpoint);
    const request: RequestInit = init ?? {};
    const headers = new Headers(request.headers);
    const prefix = tenantExtensions().integrations?.portalAlerts?.headerPrefix ?? 'X-Tasks';
    expect(headers.get('Idempotency-Key')).toBe('tasks-alert-event-1');
    expect(headers.get('Idempotency-Key')?.length).toBeGreaterThanOrEqual(16);
    expect(headers.get(`${prefix}-Alert-Publisher`)).toBe('tasks');
    expect(headers.get(`${prefix}-Signature`)).toMatch(/^sha256=[a-f0-9]{64}$/);
    const payload = JSON.parse(String(request.body));
    expect(payload).toEqual({
      version: 1,
      environment: 'development',
      publisher: 'tasks',
      event: {
        id: 'tasks.event.1',
        kind: 'mention',
        occurred_at: '2026-08-21T15:00:00Z',
        task_key: 'TASK-ABC',
        task_version: 4,
        recipient_portal_user_ids: [42],
      },
    });
    expect(payload.event.id.length).toBeGreaterThanOrEqual(8);
    expect(JSON.stringify(payload)).not.toMatch(/title|description|comment|message|body/i);
  });

  it('dead-letters a fifth failed delivery instead of retrying forever', async () => {
    const run = vi.fn(async () => ({ meta: { changes: 1 } }));
    const bind = vi.fn(() => ({ run }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 503 })),
    );
    const env = {
      DB: { prepare: vi.fn(() => ({ bind })) },
      ENVIRONMENT: 'dev',
      TASK_ALERT_PUBLISHER_SECRET: 'p'.repeat(32),
    } as unknown as Env;
    await expect(
      deliverTaskAlertOutboxEvent(env, {
        id: 1,
        kind: 'deadline',
        occurredAt: '2026-08-21T15:00:00Z',
        taskKey: 'TASK-ABC',
        taskVersion: 4,
        recipientPortalUserId: 42,
        attempts: 4,
      }),
    ).resolves.toEqual({ status: 'dead_letter' });
    expect(bind).toHaveBeenCalledWith('dead_letter', 5, 'http_503', '+21600 seconds', 1);
  });
});

describe.runIf(!tenantProfile.capabilities.portalAlerts)('disabled Portal task alerts', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('does not publish or mutate the outbox even when a secret is present', async () => {
    const prepare = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      deliverTaskAlertOutboxEvent(
        {
          DB: { prepare },
          ENVIRONMENT: 'dev',
          TASK_ALERT_PUBLISHER_SECRET: 'p'.repeat(32),
        } as unknown as Env,
        {
          id: 1,
          kind: 'mention',
          occurredAt: '2026-08-21T15:00:00Z',
          taskKey: 'TASK-ABC',
          taskVersion: 4,
          recipientPortalUserId: 42,
          attempts: 0,
        },
      ),
    ).resolves.toEqual({ status: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
