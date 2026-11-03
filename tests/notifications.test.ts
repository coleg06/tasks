import { describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import type { Env } from '../src/env';
import { groupDeadlineItems } from '../src/notifications/deadlines';
import {
  emailRequestSignature,
  extractMentionHandles,
  notificationPayload,
  notificationsConfigured,
  sendUserNotification,
  taskNotificationOutboxStatement,
} from '../src/notifications/email';

describe('task notification email', () => {
  it('extracts unique, stable mention handles without treating ordinary email addresses as mentions', () => {
    expect(
      extractMentionHandles('Please ask @casey and @Jane.Doe. Copy test@example.com.'),
    ).toEqual(['casey', 'jane.doe']);
  });

  it('escapes staff-controlled text in the HTML email', () => {
    const payload = notificationPayload({
      from: 'tasks-dev@example.org',
      to: 'admin@example.org',
      recipientName: 'Alex <Admin>',
      subject: 'Assigned task',
      heading: 'New <task>',
      message: 'Review & approve',
      url: 'https://tasks-dev.example.org/?task=TASK-1&view=open',
      details: [
        {
          label: 'Due today',
          title: 'Review <script>alert(1)</script>',
          context: 'IT & Operations',
          url: 'https://tasks.example.org/?task=TASK-2&view=mine',
        },
      ],
    });
    expect(payload.html).toContain('Alex &lt;Admin&gt;');
    expect(payload.html).toContain('New &lt;task&gt;');
    expect(payload.html).toContain('Review &amp; approve');
    expect(payload.html).not.toContain('Alex <Admin>');
    expect(payload.html).toContain('Review &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(payload.html).toContain('IT &amp; Operations');
  });

  it('signs the gateway canonical request deterministically', async () => {
    await expect(
      emailRequestSignature('a'.repeat(32), '1\nPOST\n/v1/email\nid\ndigest'),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it.runIf(!tenantProfile.capabilities.emailNotifications)(
    'never configures automatic email when the profile disables it',
    () => {
      expect(
        notificationsConfigured({
          ENVIRONMENT: 'production',
          EMAIL_API_CLIENT_ID: tenantProfile.integrations.emailGateway.clientId,
          EMAIL_API_SECRET: 'a'.repeat(32),
          EMAIL_FROM: tenantProfile.integrations.emailGateway.fromEmail,
          EMAIL_API_ENDPOINT: tenantProfile.integrations.emailGateway.productionOrigin,
        } as never),
      ).toBe(false);
    },
  );

  it.runIf(tenantProfile.capabilities.emailNotifications)(
    'allows automatic application email only through the production Tasks identity',
    () => {
      const gateway = tenantProfile.integrations.emailGateway;
      const base = {
        EMAIL_API_CLIENT_ID: gateway.clientId,
        EMAIL_API_SECRET: 'a'.repeat(32),
        EMAIL_FROM: gateway.fromEmail,
      };
      expect(
        notificationsConfigured({
          ...base,
          ENVIRONMENT: 'dev',
          EMAIL_API_ENDPOINT: gateway.productionOrigin,
        } as never),
      ).toBe(false);
      expect(
        notificationsConfigured({
          ...base,
          ENVIRONMENT: 'production',
          EMAIL_API_ENDPOINT: gateway.productionOrigin,
        } as never),
      ).toBe(true);
      expect(
        notificationsConfigured({
          ...base,
          ENVIRONMENT: 'production',
          EMAIL_API_CLIENT_ID: 'tasks-dev',
          EMAIL_API_ENDPOINT: gateway.productionOrigin,
        } as never),
      ).toBe(false);
    },
  );

  it('does not reserve Portal alert work when that environment has no publisher', () => {
    const statement = { bind: vi.fn() };
    const prepare = vi.fn(() => statement);
    const notification = {
      userId: 7,
      kind: 'assignment' as const,
      entityType: 'task' as const,
      entityKey: 'TASK-1',
      dedupeKey: 'assignment:TASK-1:7',
      subject: 'Assigned',
      heading: 'Assigned',
      message: 'Assigned',
      url: 'https://tasks.example.org/?task=TASK-1',
      taskVersion: 2,
    };

    expect(
      taskNotificationOutboxStatement(
        { DB: { prepare }, ENVIRONMENT: 'production' } as unknown as Env,
        notification,
        'request-1',
      ),
    ).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('groups every matching deadline into one sorted digest per user', () => {
    const grouped = groupDeadlineItems([
      {
        userId: 7,
        days: 3,
        label: 'Due in 3 days',
        title: 'Later',
        context: 'IT',
        url: 'https://tasks.example.org/?task=2',
      },
      {
        userId: 7,
        days: 0,
        label: 'Due today',
        title: 'Today',
        context: 'Event',
        url: 'https://tasks.example.org/events/1',
      },
      {
        userId: 9,
        days: 1,
        label: 'Due tomorrow',
        title: 'Other user',
        context: 'Personal',
        url: 'https://tasks.example.org/?task=3',
      },
    ]);
    expect([...grouped.keys()]).toEqual([7, 9]);
    expect(grouped.get(7)?.map((item) => item.title)).toEqual(['Today', 'Later']);
  });

  it('skips every delivery after private-project access is revoked', async () => {
    const first = vi.fn(async () => null);
    const bind = vi.fn(() => ({ first }));
    const prepare = vi.fn(() => ({ bind }));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendUserNotification(
      { DB: { prepare }, ENVIRONMENT: 'dev' } as unknown as Env,
      {
        userId: 42,
        kind: 'mention',
        entityType: 'task',
        entityKey: 'TASK-PRIVATE',
        dedupeKey: 'mention:private:42',
        subject: 'Must not send',
        heading: 'Must not send',
        message: 'Must not send',
        url: 'https://tasks-dev.example.org/?task=TASK-PRIVATE',
        taskVersion: 3,
      },
    );
    expect(result).toEqual({ status: 'skipped' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it.runIf(tenantProfile.capabilities.portalAlerts)(
    'claims and delivers an outbox row reserved atomically with the task mutation',
    async () => {
      const fetchMock = vi.fn(async () => new Response('{}', { status: 202 }));
      vi.stubGlobal('fetch', fetchMock);
      const prepare = vi.fn((sql: string) => ({
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (sql.includes('SELECT 1 AS allowed')) return { allowed: 1 };
            if (sql.includes('SELECT u.email')) {
              return {
                email: 'staff@example.org',
                name: 'Staff User',
                portal_db_id: 42,
                email_enabled: 0,
                in_app_enabled: 1,
                push_enabled: 0,
              };
            }
            if (sql.includes('SELECT id, created_at, attempts FROM notification_outbox')) {
              return { id: 7, created_at: '2026-08-21T15:00:00Z', attempts: 0 };
            }
            return null;
          }),
          run: vi.fn(async () => ({ meta: { changes: sql.includes('INSERT OR IGNORE') ? 0 : 1 } })),
        })),
      }));
      const result = await sendUserNotification(
        {
          DB: { prepare },
          ENVIRONMENT: 'dev',
          TASK_ALERT_PUBLISHER_SECRET: 'p'.repeat(32),
        } as unknown as Env,
        {
          userId: 9,
          kind: 'assignment',
          entityType: 'task',
          entityKey: 'TASK-ATOMIC',
          dedupeKey: 'assignment:atomic:9',
          subject: 'Assigned',
          heading: 'Assigned',
          message: 'Assigned',
          url: 'https://tasks-dev.example.org/?task=TASK-ATOMIC',
          taskVersion: 2,
        },
      );
      expect(result).toEqual({ status: 'skipped', outboxReserved: false });
      expect(fetchMock).toHaveBeenCalledOnce();
      vi.unstubAllGlobals();
    },
  );
});
