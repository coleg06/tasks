/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TenantProfile, tenantProfile } from '../shared/tenant-profile';
import { app } from '../src/app';
import { signSession } from '../src/auth/session';
import type { Env } from '../src/env';
import worker from '../src/index';
import { runScheduledJob, scheduledJobs } from '../src/platform/jobs';
import { Scheduler } from '../src/platform/scheduler';
import { tenantRuntimeAdapters as runtimeAdapters } from '../src/runtime/tenant-adapters';
import { effectiveMigrationsDirectory } from './support/migrations';
import { testOrigins } from './support/origins';

// Overlays replace the adapter module and its interface, so address the optional method structurally.
const tenantRuntimeAdapters = runtimeAdapters as typeof runtimeAdapters & {
  verifyTenantConfigurationFresh: (env: Env) => Promise<boolean>;
};

import { tenantConfigurationMatches } from '../src/tenancy/configuration';

// Fictional, generated data only. Tenants deploy separate databases, not rows in
// a shared database. Deliberately reuse user IDs and task keys in both databases.
const foreignProfile: TenantProfile = {
  ...tenantProfile,
  key: 'example-tenant',
  organizationName: 'Example Organization',
  workspaceKey: 'example-workspace',
  defaultProjectKey: 'OPS',
  defaultProjectName: 'Operations',
  defaultProjectDescription: 'Example organization tasks',
  identity: { ...tenantProfile.identity, initialAdminEmail: 'admin@example.test' },
  agent: { ...tenantProfile.agent, name: 'Automation', email: 'agent@example.test' },
};

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

function migratedDatabase(profile = tenantProfile) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  for (const name of readdirSync(effectiveMigrationsDirectory())
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const source = readFileSync(join(effectiveMigrationsDirectory(), name), 'utf8');
    // Fresh downstreams overlay only the non-secret 0017 seed before migration.
    const sql =
      name === '0017_tenant_configuration.sql' && profile !== tenantProfile
        ? source.replace(
            `  1, 'default', 'Team', 'default',
  'TASKS', 'Tasks', 'Default project',
  '', 'Agent', 'agent@tasks.invalid'`,
            `  1, 'example-tenant', 'Example Organization', 'example-workspace',
  'OPS', 'Operations', 'Example organization tasks',
  'admin@example.test', 'Automation', 'agent@example.test'`,
          )
        : source;
    database.exec(sql);
  }
  database.exec(`
    INSERT INTO users (email, first_name) VALUES ('person@example.org', 'Synthetic User');
    INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
      SELECT u.id, p.key FROM users u JOIN permissions p WHERE u.email = 'person@example.org';
    INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
      SELECT w.id, u.id, 'owner' FROM workspaces w JOIN users u
      WHERE u.email = 'person@example.org';
  `);
  database
    .prepare(
      `INSERT INTO tasks (task_key, seq, title, created_by_user_id, sort_key, workspace_id, project_id)
       SELECT 'TASK-ISOLATION', 100500, 'Synthetic private task', u.id, 'a0', p.workspace_id, p.id
       FROM users u JOIN projects p WHERE u.email = 'person@example.org' AND p.project_key = ?`,
    )
    .run(profile.defaultProjectKey);
  expect(database.prepare('SELECT count(*) AS count FROM tasks').get()).toEqual({ count: 1 });
  return database;
}

// Execute actual SQL. Trace all prepared statements so rejected requests must
// prove they read only the non-secret identity row and perform zero writes.
function databaseBinding(current: () => DatabaseSync, queries: string[]) {
  function prepare(sql: string) {
    queries.push(sql);
    const statement = current().prepare(sql);
    let values: SQLInputValue[] = [];
    const result = {
      bind(...input: SQLInputValue[]) {
        values = input;
        return result;
      },
      async first() {
        return statement.get(...values) ?? null;
      },
      async all() {
        return { success: true, results: statement.all(...values) };
      },
      execute() {
        if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
          return { success: true, meta: { changes: 0 }, results: statement.all(...values) };
        }
        const info = statement.run(...values);
        return { success: true, meta: { changes: Number(info.changes) }, results: [] };
      },
      async run() {
        return result.execute();
      },
    };
    return result;
  }
  return {
    prepare,
    async batch(statements: Array<ReturnType<typeof prepare>>) {
      const database = current();
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
  } as unknown as D1Database;
}

