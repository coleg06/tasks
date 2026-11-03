/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import type { Env } from '../src/env';
import {
  createTask,
  listProjectAssignees,
  type TaskAppEnv,
  type TaskIdentity,
  updateTask,
} from '../src/tasks/api';
import { effectiveMigrationsDirectory } from './support/migrations';
import { testOrigins } from './support/origins';

const agent = { name: tenantProfile.agent.name, email: tenantProfile.agent.email };
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

function d1Adapter(database: DatabaseSync, extraTaskUpdateChanges = 0) {
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
        // Real D1 counts trigger and FTS writes in meta.changes.
        meta: {
          changes:
            Number(result.changes) +
            (/^\s*UPDATE\s+tasks\b/i.test(sql) ? extraTaskUpdateChanges : 0),
        },
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

describe('Agent assignee API regression', () => {
  it('returns the migration-seeded Agent from a shared project assignee path', async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO users (email, first_name, last_name, status)
      VALUES ('admin@example.org', 'Alex', 'Admin', 'active');

      INSERT INTO user_permissions (user_id, permission_key)
      SELECT id, 'tasks.view' FROM users WHERE email = 'admin@example.org';

      INSERT INTO workspace_members (workspace_id, user_id, role)
      SELECT w.id, u.id, 'owner'
      FROM workspaces w
      JOIN users u ON u.email = 'admin@example.org'
      WHERE w.workspace_key = '${tenantProfile.workspaceKey}';
    `);

    const seededPrincipal = database
      .prepare(
        'SELECT email, first_name AS name, status, principal_type FROM users WHERE email = ?',
      )
      .get(agent.email);
    expect(seededPrincipal).toMatchObject({
      ...agent,
      principal_type: 'agent',
      status: 'active',
    });

    const env = {
      ASSETS: { fetch: async () => new Response('asset') },
      DB: d1Adapter(database),
      ENVIRONMENT: 'test',
    } as unknown as Env;
    const human = database
      .prepare('SELECT id, email, status FROM users WHERE email = ?')
      .get('admin@example.org') as { id: number; email: string; status: string };
    const identity = {
      session: {
        sub: String(human.id),
        email: human.email,
        perms: ['tasks.view'],
        exp: Math.floor(Date.now() / 1000) + 60,
      },
      user: human,
      auditUserId: human.id,
    } satisfies TaskIdentity;
    const assigneeApi = new Hono<TaskAppEnv>();
    assigneeApi.use('*', async (context, next) => {
      context.set('taskIdentity', identity);
      await next();
    });
    assigneeApi.get('/api/projects/:projectKey/assignees', listProjectAssignees);

    const response = await assigneeApi.request(
      `${testOrigins.production}/api/projects/${tenantProfile.defaultProjectKey}/assignees`,
      {},
      env,
    );
    database.close();

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { assignees: Array<typeof agent> };
    expect(payload.assignees).toContainEqual(agent);
  });

  it.each([0, 2])(
    'persists Agent assignment through the real create and patch handlers (%i extra D1 trigger changes)',
    async (extraChanges) => {
      const database = migratedDatabase();
      const humanEmail = tenantProfile.identity.initialAdminEmail;
      database
        .prepare('INSERT INTO users (email, first_name, last_name, status) VALUES (?, ?, ?, ?)')
        .run(humanEmail, 'Alex', 'Admin', 'active');
      const human = database
        .prepare('SELECT id, email, status FROM users WHERE email = ?')
        .get(humanEmail) as { id: number; email: string; status: string };
      database
        .prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, ?)')
        .run(human.id, 'tasks.view');
      database
        .prepare('INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, ?)')
        .run(human.id, 'tasks.comment');
      const workspace = database
        .prepare('SELECT id FROM workspaces WHERE workspace_key = ?')
        .get(tenantProfile.workspaceKey) as { id: number };
      database
        .prepare('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)')
        .run(workspace.id, human.id, 'owner');

      const env = {
        ASSETS: { fetch: async () => new Response('asset') },
        DB: d1Adapter(database, extraChanges),
        ENVIRONMENT: 'test',
      } as unknown as Env;
      const identity = {
        session: {
          sub: String(human.id),
          email: human.email,
          perms: ['tasks.view'],
          exp: Math.floor(Date.now() / 1000) + 60,
        },
        user: human,
        auditUserId: human.id,
      } satisfies TaskIdentity;
      const taskApi = new Hono<TaskAppEnv>();
      taskApi.use('*', async (context, next) => {
        context.set('taskIdentity', identity);
        context.set('requestId', 'agent-assignee-api-regression');
        await next();
      });
      taskApi.post('/api/tasks', createTask);
      taskApi.patch('/api/tasks/:taskKey', updateTask);

      const pending: Promise<unknown>[] = [];
      const executionContext = {
        passThroughOnException() {},
        waitUntil(promise: Promise<unknown>) {
          pending.push(promise);
        },
      } as ExecutionContext;
      const create = async (title: string, assigneeEmail: string | null, mutationKey: string) =>
        taskApi.request(
          `${testOrigins.production}/api/tasks`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mutationKey,
              title,
              description: '',
              status: 'not_started',
              priority: null,
              effort: null,
              assigneeEmail,
              dueDate: null,
              projectKey: tenantProfile.defaultProjectKey,
              taskTypes: [],
            }),
          },
          env,
          executionContext,
        );

      const createAssignedResponse = await create(
        'Created for Agent',
        agent.email,
        '00000000-0000-4000-8000-000000000186',
      );
      expect(createAssignedResponse.status).toBe(201);
      const createAssignedPayload = (await createAssignedResponse.json()) as {
        task: { key: string; assignee: typeof agent | null };
      };
      expect(createAssignedPayload.task.assignee).toEqual(agent);
      expect(
        database
          .prepare(
            `SELECT u.email FROM tasks t
           LEFT JOIN users u ON u.id = t.assignee_user_id
           WHERE t.task_key = ?`,
          )
          .get(createAssignedPayload.task.key),
      ).toEqual({ email: agent.email });

      const createUnassignedResponse = await create(
        'Patch for Agent',
        null,
        '00000000-0000-4000-8000-000000000187',
      );
      expect(createUnassignedResponse.status).toBe(201);
      const createUnassignedPayload = (await createUnassignedResponse.json()) as {
        task: { key: string; assignee: typeof agent | null };
      };
      expect(createUnassignedPayload.task.assignee).toBeNull();

      const patchResponse = await taskApi.request(
        `${testOrigins.production}/api/tasks/${createUnassignedPayload.task.key}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assigneeEmail: agent.email }),
        },
        env,
        executionContext,
      );
      expect(patchResponse.status).toBe(200);
      const patchPayload = (await patchResponse.json()) as {
        task: { key: string; assignee: typeof agent | null; version: number };
      };
      expect(patchPayload.task).toMatchObject({
        key: createUnassignedPayload.task.key,
        assignee: agent,
        version: 2,
      });
      expect(
        database
          .prepare(
            `SELECT u.email FROM tasks t
           LEFT JOIN users u ON u.id = t.assignee_user_id
           WHERE t.task_key = ?`,
          )
          .get(createUnassignedPayload.task.key),
      ).toEqual({ email: agent.email });

      await Promise.all(pending);
      database.close();
    },
  );
});
