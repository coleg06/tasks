import { describe, expect, it } from 'vitest';
import { tenantProfile } from '../shared/tenant-profile';
import { TASKS_RELEASE_VERSION } from '../shared/version';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { healthSchema } from '../src/shared/schemas';
import { testOrigins } from './support/origins';
import {
  isTenantConfigurationQuery,
  matchingTenantConfigurationRow,
} from './tenant-configuration-fixture';

function configurationDatabase(configuration = matchingTenantConfigurationRow) {
  return {
    prepare: (query: string) => {
      if (!isTenantConfigurationQuery(query)) {
        throw new Error(`Unexpected test database query: ${query}`);
      }
      return { first: async () => configuration };
    },
  };
}

const env = {
  ASSETS: {
    fetch: async () => new Response('asset'),
  },
  DB: configurationDatabase(),
  ENVIRONMENT: 'dev',
  RELEASE_SHA: 'test-release',
} as unknown as Env;

describe('worker foundation', () => {
  it('reports a typed health response', async () => {
    const response = await app.request(
      `${testOrigins.development}/healthz`,
      { headers: { 'cf-ray': 'test-request-id' } },
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('test-request-id');
    expect(healthSchema.parse(await response.json())).toEqual({
      environment: 'dev',
      ok: true,
      release: 'test-release',
      service: tenantProfile.serviceName,
    });
  });

  it('reports readiness only when the database bootstrap matches the source profile', async () => {
    const ready = await app.request(
      `${testOrigins.development}/readyz`,
      {},
      {
        ...env,
        DB: configurationDatabase(),
      },
    );
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ok: true,
      service: tenantProfile.serviceName,
      tenant: tenantProfile.key,
    });

    const mismatched = await app.request(
      `${testOrigins.development}/readyz`,
      {},
      {
        ...env,
        DB: configurationDatabase({
          ...matchingTenantConfigurationRow,
          tenant_key: 'wrong-tenant',
        }),
      },
    );
    expect(mismatched.status).toBe(503);
    expect(await mismatched.json()).toEqual({
      error: 'tenant_configuration_mismatch',
      ok: false,
    });

    const caseMismatchedKey = await app.request(
      `${testOrigins.development}/readyz`,
      {},
      {
        ...env,
        DB: configurationDatabase({
          ...matchingTenantConfigurationRow,
          default_project_key: 'it',
        }),
      },
    );
    expect(caseMismatchedKey.status).toBe(503);
  });

  it('fails state and authentication routes closed on a tenant binding mismatch', async () => {
    const mismatchedEnv = {
      ...env,
      // MCP routes only reach the tenant verification gate when MCP is enabled.
      TASKS_MCP_ENABLED: 'true',
      DB: configurationDatabase({
        ...matchingTenantConfigurationRow,
        tenant_key: 'wrong-tenant',
      }),
    };
    for (const request of [
      new Request(`${testOrigins.development}/auth/login`),
      new Request(`${testOrigins.development}/api/tasks`),
      new Request(`${testOrigins.development}/api/agent/v1/tasks`),
      new Request(`${testOrigins.development}/mcp`, { method: 'POST' }),
    ]) {
      const response = await app.request(request, undefined, mismatchedEnv);
      expect(response.status, request.url).toBe(503);
      expect(await response.json()).toEqual({ error: 'tenant_configuration_mismatch' });
    }

    const staticAsset = await app.request(`${testOrigins.development}/`, {}, mismatchedEnv);
    expect(staticAsset.status).toBe(200);
    expect(await staticAsset.text()).toBe('asset');
  });

  it('keeps browser error reporting private without a session', async () => {
    const response = await app.request(
      `${testOrigins.development}/api/telemetry/client-error`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'ui.render_error',
          message: 'Render failed',
          route: '/events',
        }),
      },
      env,
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('keeps task data private without a session', async () => {
    const response = await app.request(`${testOrigins.development}/api/tasks`, {}, env);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  it('fails disabled optional modules closed before their handlers run', async () => {
    const modulesDisabled = { ...env, FEATURE_MODULES: 'tasks' };
    const eventResponse = await app.request(
      `${testOrigins.development}/api/events`,
      {},
      modulesDisabled,
    );
    const projectMutation = await app.request(
      `${testOrigins.development}/api/projects`,
      { method: 'POST', body: '{}' },
      modulesDisabled,
    );

    expect(eventResponse.status).toBe(404);
    expect(await eventResponse.json()).toEqual({ error: 'feature_disabled', feature: 'events' });
    expect(projectMutation.status).toBe(404);
    expect(await projectMutation.json()).toEqual({
      error: 'feature_disabled',
      feature: 'projects',
    });
  });

  it.runIf(!tenantProfile.capabilities.mobileApi)(
    'does not register the mobile adapter when the profile disables it',
    async () => {
      const response = await app.request(
        `${testOrigins.development}/api/mobile/v1/tasks`,
        {},
        { ...env, TASKS_GATEWAY_ASSERTION_SECRET: 's'.repeat(32) },
      );
      expect(response.status).toBe(404);
    },
  );

  it.runIf(tenantProfile.capabilities.mobileApi)(
    'keeps the mobile adapter closed without a signed gateway assertion',
    async () => {
      const response = await app.request(
        `${testOrigins.development}/api/mobile/v1/tasks`,
        {},
        { ...env, TASKS_GATEWAY_ASSERTION_SECRET: 's'.repeat(32) },
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'missing_assertion' });
    },
  );

  it('keeps MCP and agent routes absent on an install with no MCP settings', async () => {
    const mcp = await app.request(`${testOrigins.development}/mcp`, { method: 'POST' }, env);
    const agent = await app.request(`${testOrigins.development}/api/agent/v1/tasks`, {}, env);
    expect(mcp.status).toBe(404);
    expect(await mcp.json()).toEqual({ error: 'not_found' });
    expect(agent.status).toBe(404);
    expect(await agent.json()).toEqual({ error: 'not_found' });
  });

  it('keeps MCP and agent routes closed when enabled without the gateway and credentials', async () => {
    const enabled = { ...env, TASKS_MCP_ENABLED: 'true' } as Env;
    const mcp = await app.request(`${testOrigins.development}/mcp`, { method: 'POST' }, enabled);
    const agent = await app.request(`${testOrigins.development}/api/agent/v1/tasks`, {}, enabled);
    expect(mcp.status).toBe(503);
    expect(await mcp.json()).toEqual({ error: 'not_configured' });
    expect(agent.status).toBe(503);
    expect(await agent.json()).toEqual({ error: 'not_configured' });
  });

  it('serves the stateless MCP handshake only with both credentials', async () => {
    const gateway = 'gateway-test-value-that-is-at-least-32-characters';
    const clientToken = 'client-test-value-that-is-at-least-32-characters';
    const response = await app.request(
      `${testOrigins.development}/mcp`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${clientToken}`,
          'Content-Type': 'application/json',
          Host: new URL(testOrigins.development).host,
          'X-Tasks-MCP-Gateway-Token': gateway,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'vitest', version: '1.0.0' },
          },
        }),
      },
      {
        ...env,
        TASKS_MCP_GATEWAY_SECRET: gateway,
        TASKS_MCP_CREDENTIALS_JSON: JSON.stringify({
          version: 1,
          credentials: [
            {
              clientId: 'codex-test',
              name: 'Codex Test',
              role: 'Agent',
              runtime: 'codex',
              scope: 'read_write',
              token: clientToken,
            },
          ],
        }),
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.text();
    expect(body).toContain('"jsonrpc":"2.0"');
    expect(body).toContain(
      `"serverInfo":{"name":"${tenantProfile.mcp.serverName}","version":"${TASKS_RELEASE_VERSION}"}`,
    );
  });

  it('rejects cookie-authenticated browser mutations without exact origin and CSRF proof', async () => {
    const response = await app.request(
      `${testOrigins.development}/api/tasks`,
      {
        method: 'POST',
        headers: {
          Cookie: 'tasks_session=session; tasks_csrf=csrf-proof-that-is-long-enough-123456',
        },
        body: '{}',
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'csrf_rejected' });
  });

  it('keeps projects and comments private without a session', async () => {
    const projects = await app.request(`${testOrigins.development}/api/projects`, {}, env);
    const comment = await app.request(
      `${testOrigins.development}/api/tasks/IT-1/comments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Private comment' }),
      },
      env,
    );
    expect(projects.status).toBe(401);
    expect(comment.status).toBe(403);
  });

  it('keeps event plans, templates, and plan previews private without a session', async () => {
    const events = await app.request(`${testOrigins.development}/api/events`, {}, env);
    const templates = await app.request(`${testOrigins.development}/api/event-templates`, {}, env);
    const preview = await app.request(
      `${testOrigins.development}/api/events/plan-preview`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Private event' }),
      },
      env,
    );

    expect(events.status).toBe(401);
    expect(templates.status).toBe(401);
    expect(preview.status).toBe(403);
    const options = await app.request(`${testOrigins.development}/api/event-options`, {}, env);
    expect(options.status).toBe(401);
    const assignedWork = await app.request(
      `${testOrigins.development}/api/event-work-items`,
      {},
      env,
    );
    const assistedIntake = await app.request(
      `${testOrigins.development}/api/events/intake-assist`,
      { method: 'POST', body: '{}' },
      env,
    );
    expect(assignedWork.status).toBe(401);
    expect(assistedIntake.status).toBe(403);
    const myWork = await app.request(`${testOrigins.development}/api/my-work/summary`, {}, env);
    const analytics = await app.request(
      `${testOrigins.development}/api/analytics/workflows`,
      {},
      env,
    );
    const assetDownload = await app.request(
      `${testOrigins.development}/api/events/EVT-1/assets/1/download`,
      {},
      env,
    );
    expect(myWork.status).toBe(tenantProfile.capabilities.portal ? 401 : 404);
    expect(analytics.status).toBe(401);
    expect(assetDownload.status).toBe(401);
  });

  it.runIf(!tenantProfile.capabilities.portal)(
    'does not register the My Work summary when the profile disables the portal',
    async () => {
      const response = await app.request(
        `${testOrigins.development}/api/my-work/summary`,
        { method: 'OPTIONS', headers: { Origin: tenantProfile.origins.portalDevelopment } },
        env,
      );
      expect(response.status).toBe(404);
    },
  );

  it.runIf(tenantProfile.capabilities.portal)(
    'only allows the matching Portal origin to request a credentialed My Work summary',
    async () => {
      const allowed = await app.request(
        `${testOrigins.development}/api/my-work/summary`,
        { method: 'OPTIONS', headers: { Origin: tenantProfile.origins.portalDevelopment } },
        env,
      );
      const rejected = await app.request(
        `${testOrigins.development}/api/my-work/summary`,
        { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } },
        env,
      );
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get('Access-Control-Allow-Origin')).toBe(
        tenantProfile.origins.portalDevelopment,
      );
      expect(allowed.headers.get('Access-Control-Allow-Credentials')).toBe('true');
      expect(rejected.status).toBe(403);
      expect(rejected.headers.get('Access-Control-Allow-Origin')).toBeNull();
    },
  );

  it('keeps task mutations and administration private without a session', async () => {
    const createTask = await app.request(
      `${testOrigins.development}/api/tasks`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Private task' }),
      },
      env,
    );
    const updateProject = await app.request(
      `${testOrigins.development}/api/projects/IT`,
      { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) },
      env,
    );
    const admin = await app.request(`${testOrigins.development}/api/admin`, {}, env);
    const invite = await app.request(
      `${testOrigins.development}/api/admin/users`,
      { method: 'POST', body: '{}' },
      env,
    );
    const impersonate = await app.request(
      `${testOrigins.development}/api/admin/users/2/impersonate`,
      { method: 'POST' },
      env,
    );
    const stopImpersonation = await app.request(
      `${testOrigins.development}/api/admin/impersonation/stop`,
      { method: 'POST' },
      env,
    );
    const preferences = await app.request(
      `${testOrigins.development}/api/account/preferences`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskCreationMode: 'quick' }),
      },
      env,
    );
    expect(createTask.status).toBe(401);
    expect(updateProject.status).toBe(403);
    expect(admin.status).toBe(403);
    expect(invite.status).toBe(403);
    expect(impersonate.status).toBe(403);
    expect(stopImpersonation.status).toBe(401);
    expect(preferences.status).toBe(401);
  });

  it('keeps Google login closed until all secrets are bound', async () => {
    const response = await app.request(`${testOrigins.development}/auth/login`, {}, env);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'auth_not_configured' });
  });
});
