/// <reference types="node" />

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { DEFAULT_EVENT_VOCABULARY, tenantEventVocabulary } from '../shared/tenant-profile-support';
import { profileConfigurationProblems } from '../src/tenancy/configuration';
import { buildIntegrationProfile } from './support/integration-profile';
import { effectiveMigrationsDirectory } from './support/migrations';

const migrationDirectory = effectiveMigrationsDirectory();
const migrationNames = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort();

const seededIdentity = `  1, 'default', 'Team', 'default',
  'TASKS', 'Tasks', 'Default project',
  '', 'Agent', 'agent@tasks.invalid'`;

function applyMigrations(transform?: (name: string, source: string) => string) {
  const database = new DatabaseSync(':memory:');
  for (const name of migrationNames) {
    const source = readFileSync(join(migrationDirectory, name), 'utf8');
    database.exec(transform?.(name, source) ?? source);
  }
  return database;
}

describe.runIf(tenantProfile.tasks.apiMode === 'legacy')('tenant migration configuration', () => {
  it('locks deployment identity without changing existing records and supports a schema rollback', () => {
    const database = new DatabaseSync(':memory:');
    for (const name of migrationNames.filter((migration) => migration < '0018_')) {
      database.exec(readFileSync(join(migrationDirectory, name), 'utf8'));
    }
    const identity = database.prepare('SELECT * FROM tenant_configuration').get();
    const changes = database.prepare('SELECT total_changes() AS count').get();
    database.exec(readFileSync(join(migrationDirectory, '0018_tenant_identity_guard.sql'), 'utf8'));
    expect(database.prepare('SELECT total_changes() AS count').get()).toEqual(changes);

    for (const statement of [
      "UPDATE tenant_configuration SET tenant_key = 'example-tenant' WHERE id = 1",
      'DELETE FROM tenant_configuration WHERE id = 1',
      'INSERT OR REPLACE INTO tenant_configuration SELECT * FROM tenant_configuration',
      `INSERT INTO tenant_configuration SELECT * FROM tenant_configuration WHERE id = 1
       ON CONFLICT(id) DO UPDATE SET tenant_key = 'example-tenant'`,
    ]) {
      expect(() => database.exec(statement), statement).toThrow('tenant identity is immutable');
      expect(database.prepare('SELECT * FROM tenant_configuration').get()).toEqual(identity);
    }

    // Previous Worker versions only read this row and remain compatible. If a
    // schema rollback is needed, dropping the three triggers restores old DML.
    database.exec(`
      DROP TRIGGER tenant_configuration_no_update;
      DROP TRIGGER tenant_configuration_no_delete;
      DROP TRIGGER tenant_configuration_no_replace;
      UPDATE tenant_configuration SET tenant_key = 'example-tenant' WHERE id = 1;
    `);
    expect(database.prepare('SELECT tenant_key FROM tenant_configuration').get()).toEqual({
      tenant_key: 'example-tenant',
    });
    database.close();
  });

  it('matches the active source profile', () => {
    const database = applyMigrations();
    const configuration = database
      .prepare(
        `SELECT tenant_key, organization_name, workspace_key,
          default_project_key, default_project_name, default_project_description,
          initial_admin_email, agent_name, agent_email
         FROM tenant_configuration WHERE id = 1`,
      )
      .get();
    expect(configuration).toEqual({
      tenant_key: tenantProfile.key,
      organization_name: tenantProfile.organizationName,
      workspace_key: tenantProfile.workspaceKey,
      default_project_key: tenantProfile.defaultProjectKey,
      default_project_name: tenantProfile.defaultProjectName,
      default_project_description: tenantProfile.defaultProjectDescription,
      initial_admin_email: tenantProfile.identity.initialAdminEmail,
      agent_name: tenantProfile.agent.name,
      agent_email: tenantProfile.agent.email,
    });
    database.close();
  });

  it('adds configuration without replaying defaults over mutable production state', () => {
    const database = new DatabaseSync(':memory:');
    for (const name of migrationNames.filter((migration) => migration < '0017_')) {
      database.exec(readFileSync(join(migrationDirectory, name), 'utf8'));
    }
    database.exec(`
      UPDATE workspaces SET name = 'Production Workspace'
      WHERE workspace_key = 'default';
      UPDATE projects SET name = 'Technology Work', description = 'Production-owned description'
      WHERE project_key = 'TASKS';
      UPDATE users SET first_name = 'Custom Agent', status = 'disabled'
      WHERE email = 'agent@tasks.invalid' COLLATE NOCASE;
      INSERT INTO users (email, first_name, last_name, status, principal_type)
      VALUES ('admin@example.org', 'Example', 'Admin', 'active', 'human');
      INSERT INTO workspace_members (workspace_id, user_id, role)
      SELECT w.id, u.id, 'member' FROM workspaces w JOIN users u
      WHERE w.workspace_key = 'default' AND u.email = 'admin@example.org';
      INSERT INTO project_members (project_id, user_id, role)
      SELECT p.id, u.id, 'viewer' FROM projects p JOIN users u
      WHERE p.project_key = 'TASKS' AND u.email = 'admin@example.org';
      DELETE FROM user_permissions
      WHERE user_id = (SELECT id FROM users WHERE email = 'admin@example.org');
      INSERT INTO user_permissions (user_id, permission_key)
      SELECT id, 'tasks.view' FROM users WHERE email = 'admin@example.org';
    `);
    const before = {
      workspace: database
        .prepare("SELECT id, workspace_key, name FROM workspaces WHERE workspace_key = 'default'")
        .get(),
      project: database
        .prepare(
          "SELECT id, project_key, name, description FROM projects WHERE project_key = 'TASKS'",
        )
        .get(),
      agent: database
        .prepare(
          "SELECT id, email, first_name, status, principal_type FROM users WHERE email = 'agent@tasks.invalid'",
        )
        .get(),
      adminAccess: database
        .prepare(
          `SELECT wm.role AS workspace_role, pm.role AS project_role,
            group_concat(up.permission_key, ',') AS permissions
           FROM users u
           JOIN workspace_members wm ON wm.user_id = u.id
           JOIN project_members pm ON pm.user_id = u.id
           LEFT JOIN user_permissions up ON up.user_id = u.id
           WHERE u.email = 'admin@example.org'
           GROUP BY wm.role, pm.role`,
        )
        .get(),
    };

    database.exec(readFileSync(join(migrationDirectory, '0017_tenant_configuration.sql'), 'utf8'));

    expect(
      database
        .prepare("SELECT id, workspace_key, name FROM workspaces WHERE workspace_key = 'default'")
        .get(),
    ).toEqual(before.workspace);
    expect(
      database
        .prepare(
          "SELECT id, project_key, name, description FROM projects WHERE project_key = 'TASKS'",
        )
        .get(),
    ).toEqual(before.project);
    expect(
      database
        .prepare(
          "SELECT id, email, first_name, status, principal_type FROM users WHERE email = 'agent@tasks.invalid'",
        )
        .get(),
    ).toEqual(before.agent);
    expect(
      database
        .prepare(
          `SELECT wm.role AS workspace_role, pm.role AS project_role,
            group_concat(up.permission_key, ',') AS permissions
           FROM users u
           JOIN workspace_members wm ON wm.user_id = u.id
           JOIN project_members pm ON pm.user_id = u.id
           LEFT JOIN user_permissions up ON up.user_id = u.id
           WHERE u.email = 'admin@example.org'
           GROUP BY wm.role, pm.role`,
        )
        .get(),
    ).toEqual(before.adminAccess);
    database.close();
  });

  it('normalizes a fresh downstream bootstrap without rewriting the seeded history', () => {
    const downstreamSeed = `  1, 'example-tenant', 'Example Organization', 'example-workspace',
  'OPS', 'Operations', 'Example organization tasks',
  'admin@example.test', 'Automation', 'agent@example.test'`;
    const database = applyMigrations((name, source) => {
      if (name !== '0017_tenant_configuration.sql') return source;
      const overlaid = source.replace(seededIdentity, downstreamSeed);
      expect(overlaid).not.toBe(source);
      return overlaid;
    });

    expect(
      database.prepare('SELECT workspace_key, name FROM workspaces ORDER BY id').all(),
    ).toEqual([{ workspace_key: 'example-workspace', name: 'Example Organization' }]);
    expect(
      database
        .prepare(
          `SELECT project_key, name, description FROM projects
           WHERE project_type = 'shared' ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        project_key: 'OPS',
        name: 'Operations',
        description: 'Example organization tasks',
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT email, first_name, principal_type FROM users
           WHERE principal_type = 'agent'`,
        )
        .get(),
    ).toEqual({ email: 'agent@example.test', first_name: 'Automation', principal_type: 'agent' });

    database
      .prepare(
        `INSERT INTO users (email, first_name, last_name, status, principal_type)
         VALUES ('person@example.test', 'Example', 'Person', 'active', 'human')`,
      )
      .run();
    expect(
      database
        .prepare(
          `SELECT w.workspace_key
           FROM projects p JOIN workspaces w ON w.id = p.workspace_id
           WHERE p.project_type = 'personal'
             AND p.personal_owner_user_id = (SELECT id FROM users WHERE email = 'person@example.test')`,
        )
        .get(),
    ).toEqual({ workspace_key: 'example-workspace' });
    database.close();
  });
});

