import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  TASK_DEPENDENCY_KINDS,
  TASK_EFFORTS,
  TASK_PRINCIPAL_KINDS,
  TASK_PRIORITIES,
  TASK_PROJECT_MEMBER_ROLES,
  TASK_WORKFLOW_STATES,
  type TaskComment,
  type TaskDomainCapabilities,
  type TaskHistoryEvent,
  type TaskPrincipal,
  type TaskRecord,
} from '../shared/task-domain';

const agent = {
  reference: 'principal:agent',
  kind: 'agent',
  name: 'Agent',
  email: 'agent@example.test',
} as const satisfies TaskPrincipal;

const commonCapabilities = {
  workflow: TASK_WORKFLOW_STATES,
  priorities: TASK_PRIORITIES,
  allowsUnprioritized: true,
  principalKinds: TASK_PRINCIPAL_KINDS,
  effort: true,
  taskTypes: true,
  tags: true,
  parentTasks: true,
  dependencies: true,
  sprints: true,
  projectCardinality: 'multiple',
  comments: true,
  history: true,
  optimisticConcurrency: true,
  durableIdempotency: true,
} as const satisfies TaskDomainCapabilities;

const supersetTask = {
  reference: {
    native: '42',
    display: 'TASK-42',
    aliases: ['42', 'T-42'],
  },
  revision: 'W/"source-revision-7"',
  title: 'Exercise every portable field',
  description: 'No source value is flattened.',
  status: 'review',
  priority: 'critical',
  assignee: agent,
  createdBy: {
    reference: 'principal:human:7',
    kind: 'human',
    name: 'Owner',
    email: 'owner@example.test',
  },
  dueDate: '2026-09-01',
  completedAt: null,
  archivedAt: null,
  createdAt: '2026-08-30T12:00:00Z',
  updatedAt: '2026-08-30T13:00:00Z',
  effort: 'large',
  taskTypes: ['project'],
  tags: ['shared-core'],
  parent: { native: '11', display: 'TASK-11', aliases: ['11'] },
  dependencies: [
    {
      task: { native: '41', display: 'TASK-41', aliases: ['41'] },
      kind: 'blocks',
      direction: 'outbound',
    },
    {
      task: { native: '43', display: 'TASK-43', aliases: ['43'] },
      kind: 'blocks',
      direction: 'inbound',
    },
  ],
  sprints: [
    {
      reference: 'sprint:3',
      key: 'sprint-3',
      name: 'Sprint 3',
      role: 'carryover',
      status: 'active',
      startDate: '2026-08-28',
      endDate: '2026-09-03',
    },
  ],
  projects: [
    {
      reference: 'project:tasks',
      key: 'tasks',
      name: 'Tasks',
      visibility: 'workspace',
      kind: 'shared',
      workspace: { reference: 'workspace:main', key: 'main', name: 'Main' },
    },
    {
      reference: 'project:shared-core',
      key: 'shared-core',
      name: 'Shared Core',
      visibility: 'workspace',
      kind: 'shared',
      workspace: { reference: 'workspace:main', key: 'main', name: 'Main' },
    },
  ],
  source: {
    system: 'legacy-task-api',
    reference: '42',
    revision: '2026-08-30T13:00:00Z',
    metadata: { imported: true },
  },
} as const satisfies TaskRecord;

const normalizedComment = {
  reference: null,
  revision: null,
  body: 'A source without comment IDs remains representable.',
  author: agent,
  createdAt: '2026-08-30T12:30:00Z',
} as const satisfies TaskComment;

const normalizedHistory = {
  reference: 'event:9',
  revision: '9',
  action: 'task.updated',
  actor: agent,
  occurredAt: '2026-08-30T13:00:00Z',
  changes: [{ field: 'priority', previous: 'high', current: 'critical' }],
  source: { system: 'native', reference: '9' },
} as const satisfies TaskHistoryEvent;

describe('portable task domain', () => {
  it('retains every current workflow and priority value', () => {
    expect(TASK_WORKFLOW_STATES).toEqual([
      'backlog',
      'not_started',
      'open',
      'in_progress',
      'blocked',
      'review',
      'done',
      'cancelled',
    ]);
    expect(TASK_PRIORITIES).toEqual(['critical', 'high', 'medium', 'low']);
    expect(TASK_EFFORTS).toEqual(['small', 'medium', 'large']);
    expect(TASK_DEPENDENCY_KINDS).toEqual(['blocks', 'related', 'subtask']);
    expect(TASK_PROJECT_MEMBER_ROLES).toEqual(['owner', 'editor', 'viewer']);
  });

  it('models humans, agents, and systems as distinct principals', () => {
    expect(TASK_PRINCIPAL_KINDS).toEqual(['human', 'agent', 'system']);
    expect(agent.kind).toBe('agent');
    expectTypeOf(agent).toMatchTypeOf<TaskPrincipal>();
  });

  it('keeps native, display, and compatibility references separate', () => {
    expect(supersetTask.reference).toEqual({
      native: '42',
      display: 'TASK-42',
      aliases: ['42', 'T-42'],
    });
    expect(supersetTask.revision).toBe('W/"source-revision-7"');
    expect(supersetTask.dependencies.map(({ direction }) => direction)).toEqual([
      'outbound',
      'inbound',
    ]);
    expect(supersetTask.projects.map(({ key }) => key)).toEqual(['tasks', 'shared-core']);
    expectTypeOf(supersetTask).toMatchTypeOf<TaskRecord>();
  });

  it('normalizes comments and immutable field-change history without inventing identifiers', () => {
    expect(normalizedComment.reference).toBeNull();
    expect(normalizedHistory.changes).toEqual([
      { field: 'priority', previous: 'high', current: 'critical' },
    ]);
    expectTypeOf(normalizedComment).toMatchTypeOf<TaskComment>();
    expectTypeOf(normalizedHistory).toMatchTypeOf<TaskHistoryEvent>();
  });

  it('advertises supported subsets without narrowing the shared vocabulary', () => {
    expect(commonCapabilities.workflow).toContain('review');
    expect(commonCapabilities.workflow).toContain('backlog');
    expect(commonCapabilities.priorities).toContain('critical');
    expect(commonCapabilities.allowsUnprioritized).toBe(true);
    expect(commonCapabilities.projectCardinality).toBe('multiple');
  });
});
