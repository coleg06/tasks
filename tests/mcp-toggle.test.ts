import { describe, expect, it } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { MCP_GATEWAY_HEADER } from '../src/mcp/auth';
import { mcpAvailability, mcpConfigurationProblems } from '../src/mcp/config';
import { testOrigins } from './support/origins';
import {
  isTenantConfigurationQuery,
  matchingTenantConfigurationRow,
} from './tenant-configuration-fixture';

const gateway = 'gateway-test-value-that-is-at-least-32-characters';
const readWriteToken = 'read-write-test-value-at-least-32-characters';
const readOnlyToken = 'read-only-test-value-at-least-32-characters-x';
const credentials = JSON.stringify({
  version: 1,
  credentials: [
    {
      clientId: 'rw-test',
      name: 'RW Test',
      role: 'Agent',
      runtime: 'test',
      scope: 'read_write',
      token: readWriteToken,
    },
    {
      clientId: 'ro-test',
      name: 'RO Test',
      role: 'Agent',
      runtime: 'test',
      scope: 'read',
      token: readOnlyToken,
    },
  ],
});

function environment(settings: Record<string, string> = {}) {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    DB: {
      prepare: (query: string) => {
        if (!isTenantConfigurationQuery(query)) {
          throw new Error(`Unexpected test database query: ${query}`);
        }
        return { first: async () => matchingTenantConfigurationRow };
      },
    },
    ENVIRONMENT: 'dev',
    RELEASE_SHA: 'test-release',
    ...settings,
  } as unknown as Env;
}

const initialize = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1.0.0' },
  },
});

function mcp(env: Env, headers: Record<string, string> = {}) {
  return app.request(
    `${testOrigins.development}/mcp`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Host: new URL(testOrigins.development).host,
        ...headers,
      },
      body: initialize,
    },
    env,
  );
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const full = { ...bearer(readWriteToken), [MCP_GATEWAY_HEADER]: gateway };
const gatewaySettings = {
  TASKS_MCP_GATEWAY_SECRET: gateway,
  TASKS_MCP_CREDENTIALS_JSON: credentials,
};

describe('TASKS_MCP_ENABLED resolution', () => {
  it('is off for a neutral install and on only when credentials exist while unset', () => {
    expect(mcpAvailability({})).toBe('disabled');
    expect(mcpAvailability({ TASKS_MCP_ENABLED: '  ' })).toBe('disabled');
    expect(mcpAvailability({ TASKS_MCP_CREDENTIALS_JSON: credentials })).toBe('enabled');
    expect(
      mcpAvailability({ TASKS_MCP_ENABLED: '', TASKS_MCP_CREDENTIALS_JSON: credentials }),
    ).toBe('enabled');
  });

  it('honors an explicit true or false regardless of credentials', () => {
    expect(mcpAvailability({ TASKS_MCP_ENABLED: 'true' })).toBe('enabled');
    expect(mcpAvailability({ TASKS_MCP_ENABLED: 'TRUE' })).toBe('enabled');
    expect(
      mcpAvailability({ TASKS_MCP_ENABLED: 'false', TASKS_MCP_CREDENTIALS_JSON: credentials }),
    ).toBe('disabled');
  });

  it.each(['1', 'yes', 'on', 'enabled', 'truee'])('treats %s as invalid, never as on', (value) => {
    expect(mcpAvailability({ TASKS_MCP_ENABLED: value })).toBe('invalid');
    expect(
      mcpAvailability({ TASKS_MCP_ENABLED: value, TASKS_MCP_CREDENTIALS_JSON: credentials }),
    ).toBe('invalid');
    expect(mcpConfigurationProblems({ TASKS_MCP_ENABLED: value })).toEqual(['TASKS_MCP_ENABLED']);
  });

  it('names missing settings only for an explicit true, so existing deployments are unchanged', () => {
    expect(mcpConfigurationProblems({})).toEqual([]);
    expect(mcpConfigurationProblems({ TASKS_MCP_CREDENTIALS_JSON: credentials })).toEqual([]);
    expect(mcpConfigurationProblems({ TASKS_MCP_ENABLED: 'false' })).toEqual([]);
    expect(mcpConfigurationProblems({ TASKS_MCP_ENABLED: 'true' })).toEqual([
      'TASKS_MCP_CREDENTIALS_JSON',
      'TASKS_MCP_GATEWAY_SECRET',
    ]);
    expect(
      mcpConfigurationProblems({ TASKS_MCP_ENABLED: 'true', TASKS_MCP_AUTH_MODE: 'token' }),
    ).toEqual(['TASKS_MCP_CREDENTIALS_JSON']);
    expect(
      mcpConfigurationProblems({
        TASKS_MCP_ENABLED: 'true',
        TASKS_MCP_AUTH_MODE: 'token',
        TASKS_MCP_CREDENTIALS_JSON: '{"version":1,"credentials":[]}',
      }),
    ).toEqual(['TASKS_MCP_CREDENTIALS_JSON']);
    expect(
      mcpConfigurationProblems({
        TASKS_MCP_ENABLED: 'true',
        TASKS_MCP_AUTH_MODE: 'token',
        TASKS_MCP_CREDENTIALS_JSON: credentials,
      }),
    ).toEqual([]);
  });

  it('rejects an unknown auth mode', () => {
    expect(mcpConfigurationProblems({ TASKS_MCP_AUTH_MODE: 'none' })).toEqual([
      'TASKS_MCP_AUTH_MODE',
    ]);
  });
});