describe('profile completeness', () => {
  const everything = {
    ...tenantProfile,
    capabilities: {
      ...tenantProfile.capabilities,
      portal: true,
      mobileApi: true,
      portalSupport: true,
      emailNotifications: true,
      portalAlerts: true,
    },
    integrations: {
      emailGateway: { productionOrigin: 'https://x.test', clientId: 'c', fromEmail: 'a@x.test' },
      mobileGateway: { issuer: 'i', audience: 'a', environment: 'dev' },
    },
  } as unknown as typeof tenantProfile;

  it('fails closed, naming the fields, when enabled capabilities lack their settings', () => {
    expect(profileConfigurationProblems(everything)).toEqual([
      'integrations.mobileGateway.headerPrefix',
      'integrations.emailGateway.headerPrefix',
      'integrations.portalAlerts.endpoint',
      'integrations.portalSupport.ticketHosts',
    ]);
    expect(
      profileConfigurationProblems(everything, { eventAssistEndpoint: 'https://m.test' }),
    ).toContain('integrations.eventAssist.allowedHosts');
  });

  it('is satisfied by a complete profile and by the neutral default', () => {
    expect(profileConfigurationProblems(buildIntegrationProfile(tenantProfile))).toEqual([]);
    expect(profileConfigurationProblems(tenantProfile)).toEqual([]);
  });

  it('does not let an explicitly undefined vocabulary field erase a default', () => {
    const vocabulary = tenantEventVocabulary({
      ...tenantProfile,
      events: { rooms: undefined, ministryLabel: 'Group' },
    } as unknown as typeof tenantProfile);
    expect(vocabulary.rooms).toEqual(DEFAULT_EVENT_VOCABULARY.rooms);
    expect(vocabulary.ministryLabel).toBe('Group');
  });
});
