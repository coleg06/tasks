import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/app';
import type { Env } from '../src/env';
import { MCP_GATEWAY_HEADER } from '../src/mcp/auth';
import {
  McpRateObserver,
  mcpRateObservationEnabled,
  observeMcpClientRequest,
} from '../src/mcp/rate-observer';
import { testOrigins } from './support/origins';
import {
  isTenantConfigurationQuery,
  matchingTenantConfigurationRow,
} from './tenant-configuration-fixture';

const gateway = 'gateway-test-value-that-is-at-least-32-characters';
const clientToken = 'client-test-value-that-is-at-least-32-characters';
const credentials = JSON.stringify({
  version: 1,
  credentials: [
    {
      clientId: 'observe-test',
      name: 'Observe Test',
      role: 'Agent',
      runtime: 'test',
      scope: 'read_write',
      token: clientToken,
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
    TASKS_MCP_GATEWAY_SECRET: gateway,
    TASKS_MCP_CREDENTIALS_JSON: credentials,
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

function mcp(env: Env, token: string) {
  return app.request(
    `${testOrigins.development}/mcp`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        Host: new URL(testOrigins.development).host,
        Authorization: `Bearer ${token}`,
        [MCP_GATEWAY_HEADER]: gateway,
      },
      body: initialize,
    },
    env,
  );
}

function observedWarnings(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls
    .map(([line]) => (typeof line === 'string' ? line : ''))
    .filter((line) => line.includes('mcp.rate_observed'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// The shared observer is process-wide; give each route test its own window.
let minute = 0;
function freshWindow() {
  minute += 2;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 13, 5, minute, 0));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('McpRateObserver', () => {
  it('reports once per window, only after the threshold', () => {
    const observer = new McpRateObserver();
    const start = Date.UTC(2026, 10, 13, 5, 0, 0);
    expect(observer.record('client_requests', 'a', 2, start)).toBeNull();
    expect(observer.record('client_requests', 'a', 2, start + 1)).toBeNull();
    expect(observer.record('client_requests', 'a', 2, start + 2)).toEqual({
      kind: 'client_requests',
      key: 'a',
      count: 3,
      threshold: 2,
      windowSeconds: 60,
    });
    expect(observer.record('client_requests', 'a', 2, start + 3)).toBeNull();
    // Other keys and the next window count separately.
    expect(observer.record('client_requests', 'b', 2, start + 4)).toBeNull();
    expect(observer.record('client_requests', 'a', 2, start + 60_000)).toBeNull();
  });

  it('keeps a bounded number of keys', () => {
    const observer = new McpRateObserver();
    const now = Date.UTC(2026, 10, 13, 5, 0, 0);
    for (let index = 0; index < 5_000; index += 1) {
      observer.record('client_requests', `key-${index}`, 10, now);
    }
    // A key evicted under pressure starts again rather than growing memory.
    expect(observer.record('client_requests', 'key-0', 0, now)).not.toBeNull();
  });

  it('is off unless explicitly enabled', () => {
    expect(mcpRateObservationEnabled({})).toBe(false);
    expect(mcpRateObservationEnabled({ TASKS_MCP_RATE_OBSERVE: 'yes' })).toBe(false);
    expect(mcpRateObservationEnabled({ TASKS_MCP_RATE_OBSERVE: ' TRUE ' })).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (let index = 0; index < 1_000; index += 1) {
      observeMcpClientRequest({ TASKS_MCP_RATE_OBSERVE_CLIENT_REQUESTS: '1' }, 'off-client');
    }
    expect(observedWarnings(warn)).toEqual([]);
  });
});

describe('MCP route rate observation', () => {
  it('logs a busy client without changing its responses', async () => {
    freshWindow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = environment({
      TASKS_MCP_RATE_OBSERVE: 'true',
      TASKS_MCP_RATE_OBSERVE_CLIENT_REQUESTS: '1',
    });
    const statuses = [];
    for (let index = 0; index < 3; index += 1) statuses.push((await mcp(env, clientToken)).status);
    expect(statuses).toEqual([200, 200, 200]);
    expect(observedWarnings(warn)).toEqual([
      expect.objectContaining({ kind: 'client_requests', key: 'observe-test', count: 2 }),
    ]);
  });

  it('logs repeated rejected credentials and still answers 401', async () => {
    freshWindow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = environment({
      TASKS_MCP_RATE_OBSERVE: 'true',
      TASKS_MCP_RATE_OBSERVE_FAILED_AUTH: '2',
    });
    const statuses = [];
    for (let index = 0; index < 4; index += 1) {
      statuses.push((await mcp(env, 'wrong-token-value-that-is-at-least-32-chars')).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401]);
    const warnings = observedWarnings(warn);
    expect(warnings).toEqual([
      expect.objectContaining({ kind: 'failed_auth', key: 'all', count: 3, threshold: 2 }),
    ]);
    expect(JSON.stringify(warnings)).not.toContain('wrong-token');
  });

  it('logs nothing when observation is off', async () => {
    freshWindow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = environment({ TASKS_MCP_RATE_OBSERVE_FAILED_AUTH: '1' });
    for (let index = 0; index < 3; index += 1) {
      expect((await mcp(env, 'wrong-token-value-that-is-at-least-32-chars')).status).toBe(401);
    }
    expect(observedWarnings(warn)).toEqual([]);
  });
});