describe('/mcp route availability', () => {
  it('answers 404 for a neutral install, like an absent route', async () => {
    const neutral = environment();
    const response = await mcp(neutral, full);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    const agent = await app.request(`${testOrigins.development}/api/agent/v1/tasks`, {}, neutral);
    expect(agent.status).toBe(404);
  });

  it('answers 404 when false, even with valid credentials and gateway', async () => {
    const env = environment({ ...gatewaySettings, TASKS_MCP_ENABLED: 'false' });
    expect((await mcp(env, full)).status).toBe(404);
    const agent = await app.request(
      `${testOrigins.development}/api/agent/v1/tasks`,
      { headers: full },
      env,
    );
    expect(agent.status).toBe(404);
  });

  it('serves when unset and credentials are present (existing deployments are unchanged)', async () => {
    const response = await mcp(environment(gatewaySettings), full);
    expect(response.status, await response.clone().text()).toBe(200);
  });

  it('serves when true and fully configured', async () => {
    const response = await mcp(
      environment({ ...gatewaySettings, TASKS_MCP_ENABLED: 'true' }),
      full,
    );
    expect(response.status).toBe(200);
  });

  it('answers the not-configured response when true but required settings are missing', async () => {
    for (const settings of [
      {},
      { TASKS_MCP_CREDENTIALS_JSON: credentials },
      { TASKS_MCP_GATEWAY_SECRET: gateway },
    ]) {
      const response = await mcp(environment({ ...settings, TASKS_MCP_ENABLED: 'true' }), full);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'not_configured' });
    }
  });

  it.each(['1', 'yes', 'on'])('fails closed with 503 for the invalid value %s', async (value) => {
    const response = await mcp(environment({ ...gatewaySettings, TASKS_MCP_ENABLED: value }), full);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_configured' });
  });

  it('readiness names the misconfigured settings and nothing else', async () => {
    const missing = await app.request(
      `${testOrigins.development}/readyz`,
      {},
      environment({ TASKS_MCP_ENABLED: 'true' }),
    );
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({
      error: 'mcp_configuration_invalid',
      ok: false,
      settings: ['TASKS_MCP_CREDENTIALS_JSON', 'TASKS_MCP_GATEWAY_SECRET'],
    });
    for (const env of [
      environment(),
      environment({ TASKS_MCP_ENABLED: 'false' }),
      environment(gatewaySettings),
      environment({ ...gatewaySettings, TASKS_MCP_ENABLED: 'true' }),
    ]) {
      expect((await app.request(`${testOrigins.development}/readyz`, {}, env)).status).toBe(200);
    }
  });
});

describe('MCP authentication modes on the route', () => {
  it('rejects the default mode without a gateway secret, and never relaxes to token-only', async () => {
    const env = environment({ TASKS_MCP_CREDENTIALS_JSON: credentials });
    const response = await mcp(env, bearer(readWriteToken));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'not_configured' });
    const shortSecret = environment({
      TASKS_MCP_CREDENTIALS_JSON: credentials,
      TASKS_MCP_GATEWAY_SECRET: 'short',
    });
    expect((await mcp(shortSecret, bearer(readWriteToken))).status).toBe(503);
  });

  it('requires the gateway proof in the default mode', async () => {
    const env = environment(gatewaySettings);
    expect((await mcp(env, bearer(readWriteToken))).status).toBe(403);
  });

  it('accepts only the client credential in token mode, as a bearer or the client header', async () => {
    const env = environment({
      TASKS_MCP_CREDENTIALS_JSON: credentials,
      TASKS_MCP_AUTH_MODE: 'token',
    });
    expect((await mcp(env, bearer(readWriteToken))).status).toBe(200);
    expect((await mcp(env, { 'X-Tasks-MCP-Token': readWriteToken })).status).toBe(200);
    expect((await mcp(env)).status).toBe(401);
    expect((await mcp(env, bearer('wrong-value-wrong-value-wrong-value-12345'))).status).toBe(401);
  });

  it('does not enable token mode from an unknown value', async () => {
    const env = environment({
      TASKS_MCP_CREDENTIALS_JSON: credentials,
      TASKS_MCP_AUTH_MODE: 'none',
    });
    expect((await mcp(env, bearer(readWriteToken))).status).toBe(503);
  });

  it('keeps read-only scope enforced on the agent API in token mode', async () => {
    const env = environment({
      TASKS_MCP_CREDENTIALS_JSON: credentials,
      TASKS_MCP_AUTH_MODE: 'token',
    });
    const response = await app.request(
      `${testOrigins.development}/api/agent/v1/tasks`,
      {
        method: 'POST',
        headers: { ...bearer(readOnlyToken), 'Content-Type': 'application/json' },
        body: '{}',
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'credential_read_only' });
  });
});
