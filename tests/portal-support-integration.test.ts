import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { tenantExtensions } from '../shared/tenant-profile-support';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { testOrigins } from './support/origins';
import {
  isTenantConfigurationQuery,
  matchingTenantConfigurationRow,
} from './tenant-configuration-fixture';

const secret = 'portal-support-integration-secret-that-is-long-enough';

class FakeStatement {
  private values: unknown[] = [];

  constructor(
    private readonly database: FakeDatabase,
    readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  first<T>() {
    return Promise.resolve(this.database.first(this.sql, this.values) as T | null);
  }

  run() {
    return Promise.resolve(this.database.run(this.sql, this.values));
  }
}

class FakeDatabase {
  taskKey: string | null = null;
  inserted = 0;
  insertChanges = 1;

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    return Promise.all(statements.map((statement) => statement.run()));
  }

  first(sql: string, values: unknown[]) {
    if (isTenantConfigurationQuery(sql)) return matchingTenantConfigurationRow;
    if (sql.includes('SELECT task_key FROM tasks')) {
      return this.taskKey ? { task_key: this.taskKey } : null;
    }
    if (sql.includes('SELECT p.id AS project_id')) {
      return { project_id: 4, workspace_id: 2, actor_user_id: 7 };
    }
    if (sql.includes('JOIN workspace_members wm')) {
      return values[1] === 'admin@example.org' ? { id: 7 } : null;
    }
    return null;
  }

  run(sql: string, values: unknown[]) {
    if (sql.includes('INSERT OR IGNORE INTO tasks')) {
      if (this.taskKey) return { meta: { changes: 0 } };
      this.taskKey = String(values[0]);
      this.inserted += 1;
      return { meta: { changes: this.insertChanges } };
    }
    return { meta: { changes: 1 } };
  }
}

function env(database: FakeDatabase, configured = true) {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    DB: database,
    ENVIRONMENT: 'dev',
    ...(configured ? { PORTAL_SUPPORT_INGEST_SECRET: secret } : {}),
  } as unknown as Env;
}

const payload = {
  ticket_id: 142,
  subject: 'Audio system: no sound in Large Group',
  description: 'There is no audio in the Large Group room.',
  priority: 'High',
  area: 'Audio system',
  owner: 'Alex',
  owner_email: 'admin@example.org',
  requester_name: 'Test User',
  requester_email: 'test.user@example.org',
  location: 'Large Group',
  impact: 'A team or room',
  ticket_url: `https://${tenantExtensions().integrations?.portalSupport?.ticketHosts[0] ?? 'portal.example.org'}/v2/tickets/details.php?ticket_id=142`,
};

describe.runIf(tenantProfile.capabilities.portalSupport)('Portal support integration', () => {
  it('fails closed when the integration secret is absent or incorrect', async () => {
    const unconfigured = await app.request(
      `${testOrigins.development}/api/integrations/portal/support-tickets/health`,
      { headers: { Authorization: `Bearer ${secret}` } },
      env(new FakeDatabase(), false),
    );
    expect(unconfigured.status).toBe(503);

    const unauthorized = await app.request(
      `${testOrigins.development}/api/integrations/portal/support-tickets/health`,
      { headers: { Authorization: `Bearer ${'x'.repeat(secret.length)}` } },
      env(new FakeDatabase()),
    );
    expect(unauthorized.status).toBe(401);
  });

  it('rejects invalid ticket data before touching D1', async () => {
    const response = await app.request(
      `${testOrigins.development}/api/integrations/portal/support-tickets`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, requester_email: 'not-an-email' }),
      },
      env(new FakeDatabase()),
    );
    expect(response.status).toBe(400);
    expect((await response.json()) as { error: string }).toMatchObject({ error: 'invalid_ticket' });
  });

  it('rejects oversized bodies and non-Portal ticket links', async () => {
    const oversized = await app.request(
      `${testOrigins.development}/api/integrations/portal/support-tickets`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Length': '20001',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
      env(new FakeDatabase()),
    );
    expect(oversized.status).toBe(413);

    const foreignLink = await app.request(
      `${testOrigins.development}/api/integrations/portal/support-tickets`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, ticket_url: 'https://example.com/tickets/142' }),
      },
      env(new FakeDatabase()),
    );
    expect(foreignLink.status).toBe(400);
  });

  it('creates one IT task and treats a retry as a successful duplicate', async () => {
    const database = new FakeDatabase();
    const request = () =>
      app.request(
        `${testOrigins.development}/api/integrations/portal/support-tickets`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        env(database),
      );

    const created = await request();
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      ok: true,
      created: true,
      task: { key: 'SUPPORT-142' },
    });

    const duplicate = await request();
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      ok: true,
      created: false,
      task: { key: 'SUPPORT-142' },
    });
    expect(database.inserted).toBe(1);
  });

  it('treats a D1 insert count that includes trigger writes as created', async () => {
    const database = new FakeDatabase();
    database.insertChanges = 3;
    const response = await app.request(
      `${testOrigins.development}/api/integrations/portal/support-tickets`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      env(database),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ created: true, task: { key: 'SUPPORT-142' } });
  });
});

describe.runIf(!tenantProfile.capabilities.portalSupport)('disabled Portal support intake', () => {
  it('does not register the ingestion routes', async () => {
    const response = await app.request(
      `${testOrigins.development}/api/integrations/portal/support-tickets`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      env(new FakeDatabase()),
    );
    expect(response.status).toBe(404);
  });
});