function environment(current: () => DatabaseSync, queries: string[]) {
  return {
    DB: databaseBinding(current, queries),
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    EVENT_ASSETS: { get: vi.fn(), put: vi.fn() },
    ENVIRONMENT: 'dev',
    RELEASE_SHA: 'isolation-test',
    GOOGLE_CLIENT_ID: 'synthetic-client',
    GOOGLE_CLIENT_SECRET: 'synthetic-secret',
    SESSION_SECRET: 'synthetic-session-secret-for-isolation-tests',
    // The MCP and agent routes only reach the tenant gate when the hosted MCP server is on.
    TASKS_MCP_ENABLED: 'true',
  } as unknown as Env;
}

async function browserHeaders(env: Env) {
  const token = await signSession(env, { id: 2, email: 'person@example.org' }, [
    'tasks.view',
    'tasks.manage',
    'tasks.comment',
  ]);
  const csrf = 'synthetic-csrf-proof-at-least-32-characters';
  return {
    Cookie: `tasks_session=${token}; tasks_csrf=${csrf}`,
    Origin: testOrigins.development,
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json',
  };
}

function onlyIdentityQueries(queries: string[]) {
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    expect(query).toMatch(/^\s*SELECT\b/);
    expect(query).toContain('FROM tenant_configuration WHERE id = 1');
  }
}

