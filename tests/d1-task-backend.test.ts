/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import type { TaskAccessContext } from '../src/core/contracts';
import type { Env } from '../src/env';
import { D1_TASK_CAPABILITIES, D1TaskReadBackend } from '../src/persistence/d1-task-backend';
import { effectiveMigrationsDirectory } from './support/migrations';

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
  type Prepared = {
    bind: (...values: unknown[]) => Prepared;
    first: () => Promise<Record<string, unknown> | null>;
    all: () => Promise<{ results: Record<string, unknown>[] }>;
  };

  function prepare(sql: string): Prepared {
    const statement = database.prepare(sql);
    let values: unknown[] = [];
    const prepared: Prepared = {
      bind(...nextValues: unknown[]) {
        values = nextValues;
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
    };
    return prepared;
  }

  return { prepare } as unknown as Env['DB'];
}

type SeedUser = {
  id: number;
  email: string;
  name: string;
  kind: 'human' | 'agent';
};

function taskAccess(user: SeedUser): TaskAccessContext {
  return {
    identity: {
      principal: {
        reference: `user:${user.id}`,
        kind: user.kind,
        name: user.name,
        email: user.email,
      },
      permissions: [],
    },
  };
}

function seededBackend() {
  const database = migratedDatabase();
  const insertUser = database.prepare(
    `INSERT INTO users (email, first_name, last_name, status, principal_type)
     VALUES (?, ?, ?, 'active', 'human')`,
  );
  insertUser.run('owner@example.org', 'Olivia', 'Owner');
  insertUser.run('reader@example.org', 'Riley', 'Reader');
  insertUser.run('limited@example.org', 'Lee', 'Limited');

  const rowForEmail = (email: string) =>
    database
      .prepare(
        `SELECT id, email,
           COALESCE(NULLIF(TRIM(first_name || ' ' || last_name), ''), email) AS name,
           principal_type AS kind
         FROM users WHERE email = ? COLLATE NOCASE`,
      )
      .get(email) as SeedUser;
  const owner = rowForEmail('owner@example.org');
  const reader = rowForEmail('reader@example.org');
  const limited = rowForEmail('limited@example.org');
  const agent = rowForEmail(tenantProfile.agent.email);
  const workspace = database
    .prepare('SELECT id FROM workspaces WHERE workspace_key = ?')
    .get(tenantProfile.workspaceKey) as { id: number };
  const membership = database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)`,
  );
  membership.run(workspace.id, owner.id, 'owner');
  membership.run(workspace.id, reader.id, 'member');
  membership.run(workspace.id, limited.id, 'member');
  const grant = database.prepare(
    `INSERT OR IGNORE INTO user_permissions (user_id, permission_key) VALUES (?, ?)`,
  );
  for (const permission of ['tasks.view', 'tasks.manage', 'tasks.comment']) {
    grant.run(owner.id, permission);
  }
  for (const permission of ['tasks.view', 'tasks.comment']) grant.run(reader.id, permission);
  grant.run(limited.id, 'tasks.view');

  const createProject = database.prepare(
    `INSERT INTO projects (
       workspace_id, project_key, name, description, visibility, created_by_user_id, project_type
     ) VALUES (?, ?, ?, ?, 'private', ?, 'shared')`,
  );
  createProject.run(workspace.id, 'PRIVATE', 'Private Team', 'Membership-only work', owner.id);
  createProject.run(workspace.id, 'SECRET', 'Secret Team', 'Another private team', owner.id);
  const privateProject = database
    .prepare('SELECT id FROM projects WHERE project_key = ?')
    .get('PRIVATE') as { id: number };
  database
    .prepare(`INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, 'viewer')`)
    .run(privateProject.id, reader.id);

  const insertTask = database.prepare(
    `INSERT INTO tasks (
       task_key, seq, title, description, status, priority, effort, assignee_user_id,
       created_by_user_id, due_date, sort_key, completed_at, source_metadata_json,
       source_content_json, workspace_id, project_id, created_at, updated_at, archived_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
       (SELECT id FROM projects WHERE project_key = ?), ?, ?, ?)`,
  );
  const addTask = (input: {
    key: string;
    seq: number;
    title: string;
    description?: string;
    status: string;
    assignee?: number | null;
    project?: string;
    archivedAt?: string | null;
    metadata?: Record<string, unknown>;
  }) =>
    insertTask.run(
      input.key,
      input.seq,
      input.title,
      input.description ?? '',
      input.status,
      'high',
      'small',
      input.assignee ?? null,
      owner.id,
      '2026-09-15',
      `${input.status}:high:2026-09-15:${input.key}`,
      input.status === 'done' ? '2026-08-29T12:00:00Z' : null,
      JSON.stringify(
        input.metadata ?? {
          taskTypes: ['Operations'],
          attachments: [{ name: 'runbook.pdf' }],
        },
      ),
      JSON.stringify({ notes: 'Restricted provenance content' }),
      workspace.id,
      input.project ?? tenantProfile.defaultProjectKey,
      '2026-08-29T10:00:00Z',
      '2026-08-30T10:00:00Z',
      input.archivedAt ?? null,
    );

  addTask({
    key: 'TASK-OPEN-HUMAN',
    seq: 101,
    title: 'Literal 100% readiness',
    description: 'Search for a percent sign',
    status: 'in_progress',
    assignee: reader.id,
  });
  addTask({
    key: 'TASK-OPEN-AGENT',
    seq: 102,
    title: 'Agent open task',
    status: 'blocked',
    assignee: agent.id,
  });
  addTask({
    key: 'TASK-OPEN-NUMBER',
    seq: 103,
    title: 'Literal 1000 readiness',
    status: 'in_progress',
    assignee: null,
  });
  addTask({
    key: 'TASK-BACKLOG',
    seq: 104,
    title: 'Backlog task',
    status: 'not_started',
    assignee: null,
  });
  addTask({
    key: 'TASK-DONE',
    seq: 105,
    title: 'Completed reader task',
    status: 'done',
    assignee: reader.id,
  });
  addTask({
    key: 'TASK-PRIVATE',
    seq: 106,
    title: 'Private member task',
    status: 'in_progress',
    assignee: reader.id,
    project: 'PRIVATE',
  });
  addTask({
    key: 'TASK-SECRET',
    seq: 107,
    title: 'Secret task',
    status: 'in_progress',
    assignee: owner.id,
    project: 'SECRET',
  });
  addTask({
    key: 'TASK-ARCHIVED',
    seq: 108,
    title: 'Archived task',
    status: 'in_progress',
    assignee: reader.id,
    archivedAt: '2026-08-30T11:00:00Z',
  });

  const detailTask = database
    .prepare('SELECT id FROM tasks WHERE task_key = ?')
    .get('TASK-OPEN-HUMAN') as { id: number };
  database
    .prepare(`INSERT INTO task_comments (task_id, author_user_id, body) VALUES (?, ?, ?)`)
    .run(detailTask.id, reader.id, 'Reader comment');
  database
    .prepare(`INSERT INTO task_comments (task_id, author_user_id, body) VALUES (?, ?, ?)`)
    .run(detailTask.id, agent.id, 'Agent comment');
  database
    .prepare(
      `INSERT INTO task_events (task_id, actor_user_id, action, changes_json, created_at)
       VALUES (?, ?, 'updated', ?, '2026-08-30T10:00:00Z')`,
    )
    .run(
      detailTask.id,
      owner.id,
      JSON.stringify({ status: { before: 'not_started', after: 'in_progress' } }),
    );

  return {
    addTask,
    agent,
    backend: new D1TaskReadBackend(d1Adapter(database)),
    database,
    limited,
    owner,
    reader,
  };
}

describe.runIf(tenantProfile.tasks.apiMode === 'legacy')('D1 task read backend', () => {
  it('characterizes saved views, escaped search, and Hide Agent behavior in SQLite', async () => {
    const fixture = seededBackend();
    try {
      const context = taskAccess(fixture.reader);
      const query = {
        view: 'open' as const,
        search: '',
        project: '',
        sort: '',
        hideAgentTasks: false,
      };
      const open = await fixture.backend.listTasksForApi(query, context);
      expect(open.map((task) => task.key)).toEqual([
        'TASK-OPEN-HUMAN',
        'TASK-OPEN-NUMBER',
        'TASK-PRIVATE',
        'TASK-OPEN-AGENT',
      ]);

      const hidden = await fixture.backend.listTasksForApi(
        { ...query, hideAgentTasks: true },
        context,
      );
      expect(hidden.map((task) => task.key)).not.toContain('TASK-OPEN-AGENT');
      expect(hidden.map((task) => task.key)).toContain('TASK-OPEN-HUMAN');

      const escapedSearch = await fixture.backend.listTasksForApi(
        { ...query, search: '100%' },
        context,
      );
      expect(escapedSearch.map((task) => task.key)).toEqual(['TASK-OPEN-HUMAN']);

      const mine = await fixture.backend.listTasksForApi({ ...query, view: 'mine' }, context);
      expect(mine.map((task) => task.key)).toEqual([
        'TASK-OPEN-HUMAN',
        'TASK-PRIVATE',
        'TASK-DONE',
      ]);

      const portable = await fixture.backend.listTasks(
        { statuses: ['in_progress', 'blocked'], excludeAssigneeKinds: ['agent'] },
        context,
      );
      expect(portable.tasks.map((task) => task.reference.native)).toEqual([
        'TASK-PRIVATE',
        'TASK-OPEN-NUMBER',
        'TASK-OPEN-HUMAN',
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it('pages past 500 matching tasks with an opaque continuation cursor', async () => {
    const fixture = seededBackend();
    try {
      fixture.database.exec('BEGIN');
      for (let index = 0; index < 505; index += 1) {
        fixture.addTask({
          key: `TASK-PAGE-${index}`,
          seq: 1000 + index,
          title: `Pagination task ${index}`,
          status: 'in_progress',
        });
      }
      fixture.database.exec('COMMIT');

      const context = taskAccess(fixture.reader);
      const first = await fixture.backend.listTasks(
        { search: 'Pagination task', statuses: ['in_progress'], limit: 500 },
        context,
      );
      expect(first.tasks).toHaveLength(500);
      expect(first.nextCursor).toMatch(/^d1-task-cursor:v2:/);
      expect(first.nextCursor).not.toBe(first.tasks.at(-1)?.reference.native);

      fixture.addTask({
        key: 'TASK-PAGE-CONCURRENT',
        seq: 2000,
        title: 'Pagination task concurrent insert',
        status: 'in_progress',
      });

      const second = await fixture.backend.listTasks(
        {
          search: 'Pagination task',
          statuses: ['in_progress'],
          limit: 500,
          cursor: first.nextCursor as string,
        },
        context,
      );
      expect(second.tasks).toHaveLength(5);
      expect(second.nextCursor).toBeNull();
      const references = [...first.tasks, ...second.tasks].map((task) => task.reference.native);
      expect(new Set(references).size).toBe(505);
      expect(references).toContain('TASK-PAGE-0');
      expect(references).toContain('TASK-PAGE-504');
      expect(references).not.toContain('TASK-PAGE-CONCURRENT');
    } finally {
      fixture.database.close();
    }
  });

  it('round-trips metadata assignee references through assignee and exclusion filters', async () => {
    const fixture = seededBackend();
    try {
      fixture.addTask({
        key: 'TASK-METADATA-AGENT',
        seq: 201,
        title: 'Metadata assigned Agent',
        status: 'in_progress',
        metadata: {
          assignees: [
            { name: tenantProfile.agent.name, email: `  ${tenantProfile.agent.email}  ` },
          ],
          taskTypes: [],
          attachments: [],
        },
      });
      fixture.addTask({
        key: 'TASK-METADATA-HUMAN',
        seq: 202,
        title: 'Metadata assigned Human',
        status: 'in_progress',
        metadata: {
          assignees: [{ name: 'Imported Human', email: 'imported@example.org' }],
          taskTypes: [],
          attachments: [],
        },
      });
      const context = taskAccess(fixture.reader);
      const metadataTasks = await fixture.backend.listTasks(
        { search: 'Metadata assigned', statuses: ['in_progress'] },
        context,
      );
      const human = metadataTasks.tasks.find(
        (task) => task.reference.native === 'TASK-METADATA-HUMAN',
      );
      const agent = metadataTasks.tasks.find(
        (task) => task.reference.native === 'TASK-METADATA-AGENT',
      );
      expect(human?.assignee).toMatchObject({
        reference: 'email:imported@example.org',
        kind: 'human',
      });
      expect(agent?.assignee).toMatchObject({
        reference: `email:${tenantProfile.agent.email}`,
        kind: 'agent',
      });
      const humanReference = human?.assignee?.reference;
      expect(humanReference).toBe('email:imported@example.org');
      if (!humanReference) throw new Error('Metadata assignee reference was not emitted.');
      const agentReference = agent?.assignee?.reference;
      expect(agentReference).toBe(`email:${tenantProfile.agent.email}`);
      if (!agentReference) throw new Error('Metadata Agent reference was not emitted.');

      const roundTrip = await fixture.backend.listTasks(
        {
          search: 'Metadata assigned',
          assignee: humanReference,
        },
        context,
      );
      expect(roundTrip.tasks.map((task) => task.reference.native)).toEqual(['TASK-METADATA-HUMAN']);
      const agentRoundTrip = await fixture.backend.listTasks(
        {
          search: 'Metadata assigned',
          assignee: agentReference,
        },
        context,
      );
      expect(agentRoundTrip.tasks.map((task) => task.reference.native)).toEqual([
        'TASK-METADATA-AGENT',
      ]);
      const unassigned = await fixture.backend.listTasks(
        { search: 'Metadata assigned', assignee: null },
        context,
      );
      expect(unassigned.tasks).toEqual([]);
      const withoutAgent = await fixture.backend.listTasks(
        { search: 'Metadata assigned', excludeAssigneeKinds: ['agent'] },
        context,
      );
      expect(withoutAgent.tasks.map((task) => task.reference.native)).toEqual([
        'TASK-METADATA-HUMAN',
      ]);

      const hiddenLegacy = await fixture.backend.listTasksForApi(
        {
          view: 'open',
          search: 'Metadata assigned',
          project: '',
          sort: '',
          hideAgentTasks: true,
        },
        context,
      );
      expect(hiddenLegacy.map((task) => task.key)).toEqual(['TASK-METADATA-HUMAN']);
    } finally {
      fixture.database.close();
    }
  });

  it('preserves project visibility, membership, and assignee rules', async () => {
    const fixture = seededBackend();
    try {
      const readerContext = taskAccess(fixture.reader);
      const limitedContext = taskAccess(fixture.limited);
      const projects = await fixture.backend.listProjects(readerContext);
      expect(projects.map(({ project }) => project.key)).toEqual([
        `PERSONAL-${fixture.reader.id}`,
        ...[tenantProfile.defaultProjectKey, 'PRIVATE'].sort(),
      ]);
      expect(projects.find(({ project }) => project.key === 'PRIVATE')?.access).toEqual({
        role: 'viewer',
        canCreateTask: false,
        canEditTasks: false,
      });
      expect(
        (await fixture.backend.listProjects(limitedContext)).map((item) => item.project.key),
      ).not.toContain('PRIVATE');

      await expect(fixture.backend.listProjectMembers('PRIVATE', readerContext)).resolves.toEqual({
        outcome: 'found',
        value: [
          {
            principal: {
              reference: `user:${fixture.reader.id}`,
              kind: 'human',
              name: fixture.reader.name,
              email: fixture.reader.email,
            },
            role: 'viewer',
          },
        ],
      });
      await expect(fixture.backend.listProjectMembers('PRIVATE', limitedContext)).resolves.toEqual({
        outcome: 'not-found',
      });

      const privateAssignees = await fixture.backend.listProjectAssignees('PRIVATE', readerContext);
      expect(privateAssignees.outcome).toBe('found');
      if (privateAssignees.outcome === 'found') {
        expect(privateAssignees.value.map((assignee) => assignee.email)).toEqual([
          tenantProfile.agent.email,
          fixture.owner.email,
          fixture.reader.email,
        ]);
      }
      const personalAssignees = await fixture.backend.listProjectAssignees(
        `PERSONAL-${fixture.reader.id}`,
        readerContext,
      );
      expect(personalAssignees).toMatchObject({
        outcome: 'found',
        value: [{ reference: `user:${fixture.reader.id}` }],
      });
    } finally {
      fixture.database.close();
    }
  });

  it('returns portable detail and the exact embedded compatibility detail', async () => {
    const fixture = seededBackend();
    try {
      const readerContext = taskAccess(fixture.reader);
      const detail = await fixture.backend.getTask(
        'TASK-OPEN-HUMAN',
        { comments: true, history: true },
        readerContext,
      );
      expect(detail?.task).toMatchObject({
        reference: { native: 'TASK-OPEN-HUMAN', display: 'T-101' },
        revision: '1',
        status: 'in_progress',
        assignee: { reference: `user:${fixture.reader.id}`, kind: 'human' },
        projects: [
          {
            key: tenantProfile.defaultProjectKey,
            workspace: { key: tenantProfile.workspaceKey },
          },
        ],
      });
      expect(detail?.access).toEqual({ canEdit: false, canComment: true });
      expect(detail?.comments?.map(({ access }) => access.canDelete)).toEqual([true, false]);
      expect(detail?.history?.[0]).toMatchObject({
        action: 'updated',
        changes: [{ field: 'status', previous: 'not_started', current: 'in_progress' }],
      });

      const compatibility = await fixture.backend.getTaskForApi('TASK-OPEN-HUMAN', readerContext);
      expect(compatibility?.task).toMatchObject({
        key: 'TASK-OPEN-HUMAN',
        reference: 'T-101',
        canEdit: false,
        canComment: true,
        content: { notes: 'Restricted provenance content' },
        comments: [
          { body: 'Reader comment', canDelete: true },
          { body: 'Agent comment', canDelete: false },
        ],
        activity: [
          {
            action: 'updated',
            changes: { status: { before: 'not_started', after: 'in_progress' } },
          },
        ],
      });
      await expect(
        fixture.backend.getTask('TASK-PRIVATE', {}, taskAccess(fixture.limited)),
      ).resolves.toBeNull();
      const ownerDetail = await fixture.backend.getTask(
        'TASK-OPEN-HUMAN',
        {},
        taskAccess(fixture.owner),
      );
      expect(ownerDetail?.access.canEdit).toBe(true);
      expect(ownerDetail).not.toHaveProperty('comments');
      expect(ownerDetail).not.toHaveProperty('history');
    } finally {
      fixture.database.close();
    }
  });

  it('keeps portable history complete and management deletes out of the legacy DTO', async () => {
    const fixture = seededBackend();
    try {
      const task = fixture.database
        .prepare('SELECT id FROM tasks WHERE task_key = ?')
        .get('TASK-OPEN-HUMAN') as { id: number };
      const insertEvent = fixture.database.prepare(
        `INSERT INTO task_events (task_id, actor_user_id, action, changes_json, created_at)
         VALUES (?, ?, 'bulk_history', ?, ?)`,
      );
      fixture.database.exec('BEGIN');
      for (let index = 0; index < 105; index += 1) {
        insertEvent.run(
          task.id,
          fixture.owner.id,
          JSON.stringify({ index }),
          `2026-08-30T11:${String(index % 60).padStart(2, '0')}:00Z`,
        );
      }
      fixture.database.exec('COMMIT');

      const ownerContext = taskAccess(fixture.owner);
      const portable = await fixture.backend.getTask(
        'TASK-OPEN-HUMAN',
        { comments: true, history: true },
        ownerContext,
      );
      expect(portable?.history).toHaveLength(106);
      expect(portable?.comments?.map(({ access }) => access.canDelete)).toEqual([true, true]);

      const compatibility = await fixture.backend.getTaskForApi('TASK-OPEN-HUMAN', ownerContext);
      expect(compatibility?.task.activity).toHaveLength(100);
      expect(compatibility?.task.comments.map((comment) => comment.canDelete)).toEqual([
        false,
        false,
      ]);
    } finally {
      fixture.database.close();
    }
  });

  it('resolves opaque keys and T-sequences through access-aware SQLite reads', async () => {
    const fixture = seededBackend();
    try {
      fixture.addTask({
        key: '101',
        seq: 909,
        title: 'Numeric native key collision',
        status: 'in_progress',
      });
      const readerContext = taskAccess(fixture.reader);
      const key = await fixture.backend.resolveTaskReference('TASK-OPEN-HUMAN', readerContext);
      const sequence = await fixture.backend.resolveTaskReference('  t-101  ', readerContext);
      const alias = await fixture.backend.resolveTaskReference('101', readerContext);
      expect(key).toEqual({
        outcome: 'resolved',
        reference: { native: 'TASK-OPEN-HUMAN', display: 'T-101', aliases: ['101'] },
      });
      expect(sequence).toEqual(key);
      expect(alias).toEqual({
        outcome: 'resolved',
        reference: { native: '101', display: 'T-909', aliases: ['909'] },
      });
      await expect(
        fixture.backend.resolveTaskReference('TASK-PRIVATE', taskAccess(fixture.limited)),
      ).resolves.toEqual({ outcome: 'not-found' });
      await expect(fixture.backend.resolveTaskReference('T-108', readerContext)).resolves.toEqual({
        outcome: 'not-found',
      });

      const agentEmailContext = {
        identity: {
          principal: {
            reference: 'agent:codex-test',
            kind: 'agent',
            name: tenantProfile.agent.name,
            email: tenantProfile.agent.email,
          },
          permissions: [],
        },
      } as const satisfies TaskAccessContext;
      await expect(
        fixture.backend.resolveTaskReference('T-102', agentEmailContext),
      ).resolves.toMatchObject({
        outcome: 'resolved',
        reference: { native: 'TASK-OPEN-AGENT' },
      });
      expect(fixture.backend.capabilities).toEqual(D1_TASK_CAPABILITIES);
      expect(fixture.backend.capabilities.projectCardinality).toBe('single');
    } finally {
      fixture.database.close();
    }
  });
});
