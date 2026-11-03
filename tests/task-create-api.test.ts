import { describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { app } from '../src/app';
import { signSession } from '../src/auth/session';
import type { Env } from '../src/env';
import { testOrigins } from './support/origins';
import {
  isTenantConfigurationQuery,
  matchingTenantConfigurationRow,
} from './tenant-configuration-fixture';

type FakeStatement = {
  sql: string;
  values: unknown[];
  bind: (...values: unknown[]) => FakeStatement;
  first: () => Promise<unknown>;
  all: () => Promise<{ results: unknown[] }>;
};

describe('task creation API reliability', () => {
  it('returns the row read inside the write batch when a separate read would be stale', async () => {
    const prepare = vi.fn((sql: string) => {
      const statement: FakeStatement = {
        sql,
        values: [] as unknown[],
        bind: (...values: unknown[]) => {
          statement.values = values;
          return statement;
        },
        first: vi.fn(async () => {
          if (isTenantConfigurationQuery(sql)) return matchingTenantConfigurationRow;
          if (sql.includes('FROM users WHERE id = ?')) {
            return { id: 6, email: 'owner2@example.org', status: 'active' };
          }
          if (sql.includes('SELECT 1 AS allowed FROM effective_user_permissions'))
            return { allowed: 1 };
          if (sql.includes('SELECT p.id, p.workspace_id, p.project_key')) {
            return {
              id: 1,
              workspace_id: 1,
              project_key: 'IT',
              project_type: 'shared',
              personal_owner_user_id: null,
            };
          }
          // This deliberately simulates the production failure: an immediate, separate
          // post-write read is stale. The endpoint must use the row returned in DB.batch.
          if (sql.includes('FROM tasks t')) return null;
          throw new Error(`Unexpected first() query: ${sql}`);
        }),
        all: vi.fn(async () => {
          if (sql.includes('FROM permissions p')) {
            return {
              results: [{ permission_key: 'tasks.manage' }, { permission_key: 'tasks.view' }],
            };
          }
          throw new Error(`Unexpected all() query: ${sql}`);
        }),
      };
      return statement;
    });
    const batch = vi.fn(async (statements: FakeStatement[]) =>
      statements.map((statement) => {
        if (statement.sql.includes('INTO tasks (')) {
          // D1 reports trigger side effects in meta.changes. The tasks FTS triggers
          // therefore make this larger than one even though one task was inserted.
          return { success: true, meta: { changes: 3 }, results: [] };
        }
        if (statement.sql.includes('INTO task_events')) {
          // The activity/search triggers on task events also inflate meta.changes.
          return { success: true, meta: { changes: 5 }, results: [] };
        }
        if (statement.sql.includes('SELECT changes() AS task_inserted')) {
          return { success: true, meta: { changes: 0 }, results: [{ task_inserted: 1 }] };
        }
        if (statement.sql.includes('SELECT changes() AS event_inserted')) {
          return { success: true, meta: { changes: 0 }, results: [{ event_inserted: 1 }] };
        }
        if (
          statement.sql.includes('JOIN workspaces w ON w.id = p.workspace_id') &&
          statement.sql.includes('WHERE t.task_key = ?')
        ) {
          const taskKey = String(statement.values[0]);
          return {
            success: true,
            meta: { changes: 0 },
            results: [
              {
                id: 302,
                task_key: taskKey,
                seq: 100302,
                title: 'Reliable task creation',
                description: '',
                status: 'not_started',
                priority: null,
                effort: null,
                due_date: null,
                completed_at: null,
                source_url: null,
                source_updated_at: null,
                source_metadata_json: '{"taskTypes":[],"attachments":[]}',
                updated_at: '2026-08-30T16:00:00Z',
                version: 1,
                assignee_name: null,
                assignee_email: null,
                project_key: 'IT',
                project_name: 'IT Tasks',
                workspace_key: tenantProfile.workspaceKey,
                workspace_name: 'Example Organization',
              },
            ],
          };
        }
        return { success: true, meta: { changes: 1 }, results: [] };
      }),
    );
    const env = {
      ASSETS: { fetch: async () => new Response('asset') },
      DB: { prepare, batch },
      ENVIRONMENT: 'production',
      SESSION_SECRET: 'test-session-secret-that-is-long-enough',
    } as unknown as Env;
    const token = await signSession(env, { id: 6, email: 'owner2@example.org' }, [
      'tasks.view',
      'tasks.manage',
    ]);
    const csrf = 'test-csrf-proof-that-is-at-least-32-characters';
    const response = await app.request(
      `${testOrigins.production}/api/tasks`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `tasks_session=${token}; tasks_csrf=${csrf}`,
          Origin: `${testOrigins.production}`,
          'X-CSRF-Token': csrf,
        },
        body: JSON.stringify({
          mutationKey: '00000000-0000-4000-8000-000000000001',
          title: 'Reliable task creation',
          description: '',
          status: 'not_started',
          priority: null,
          effort: null,
          assigneeEmail: null,
          dueDate: null,
          projectKey: 'IT',
          taskTypes: [],
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { task: { title: string; key: string } };
    expect(payload.task.title).toBe('Reliable task creation');
    expect(payload.task.key).toMatch(/^TASK-[A-F0-9]{12}$/);
    expect(batch).toHaveBeenCalledOnce();
  });
});