describe.runIf(tenantProfile.tasks.apiMode === 'legacy')('deployment tenant isolation', () => {
  it('matches each isolated database only to its own profile in both directions', async () => {
    const own = migratedDatabase();
    const foreign = migratedDatabase(foreignProfile);
    const ownEnv = environment(() => own, []);
    const foreignEnv = environment(() => foreign, []);
    expect(await tenantConfigurationMatches(ownEnv, tenantProfile)).toBe(true);
    expect(await tenantConfigurationMatches(foreignEnv, foreignProfile)).toBe(true);
    expect(await tenantConfigurationMatches(ownEnv, foreignProfile)).toBe(false);
    expect(await tenantConfigurationMatches(foreignEnv, tenantProfile)).toBe(false);
  });

  it('denies cross-tenant reads and writes before any domain, audit, integration or auth access', async () => {
    const foreign = migratedDatabase(foreignProfile);
    const queries: string[] = [];
    const env = environment(() => foreign, queries);
    const headers = await browserHeaders(env);
    const before = foreign.prepare('SELECT total_changes() AS count').get();
    const requests: Array<[string, string]> = [
      ['GET', '/api/tasks'],
      ['GET', '/api/tasks/TASK-ISOLATION'],
      ['POST', '/api/tasks'],
      ['PATCH', '/api/tasks/TASK-ISOLATION'],
      ['POST', '/api/tasks/TASK-ISOLATION/comments'],
      ['DELETE', '/api/tasks/TASK-ISOLATION/comments/1'],
      ['GET', '/api/projects/IT/assignees'],
      ['PUT', '/api/projects/IT/members'],
      ['GET', '/api/bootstrap'],
      ['GET', '/api/admin'],
      ['GET', '/api/events'],
      ['GET', '/api/events/EVT-1/assets/1/download'],
      ['POST', '/api/events/EVT-1/deliverables/1/assets/upload'],
      ['POST', '/api/integrations/portal/support-tickets'],
      ['POST', '/api/telemetry/client-error'],
      ['GET', '/api/mobile/v1/tasks'],
      ['POST', '/api/mobile/v1/tasks'],
      ['GET', '/api/agent/v1/tasks'],
      ['POST', '/api/agent/v1/tasks'],
      ['POST', '/mcp'],
      ['GET', '/auth/login'],
      ['GET', '/auth/callback?code=synthetic&state=synthetic'],
      ['POST', '/auth/logout'],
    ];
    for (const [method, path] of requests) {
      const response = await app.request(
        `${testOrigins.development}${path}`,
        { method, headers, ...(method === 'GET' ? {} : { body: '{}' }) },
        env,
      );
      expect(response.status, `${method} ${path}`).toBe(503);
      expect(await response.json()).toEqual({ error: 'tenant_configuration_mismatch' });
    }
    onlyIdentityQueries(queries);
    expect(foreign.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
    expect(env.EVENT_ASSETS.get).not.toHaveBeenCalled();
    expect(env.EVENT_ASSETS.put).not.toHaveBeenCalled();
  });

  it('rechecks the same binding after a successful request and recovers after correction', async () => {
    const own = migratedDatabase();
    const foreign = migratedDatabase(foreignProfile);
    let current = own;
    const queries: string[] = [];
    const env = environment(() => current, queries);
    const headers = await browserHeaders(env);
    const read = () => app.request(`${testOrigins.development}/api/tasks`, { headers }, env);
    expect((await read()).status).toBe(200);
    queries.length = 0;
    current = foreign;
    expect((await read()).status).toBe(503);
    const write = await app.request(
      `${testOrigins.development}/api/tasks/TASK-ISOLATION`,
      { method: 'PATCH', headers, body: JSON.stringify({ title: 'Forbidden change' }) },
      env,
    );
    expect(write.status).toBe(503);
    onlyIdentityQueries(queries);
    current = own;
    expect((await read()).status).toBe(200);
  });

  it.each(['0 13 * * *', '*/5 * * * *'])(
    'denies scheduled reads, notifications and retention writes for %s',
    async (cron) => {
      const foreign = migratedDatabase(foreignProfile);
      const queries: string[] = [];
      const env = environment(() => foreign, queries);
      const pending: Promise<unknown>[] = [];
      const before = foreign.prepare('SELECT total_changes() AS count').get();
      await worker.scheduled(
        { cron, scheduledTime: Date.now() } as ScheduledController,
        { ...env, ENVIRONMENT: 'production' },
        {
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
        } as unknown as ExecutionContext,
      );
      expect(pending.length).toBeGreaterThan(0);
      for (const result of await Promise.allSettled(pending)) {
        expect(result.status).toBe('rejected');
        expect((result as PromiseRejectedResult).reason).toEqual(
          new Error('tenant_configuration_mismatch'),
        );
      }
      onlyIdentityQueries(queries);
      expect(foreign.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    },
  );

  async function runWorkerCron(env: Env, cron: string) {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({ cron, scheduledTime: Date.now() } as ScheduledController, env, {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    } as unknown as ExecutionContext);
    return Promise.allSettled(pending);
  }

  it('verifies freshly before every scheduled run on the Worker, including after a tenant change', async () => {
    const own = migratedDatabase();
    const foreign = migratedDatabase(foreignProfile);
    for (const database of [own, foreign]) {
      database.exec(`INSERT INTO operational_events (severity, event, source, message, created_at)
        VALUES ('error', 'synthetic.old', 'test', 'Synthetic old event', '2000-01-01T00:00:00Z')`);
    }
    let current = own;
    const queries: string[] = [];
    const env = environment(() => current, queries);
    const first = await runWorkerCron(env, '0 13 * * *');
    expect(first.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(own.prepare('SELECT count(*) AS count FROM operational_events').get()).toEqual({
      count: 0,
    });

    // Same binding object, different database behind it: the second run must notice.
    current = foreign;
    const mark = queries.length;
    const foreignChanges = foreign.prepare('SELECT total_changes() AS count').get();
    const second = await runWorkerCron(env, '0 13 * * *');
    expect(second.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    onlyIdentityQueries(queries.slice(mark));
    expect(foreign.prepare('SELECT total_changes() AS count').get()).toEqual(foreignChanges);
    expect(foreign.prepare('SELECT count(*) AS count FROM operational_events').get()).toEqual({
      count: 1,
    });
  });

  it('runs no job and writes nothing when the fresh check throws, preferring the fresh method', async () => {
    const own = migratedDatabase();
    const queries: string[] = [];
    const env = environment(() => own, queries);
    const cached = vi.spyOn(tenantRuntimeAdapters, 'verifyTenantConfiguration');
    const fresh = vi
      .spyOn(tenantRuntimeAdapters, 'verifyTenantConfigurationFresh')
      .mockRejectedValue(new Error('identity store unavailable'));
    const before = own.prepare('SELECT total_changes() AS count').get();
    const results = await runWorkerCron(env, '*/5 * * * *');
    expect(results.map((result) => result.status)).toEqual(['rejected']);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(cached).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
    expect(own.prepare('SELECT total_changes() AS count').get()).toEqual(before);
  });

  it('falls back to the normal check for adapters without a fresh method', async () => {
    const own = migratedDatabase();
    const env = environment(() => own, []);
    const adapters = tenantRuntimeAdapters as { verifyTenantConfigurationFresh?: unknown };
    const fresh = adapters.verifyTenantConfigurationFresh;
    adapters.verifyTenantConfigurationFresh = undefined;
    try {
      const cached = vi.spyOn(tenantRuntimeAdapters, 'verifyTenantConfiguration');
      const results = await runWorkerCron(env, '*/5 * * * *');
      expect(cached).toHaveBeenCalledTimes(1);
      expect(results.map((result) => result.status)).toEqual(['fulfilled']);
    } finally {
      adapters.verifyTenantConfigurationFresh = fresh;
    }
  });

  it('applies the same fresh verification in the self-hosted scheduler', async () => {
    const own = migratedDatabase();
    const foreign = migratedDatabase(foreignProfile);
    for (const database of [own, foreign]) {
      database.exec(`INSERT INTO operational_events (severity, event, source, message, created_at)
        VALUES ('error', 'synthetic.old', 'test', 'Synthetic old event', '2000-01-01T00:00:00Z')`);
    }
    let current = own;
    const queries: string[] = [];
    const env = environment(() => current, queries);
    const failures: string[] = [];
    const scheduler = new Scheduler<Env>({
      jobs: scheduledJobs.jobs,
      env,
      run: runScheduledJob,
      onFailure: (job, error) => {
        failures.push(`${job.name}:${error instanceof Error ? error.message : error}`);
      },
    });
    const daily = Date.UTC(2026, 10, 2, 13, 0, 0);
    await Promise.all(scheduler.tick(daily));
    expect(failures).toEqual([]);
    expect(own.prepare('SELECT count(*) AS count FROM operational_events').get()).toEqual({
      count: 0,
    });

    current = foreign;
    const mark = queries.length;
    const foreignChanges = foreign.prepare('SELECT total_changes() AS count').get();
    await Promise.all(scheduler.tick(daily + 86_400_000));
    expect(failures.sort()).toEqual([
      'deadline_notifications:tenant_configuration_mismatch',
      'operational_log_retention:tenant_configuration_mismatch',
      'portal_alert_retry:tenant_configuration_mismatch',
    ]);
    onlyIdentityQueries(queries.slice(mark));
    expect(foreign.prepare('SELECT total_changes() AS count').get()).toEqual(foreignChanges);
  });

  it('runs the matching dev scheduled jobs and retains their normal effects', async () => {
    const own = migratedDatabase();
    own.exec(`INSERT INTO operational_events (severity, event, source, message, created_at)
      VALUES ('error', 'synthetic.old', 'test', 'Synthetic old event', '2000-01-01T00:00:00Z')`);
    const env = environment(() => own, []);
    const pending: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: '0 13 * * *', scheduledTime: Date.now() } as ScheduledController,
      env,
      {
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
        passThroughOnException() {},
      } as ExecutionContext,
    );
    await Promise.all(pending);
    expect(pending).toHaveLength(2);
    expect(own.prepare('SELECT count(*) AS count FROM operational_events').get()).toEqual({
      count: 0,
    });
  });

  it('fails unavailable metadata closed without logging into the unverified database', async () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    const queries: string[] = [];
    const env = environment(() => database, queries);
    for (const path of ['/readyz', '/api/tasks', '/auth/login', '/mcp']) {
      const response = await app.request(`${testOrigins.development}${path}`, {}, env);
      expect(response.status).toBe(503);
    }
    onlyIdentityQueries(queries);
  });

  it('rejects a foreign issuer even with overlapping user IDs and the same synthetic signing key', async () => {
    const own = migratedDatabase();
    const queries: string[] = [];
    const env = environment(() => own, queries);
    const token = await new SignJWT({ email: 'person@example.org', perms: ['tasks.manage'] })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('2')
      .setIssuer('example-tenant-tasks')
      .setAudience('example-tenant-tasks')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(env.SESSION_SECRET));
    const response = await app.request(
      `${testOrigins.development}/api/tasks`,
      { headers: { Cookie: `tasks_session=${token}` } },
      env,
    );
    expect(response.status).toBe(401);
    onlyIdentityQueries(queries);
  });
});
