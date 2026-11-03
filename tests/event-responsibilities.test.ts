/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import type { Env } from '../src/env';
import {
  convertResponsibilityWorkflow,
  createApproval,
  createEvent,
  createResponsibility,
  createWorkItem,
  getEvent,
  listEvents,
  patchEventFacts,
  patchEventStage,
  patchResponsibility,
  patchWorkItem,
} from '../src/events/api';
import { eventIntakeSchema } from '../src/events/schemas';
import type { TaskAppEnv, TaskIdentity } from '../src/tasks/api';
import { effectiveMigrationsDirectory } from './support/migrations';
import { testOrigins } from './support/origins';

// Responsibilities exist only in legacy-D1 deployments that enable the events capability.
const legacyEvents = describe.runIf(
  tenantProfile.tasks.apiMode === 'legacy' && tenantProfile.capabilities.events,
);

type EventDetail = {
  key: string;
  version: number;
  factsVersion: number;
  workflowMode: string;
  readiness: string;
  progress: number;
  blockerCount: number;
  facts: Record<string, unknown>;
  originalRequest: Record<string, unknown> | null;
  factHistory: unknown[];
  deliverables: Array<{ owner_email: string | null }>;
  responsibilities: Array<{
    id: number;
    responsibility_key: string;
    area: string;
    owner_email: string | null;
    status: string;
    version: number;
  }>;
  workItems: Array<{ title: string; status: string; legacy: boolean }>;
};

const migrationsDirectory = effectiveMigrationsDirectory();
type SqlValue = null | number | bigint | string;

function sqlValues(values: unknown[]): SqlValue[] {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'string'
    ) {
      return value;
    }
    throw new TypeError(`Unsupported SQLite test value: ${typeof value}`);
  });
}

function migratedDatabase() {
  const database = new DatabaseSync(':memory:');
  for (const migration of readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    database.exec(readFileSync(join(migrationsDirectory, migration), 'utf8'));
  }
  return database;
}

function d1Adapter(database: DatabaseSync) {
  type Result = {
    success: true;
    meta: { changes: number };
    results: Record<string, unknown>[];
  };
  type Prepared = {
    sql: string;
    values: unknown[];
    bind: (...values: unknown[]) => Prepared;
    first: () => Promise<Record<string, unknown> | null>;
    all: () => Promise<{ results: Record<string, unknown>[] }>;
    run: () => Promise<Result>;
    execute: () => Result;
  };

  function prepare(sql: string): Prepared {
    const statement = database.prepare(sql);
    let values: unknown[] = [];
    const execute = (): Result => {
      if (/^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(sql)) {
        return {
          success: true,
          meta: { changes: 0 },
          results: statement.all(...sqlValues(values)) as Record<string, unknown>[],
        };
      }
      const result = statement.run(...sqlValues(values));
      return {
        success: true,
        meta: { changes: Number(result.changes) },
        results: [],
      };
    };
    const prepared: Prepared = {
      sql,
      values,
      bind(...nextValues: unknown[]) {
        values = nextValues;
        prepared.values = nextValues;
        return prepared;
      },
      async first() {
        return (statement.get(...sqlValues(values)) as Record<string, unknown> | undefined) ?? null;
      },
      async all() {
        return {
          results: statement.all(...sqlValues(values)) as Record<string, unknown>[],
        };
      },
      async run() {
        return execute();
      },
      execute,
    };
    return prepared;
  }

  return {
    prepare,
    async batch(statements: Prepared[]) {
      database.exec('BEGIN');
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = migratedDatabase();
  databases.push(db);
  const users = ['manager', 'facilities', 'production', 'viewer', 'external', 'inactive'] as const;
  for (const name of users) {
    db.prepare('INSERT INTO users (email, first_name, last_name, status) VALUES (?, ?, ?, ?)').run(
      `${name}@example.test`,
      name,
      'Synthetic',
      name === 'inactive' ? 'disabled' : 'active',
    );
    if (name !== 'external')
      db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role)
      SELECT id, (SELECT id FROM users WHERE email = ?), 'member' FROM workspaces WHERE workspace_key = '${tenantProfile.workspaceKey}'`).run(
        `${name}@example.test`,
      );
    for (const permission of [
      'tasks.view',
      'events.view',
      ...(name === 'manager' ? ['events.create', 'events.approve'] : []),
    ]) {
      db.prepare(
        `INSERT INTO user_permissions (user_id, permission_key) SELECT id, ? FROM users WHERE email = ?`,
      ).run(permission, `${name}@example.test`);
    }
  }
  const adapter = d1Adapter(db);
  let batchHook: (() => void) | undefined;
  const env = {
    DB: {
      ...adapter,
      batch: async (statements: Parameters<typeof adapter.batch>[0]) => {
        const run = batchHook;
        batchHook = undefined;
        run?.();
        return adapter.batch(statements);
      },
    },
    ENVIRONMENT: 'test',
    ASSETS: { fetch: async () => new Response('asset') },
  } as unknown as Env;
  const app = new Hono<TaskAppEnv>();
  app.use('*', async (context, next) => {
    const user = db
      .prepare('SELECT id, email, status FROM users WHERE email = ?')
      .get(`${context.req.header('x-test-user') ?? 'manager'}@example.test`) as {
      id: number;
      email: string;
      status: string;
    };
    context.set('taskIdentity', {
      user,
      auditUserId: user.id,
      session: {
        sub: String(user.id),
        email: user.email,
        perms: [],
        exp: Math.floor(Date.now() / 1000) + 1000,
      },
    } satisfies TaskIdentity);
    await next();
  });
  app.post('/api/events', createEvent);
  app.get('/api/events', listEvents);
  app.get('/api/events/:eventKey', getEvent);
  app.patch('/api/events/:eventKey/facts', patchEventFacts);
  app.patch('/api/events/:eventKey/stage', patchEventStage);
  app.post('/api/events/:eventKey/approvals', createApproval);
  app.post('/api/events/:eventKey/responsibilities', createResponsibility);
  app.patch('/api/events/:eventKey/responsibilities/:responsibilityKey', patchResponsibility);
  app.post('/api/events/:eventKey/responsibility-workflow', convertResponsibilityWorkflow);
  app.post('/api/events/:eventKey/work-items', createWorkItem);
  app.patch('/api/events/:eventKey/work-items/:workItemKey', patchWorkItem);
  async function request(path: string, method = 'GET', data?: unknown, user = 'manager') {
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      `${testOrigins.development}/api/events${path}`,
      {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': user },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      },
      env,
      {
        waitUntil: (p: Promise<unknown>) => {
          pending.push(p);
        },
        passThroughOnException() {},
        props: {},
      },
    );
    await Promise.all(pending);
    return response;
  }
  async function event(key: string, user = 'manager') {
    const response = await request(`/${key}`, 'GET', undefined, user);
    expect(response.status).toBe(200);
    return ((await response.json()) as { event: EventDetail }).event;
  }
  async function create(overrides: Record<string, unknown> = {}) {
    const response = await request('', 'POST', intake(overrides));
    expect(response.status, await response.clone().text()).toBe(201);
    return event(((await response.json()) as { event: { key: string } }).event.key);
  }
  async function responsibility(
    eventKey: string,
    area: string,
    patch: Record<string, unknown>,
    user = 'manager',
  ) {
    const detail = await event(eventKey, user);
    const row = detail.responsibilities.find((r) => r.area === area);
    if (!row) throw new Error(`Missing ${area}`);
    return request(
      `/${eventKey}/responsibilities/${row.responsibility_key}`,
      'PATCH',
      {
        expectedVersion: row.version,
        expectedFactsVersion: detail.factsVersion,
        ...patch,
      },
      user,
    );
  }
  return {
    env,
    db,
    request,
    event,
    create,
    responsibility,
    beforeNextBatch: (hook: () => void) => {
      batchHook = hook;
    },
  };
}

function intake(overrides: Record<string, unknown> = {}) {
  return eventIntakeSchema.parse({
    templateKey: 'standard',
    requestApprovalConfirmed: true,
    title: 'Synthetic event',
    purpose: 'Exercise accountable event responsibilities with synthetic data.',
    ministry: 'Synthetic ministry',
    ownerEmail: 'manager@example.test',
    campuses: ['Synthetic campus'],
    audience: 'Test participants',
    startDate: '2027-02-01',
    startTime: '18:00',
    endTime: '19:00',
    location: 'Synthetic room',
    registration: {
      required: false,
      url: null,
      openDate: null,
      closeDate: null,
      cost: null,
      capacity: null,
    },
    channels: [],
    languages: ['en'],
    operations: ['facilities', 'production'],
    recurrence: { kind: 'none', notes: '' },
    notes: '',
    ...overrides,
  });
}

legacyEvents('accountable event responsibilities with real migrated SQLite and handlers', () => {
  it('preserves the initial request and creates requested outcomes without a generated checklist', async () => {
    const f = fixture();
    const detail = await f.create({ channels: ['screens'] });
    expect(detail.workflowMode).toBe('responsibilities');
    expect(detail.workItems).toEqual([]);
    expect(detail.deliverables).toHaveLength(1);
    expect(detail.deliverables[0]?.owner_email).toBeNull();
    expect(detail.responsibilities.map((r) => r.area)).toEqual([
      'communications',
      'facilities',
      'production',
    ]);
    expect(
      detail.responsibilities.every(
        (r) => r.owner_email === null && r.status === 'awaiting_acknowledgment',
      ),
    ).toBe(true);
    const response = await f.request(`/${detail.key}/facts`, 'PATCH', {
      title: 'Revised event',
      expectedVersion: detail.version,
      changeReason: 'Synthetic title correction',
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const next = await f.event(detail.key);
    expect(next.facts.title).toBe('Revised event');
    expect(next.originalRequest?.title).toBe('Synthetic event');
    expect(next.factHistory).toHaveLength(2);
    expect(next.workItems).toEqual([]);
    expect(() =>
      f.db
        .prepare('UPDATE events SET original_request_json = ? WHERE event_key = ?')
        .run('{}', detail.key),
    ).toThrow('original_event_request_is_immutable');
  });

  it('limits owners to their responsibility tasks and retains task-assignee status updates', async () => {
    const f = fixture();
    const detail = await f.create();
    expect(
      (await f.responsibility(detail.key, 'facilities', { ownerEmail: 'facilities@example.test' }))
        .status,
    ).toBe(200);
    expect(
      (await f.responsibility(detail.key, 'production', { ownerEmail: 'production@example.test' }))
        .status,
    ).toBe(200);
    const next = await f.event(detail.key);
    const facilities = next.responsibilities.find((r) => r.area === 'facilities');
    const production = next.responsibilities.find((r) => r.area === 'production');
    const created = await f.request(
      `/${detail.key}/work-items`,
      'POST',
      {
        title: 'Arrange requested chairs',
        responsibilityKey: facilities?.responsibility_key,
        ownerEmail: 'viewer@example.test',
        critical: true,
      },
      'facilities',
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const key = ((await created.json()) as { workItem: { key: string } }).workItem.key;
    expect(
      (await f.request(`/${detail.key}/work-items/${key}`, 'PATCH', { responsibilityKey: null }))
        .status,
    ).toBe(400);
    expect(
      (
        await f.request(
          `/${detail.key}/work-items/${key}`,
          'PATCH',
          { title: 'Arrange 40 chairs' },
          'facilities',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          `/${detail.key}/work-items/${key}`,
          'PATCH',
          { title: 'Unauthorized edit' },
          'production',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          `/${detail.key}/work-items/${key}`,
          'PATCH',
          { responsibilityKey: production?.responsibility_key },
          'facilities',
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.request(`/${detail.key}/work-items/${key}`, 'PATCH', { status: 'done' }, 'viewer'))
        .status,
    ).toBe(200);
    expect(
      (
        await f.request(
          `/${detail.key}/work-items/${key}`,
          'PATCH',
          { title: 'Assignee cannot manage area' },
          'viewer',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          `/${detail.key}/work-items`,
          'POST',
          { title: 'Outside my area', responsibilityKey: production?.responsibility_key },
          'facilities',
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.request(`/${detail.key}/work-items`, 'POST', { title: 'No area' })).status,
    ).toBe(400);
    expect(
      (
        await f.responsibility(
          detail.key,
          'facilities',
          { ownerEmail: 'viewer@example.test' },
          'facilities',
        )
      ).status,
    ).toBe(403);
  });

  it('rejects cross-event responsibility links at API and database boundaries', async () => {
    const f = fixture();
    const first = await f.create();
    const second = await f.create();
    expect(
      (
        await f.request(`/${second.key}/work-items`, 'POST', {
          title: 'Invalid link',
          responsibilityKey: first.responsibilities[0]?.responsibility_key,
        })
      ).status,
    ).toBe(400);
    const eventId = (
      f.db.prepare('SELECT id FROM events WHERE event_key = ?').get(second.key) as { id: number }
    ).id;
    expect(() =>
      f.db
        .prepare(`INSERT INTO event_work_items (work_item_key, event_id, phase, title, responsibility_id)
      VALUES ('INVALID', ?, 'operations', 'Invalid direct link', ?)`)
        .run(eventId, first.responsibilities[0]?.id ?? 0),
    ).toThrow('responsibility_must_belong_to_event');
    expect((await f.request(`/${first.key}`, 'GET', undefined, 'external')).status).toBe(404);
    expect(
      (await f.responsibility(first.key, 'facilities', { ownerEmail: 'external@example.test' }))
        .status,
    ).toBe(400);
    expect(
      (await f.responsibility(first.key, 'facilities', { ownerEmail: 'inactive@example.test' }))
        .status,
    ).toBe(400);
  });

  it('requires current owner readiness, rejects stale reviews, and resets on reassignment or fact changes', async () => {
    const f = fixture();
    const detail = await f.create();
    expect((await f.responsibility(detail.key, 'facilities', { status: 'ready' })).status).toBe(
      400,
    );
    await f.responsibility(detail.key, 'facilities', { ownerEmail: 'facilities@example.test' });
    await f.responsibility(detail.key, 'production', { ownerEmail: 'production@example.test' });
    expect(
      (await f.responsibility(detail.key, 'facilities', { status: 'acknowledged' }, 'facilities'))
        .status,
    ).toBe(200);
    expect((await f.event(detail.key)).readiness).toBe('blocked');
    expect(
      (await f.responsibility(detail.key, 'facilities', { status: 'ready' }, 'facilities')).status,
    ).toBe(200);
    expect(
      (await f.responsibility(detail.key, 'production', { status: 'ready' }, 'production')).status,
    ).toBe(200);
    const ready = await f.event(detail.key);
    expect(ready.readiness).toBe('ready');
    expect(ready.progress).toBe(100);
    const list = (await (await f.request('')).json()) as {
      events: Array<{ key: string; readiness: string; blockers: number }>;
    };
    expect(list.events.find((e) => e.key === detail.key)).toMatchObject({
      readiness: 'ready',
      blockers: 0,
    });
    const stale = ready.responsibilities[0];
    const changed = await f.request(`/${detail.key}/facts`, 'PATCH', {
      location: 'Different synthetic room',
      expectedVersion: ready.version,
      changeReason: 'Moved rooms',
    });
    expect(changed.status, await changed.clone().text()).toBe(200);
    expect(
      (await f.event(detail.key)).responsibilities.every(
        (r) => r.status === 'awaiting_acknowledgment',
      ),
    ).toBe(true);
    expect(
      (
        await f.request(`/${detail.key}/responsibilities/${stale?.responsibility_key}`, 'PATCH', {
          expectedVersion: stale?.version,
          expectedFactsVersion: ready.factsVersion,
          status: 'ready',
        })
      ).status,
    ).toBe(409);
    expect((await f.event(detail.key)).readiness).toBe('blocked');
    await f.responsibility(detail.key, 'facilities', { status: 'ready' }, 'facilities');
    await f.responsibility(detail.key, 'facilities', {
      ownerEmail: 'viewer@example.test',
      status: 'ready',
    });
    expect(
      (await f.event(detail.key)).responsibilities.find((r) => r.area === 'facilities')?.status,
    ).toBe('awaiting_acknowledgment');
  });

  it('preserves legacy work through explicit, idempotent conversion and adoption', async () => {
    const f = fixture();
    const detail = await f.create();
    f.db.prepare("UPDATE events SET workflow_mode = 'legacy' WHERE event_key = ?").run(detail.key);
    const eventId = (
      f.db.prepare('SELECT id FROM events WHERE event_key = ?').get(detail.key) as { id: number }
    ).id;
    f.db.prepare('DELETE FROM event_responsibilities WHERE event_id = ?').run(eventId);
    f.db
      .prepare(`INSERT INTO event_work_items (work_item_key, event_id, phase, title, critical, source_metadata_json)
      VALUES ('LEGACY', ?, 'intake', 'Keep exact legacy title', 1, '{"planKey":"facts"}')`)
      .run(eventId);
    const response = await f.request(`/${detail.key}/responsibility-workflow`, 'POST');
    expect(response.status, await response.clone().text()).toBe(200);
    await f.request(`/${detail.key}/responsibility-workflow`, 'POST');
    const converted = await f.event(detail.key);
    expect(converted.workItems[0]).toMatchObject({
      title: 'Keep exact legacy title',
      status: 'not_started',
      legacy: true,
    });
    expect(converted.responsibilities).toHaveLength(2);
    const activity = f.db
      .prepare(
        "SELECT COUNT(*) AS count FROM event_activity WHERE action = 'event.workflow_converted'",
      )
      .get() as { count: number };
    expect(activity.count).toBe(1);
    await f.responsibility(detail.key, 'facilities', {
      status: 'not_needed',
      notes: 'No facility work after review',
    });
    await f.responsibility(detail.key, 'production', {
      status: 'not_needed',
      notes: 'No production work after review',
    });
    expect((await f.event(detail.key)).readiness).toBe('ready');
    expect(
      (
        await f.request(`/${detail.key}/work-items/LEGACY`, 'PATCH', {
          responsibilityKey: converted.responsibilities[0]?.responsibility_key,
        })
      ).status,
    ).toBe(200);
    expect((await f.event(detail.key)).readiness).toBe('blocked');
    const beforeFacts = await f.event(detail.key);
    await f.request(`/${detail.key}/facts`, 'PATCH', {
      title: 'Updated after conversion',
      expectedVersion: beforeFacts.version,
      changeReason: 'Synthetic edit',
    });
    expect((await f.event(detail.key)).workItems[0]?.title).toBe('Keep exact legacy title');
  });

  it('checks readiness inside the stage/approval transaction when a blocker races the review', async () => {
    const f = fixture();
    const detail = await f.create();
    for (const row of detail.responsibilities)
      await f.responsibility(detail.key, row.area, {
        status: 'not_needed',
        notes: 'Synthetic area exemption',
      });
    const ready = await f.event(detail.key);
    const blockArea = () => {
      f.db
        .prepare(
          "UPDATE event_responsibilities SET status = 'awaiting_acknowledgment' WHERE id = ?",
        )
        .run(ready.responsibilities[0]?.id ?? 0);
    };
    f.beforeNextBatch(blockArea);
    const stage = await f.request(`/${detail.key}/stage`, 'PATCH', {
      stage: 'event_ready',
      expectedVersion: ready.version,
      reason: 'Synthetic race',
    });
    expect(stage.status, await stage.clone().text()).toBe(409);
    expect(
      f.db
        .prepare(
          "SELECT COUNT(*) AS count FROM event_activity WHERE action = 'event.stage_changed'",
        )
        .get(),
    ).toMatchObject({ count: 0 });
    await f.responsibility(detail.key, ready.responsibilities[0]?.area ?? '', {
      status: 'not_needed',
      notes: 'Synthetic exemption',
    });
    const eventId = (
      f.db.prepare('SELECT id FROM events WHERE event_key = ?').get(detail.key) as { id: number }
    ).id;
    f.beforeNextBatch(blockArea);
    const approval = await f.request(`/${detail.key}/approvals`, 'POST', {
      subjectType: 'event',
      subjectId: eventId,
      subjectVersion: ready.version,
      scope: 'event_ready',
      decision: 'approved',
      comment: '',
    });
    expect(approval.status, await approval.clone().text()).toBe(409);
    expect(f.db.prepare('SELECT COUNT(*) AS count FROM event_approvals').get()).toMatchObject({
      count: 0,
    });
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS count FROM event_activity WHERE action = 'approval.recorded'")
        .get(),
    ).toMatchObject({ count: 0 });
  });

  it('combines required deliverables and explicitly required tasks with responsibility readiness', async () => {
    const f = fixture();
    const detail = await f.create({ channels: ['screens'] });
    for (const row of detail.responsibilities)
      await f.responsibility(detail.key, row.area, {
        status: 'not_needed',
        notes: 'No area work remaining',
      });
    expect((await f.event(detail.key)).blockerCount).toBe(1);
    f.db.prepare("UPDATE event_deliverables SET status = 'approved'").run();
    expect((await f.event(detail.key)).readiness).toBe('ready');
    await f.responsibility(detail.key, 'facilities', { ownerEmail: 'facilities@example.test' });
    const row = (await f.event(detail.key)).responsibilities.find((r) => r.area === 'facilities');
    await f.request(
      `/${detail.key}/work-items`,
      'POST',
      { title: 'Required room check', critical: true, responsibilityKey: row?.responsibility_key },
      'facilities',
    );
    await f.responsibility(detail.key, 'facilities', { status: 'ready' }, 'facilities');
    expect((await f.event(detail.key)).blockerCount).toBe(1);
    f.db.prepare("UPDATE event_work_items SET status = 'done'").run();
    expect((await f.event(detail.key)).readiness).toBe('ready');
    f.db
      .prepare("UPDATE users SET status = 'disabled' WHERE email = 'facilities@example.test'")
      .run();
    expect((await f.event(detail.key)).readiness).toBe('blocked');
    f.db.prepare("UPDATE event_deliverables SET status = 'not_requested'").run();
    const list = (await (await f.request('')).json()) as {
      events: Array<{ key: string; blockers: number }>;
    };
    expect(list.events.find((e) => e.key === detail.key)?.blockers).toBe(
      (await f.event(detail.key)).blockerCount,
    );
  });

  it('supports every non-communications area, blocker reasons and explicit exemptions', async () => {
    const f = fixture();
    const detail = await f.create({
      operations: ['food', 'volunteers', 'transportation', 'vendors'],
      registration: {
        ...intake().registration,
        required: true,
        cost: 25,
        accountCode: 'TEST',
        url: 'https://example.test/register',
      },
    });
    expect(detail.responsibilities.map((r) => r.area)).toEqual([
      'registration',
      'finance',
      'hospitality',
      'volunteers',
      'transportation',
      'other',
    ]);
    expect(
      (await f.request(`/${detail.key}/responsibilities`, 'POST', { area: 'safety_childcare' }))
        .status,
    ).toBe(200);
    expect(
      (await f.request(`/${detail.key}/responsibilities`, 'POST', { area: 'safety_childcare' }))
        .status,
    ).toBe(409);
    expect(
      (await f.request(`/${detail.key}/responsibilities`, 'POST', { area: 'facilities' }, 'viewer'))
        .status,
    ).toBe(403);
    expect((await f.responsibility(detail.key, 'finance', { status: 'not_needed' })).status).toBe(
      400,
    );
    expect(
      (
        await f.responsibility(detail.key, 'finance', {
          status: 'not_needed',
          notes: 'Handled under the event budget',
        })
      ).status,
    ).toBe(200);
    await f.responsibility(detail.key, 'hospitality', { ownerEmail: 'facilities@example.test' });
    expect(
      (
        await f.responsibility(
          detail.key,
          'hospitality',
          { status: 'blocked', notes: 'Need approved food quantities' },
          'facilities',
        )
      ).status,
    ).toBe(200);
    expect((await f.event(detail.key)).readiness).toBe('blocked');
  });

  it('holds the event-ready stage and approval while requirements remain', async () => {
    const f = fixture();
    const detail = await f.create({ requestApprovalConfirmed: false });
    for (const row of detail.responsibilities)
      await f.responsibility(detail.key, row.area, {
        status: 'not_needed',
        notes: 'No area work needed',
      });
    expect((await f.event(detail.key)).blockerCount).toBe(1);
    expect(
      (
        await f.request(`/${detail.key}/stage`, 'PATCH', {
          stage: 'event_ready',
          expectedVersion: detail.version,
          reason: 'Synthetic gate test',
        })
      ).status,
    ).toBe(409);
    const eventId = (
      f.db.prepare('SELECT id FROM events WHERE event_key = ?').get(detail.key) as { id: number }
    ).id;
    expect(
      (
        await f.request(`/${detail.key}/approvals`, 'POST', {
          subjectType: 'event',
          subjectId: eventId,
          subjectVersion: detail.version,
          scope: 'event_ready',
          decision: 'approved',
          comment: '',
        })
      ).status,
    ).toBe(409);
  });
});

describe('populated legacy migration', () => {
  it('backfills earliest request evidence without altering work, assignments, or dependencies', () => {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const migrations = readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const migration of migrations.filter((name) => name < '0019'))
      db.exec(readFileSync(join(migrationsDirectory, migration), 'utf8'));
    db.exec(`INSERT INTO users (id, email, first_name, last_name, status) VALUES (900, 'legacy@example.test', 'Legacy', 'Synthetic', 'active');
      INSERT INTO events (id, event_key, seq, workspace_id, template_version_id, title, created_by_user_id, start_at, facts_version)
        SELECT 900, 'LEGACY-EVENT', 900, w.id, tv.id, 'Current title', 900, '2027-02-01T18:00:00', 2
        FROM workspaces w, event_workflow_template_versions tv ORDER BY w.id LIMIT 1;
      INSERT INTO event_fact_versions (event_id, version, facts_json) VALUES (900, 1, '{"title":"Initial title"}'), (900, 2, '{"title":"Current title"}');
      INSERT INTO event_work_items (id, work_item_key, event_id, phase, title, status, owner_user_id, critical, source_metadata_json)
        VALUES (900, 'LEGACY-DONE', 900, 'copy', 'Completed historical work', 'done', 900, 1, '{"planKey":"copy-en"}'),
        (901, 'LEGACY-OPEN', 900, 'operations', 'Open historical work', 'blocked', 900, 1, '{"planKey":"readiness"}');
      INSERT INTO event_work_item_dependencies VALUES (901, 900, '2026-10-28T00:00:00Z');`);
    const before = db.prepare('SELECT * FROM event_work_items ORDER BY id').all();
    db.exec(readFileSync(join(migrationsDirectory, '0019_event_responsibilities.sql'), 'utf8'));
    expect(
      db
        .prepare(
          'SELECT workflow_mode, original_request_json, original_request_kind FROM events WHERE id = 900',
        )
        .get(),
    ).toMatchObject({
      workflow_mode: 'legacy',
      original_request_json: '{"title":"Initial title"}',
      original_request_kind: 'earliest_saved_facts',
    });
    const after = db.prepare('SELECT * FROM event_work_items ORDER BY id').all();
    expect(
      after.map(({ responsibility_id, ...row }) => {
        expect(responsibility_id).toBeNull();
        return row;
      }),
    ).toEqual(before);
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM event_work_item_dependencies').get(),
    ).toMatchObject({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
