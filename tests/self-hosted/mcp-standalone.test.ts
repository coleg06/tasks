import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import type { TaskReadBackend } from '../../src/core/contracts';
import {
  createStandaloneMcpHandler,
  loadTasksMcpComposition,
  type TasksMcpComposition,
} from '../../src/mcp/standalone';
import { registerTasksMcpTools, type TasksMcpIdentity } from '../../src/mcp/tools';

const identity: TasksMcpIdentity = {
  clientId: 'fixture-client',
  name: 'Fixture Agent',
  runtime: 'opencode',
  scope: 'read_write',
};
const profile = {
  organizationName: 'Fixture tenant',
  defaultProjectKey: 'FIXTURE',
  agent: { name: 'Fixture Agent', email: 'agent@example.test' },
};
const access = {
  identity: {
    principal: { reference: 'fixture-agent', kind: 'agent' as const, ...profile.agent },
    permissions: [],
  },
};

function fixture() {
  const callApi = vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json({ tasks: [], verified: true }),
  );
  const backend = {
    resolveTaskReference: vi.fn(async () => ({
      outcome: 'resolved',
      reference: { native: 'opaque-1', display: 'T-1', aliases: [] },
    })),
  } as unknown as TaskReadBackend;
  const authenticate = vi.fn(async () => identity as TasksMcpIdentity | null);
  const ready = vi.fn(async () => true);
  const composition: TasksMcpComposition = {
    tenant: 'fixture-tenant',
    serverName: 'fixture-tasks',
    instructions: 'Fixture tenant tasks only.',
    authenticate,
    ready,
    registerTools(server, client) {
      registerTasksMcpTools(server, { client, profile, backend, access, callApi });
    },
  };
  const handler = createStandaloneMcpHandler(composition, {
    publicOrigin: 'https://mcp.example.test',
    release: 'fixture-release',
  });
  return { handler, authenticate, ready, callApi, backend, composition };
}

function request(method = 'tools/list', params = {}, headers = {}) {
  return new Request('https://mcp.example.test/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

async function rpc(response: Response) {
  const text = await response.text();
  if (response.headers.get('Content-Type')?.includes('text/event-stream')) {
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    return JSON.parse(data?.slice(6) ?? '{}');
  }
  return JSON.parse(text);
}

describe('standalone MCP composition', () => {
  it('serves the injected six-tool catalog to legacy Streamable HTTP clients', async () => {
    const { handler } = fixture();
    const result = await rpc(await handler(request()));
    expect(result.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'task_list',
      'task_search',
      'task_get',
      'task_create',
      'task_update',
      'task_comment',
    ]);
    expect(JSON.stringify(result)).toContain('Fixture tenant');
    // The injected tenant, not the compiled default profile, names the tools.
    expect(JSON.stringify(result)).not.toContain(`${tenantProfile.organizationName} tasks`);
  });

  it('uses only the injected reference backend and effective access context', async () => {
    const { handler, backend, callApi } = fixture();
    await rpc(
      await handler(request('tools/call', { name: 'task_get', arguments: { task: 'T-1' } })),
    );
    expect(backend.resolveTaskReference).toHaveBeenCalledWith('T-1', access);
    expect(callApi).toHaveBeenCalledWith('/api/agent/v1/tasks/opaque-1', undefined);
  });

  it('preserves attribution, idempotency headers, defaults and revision preconditions', async () => {
    const { handler, callApi } = fixture();
    await rpc(
      await handler(
        request('tools/call', {
          name: 'task_create',
          arguments: { title: 'Fixture', idempotencyKey: 'fixture-create-1' },
        }),
      ),
    );
    expect(callApi).toHaveBeenCalledWith(
      '/api/agent/v1/tasks',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'fixture-create-1' }),
      }),
    );
    expect(JSON.parse(callApi.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      assigneeEmail: 'agent@example.test',
      projectKey: 'FIXTURE',
    });
    await rpc(
      await handler(
        request('tools/call', {
          name: 'task_update',
          arguments: {
            task: 'T-1',
            version: 7,
            title: 'Changed',
            idempotencyKey: 'fixture-update-1',
          },
        }),
      ),
    );
    expect(callApi.mock.calls[1]?.[1]?.headers).toMatchObject({
      'If-Match': '"7"',
      'Idempotency-Key': 'fixture-update-1',
    });
    await rpc(
      await handler(
        request('tools/call', {
          name: 'task_comment',
          arguments: { task: 'T-1', body: 'Verified', idempotencyKey: 'fixture-comment-1' },
        }),
      ),
    );
    expect(JSON.parse(callApi.mock.calls[2]?.[1]?.body as string)).toEqual({
      body: '[Fixture Agent via opencode] Verified',
    });
  });

  it('rejects writes from read-only identities without invoking the canonical API', async () => {
    const { handler, authenticate, callApi } = fixture();
    authenticate.mockResolvedValue({ ...identity, scope: 'read' });
    const result = await rpc(
      await handler(
        request('tools/call', {
          name: 'task_create',
          arguments: { title: 'Denied', idempotencyKey: 'fixture-denied-1' },
        }),
      ),
    );
    expect(result.result.isError).toBe(true);
    expect(callApi).not.toHaveBeenCalled();
  });

  it('rejects host/origin attacks before authentication and revalidates every request', async () => {
    const { handler, authenticate } = fixture();
    expect((await handler(request('tools/list', {}, { Host: 'attacker.test' }))).status).toBe(403);
    expect(
      (await handler(request('tools/list', {}, { Origin: 'https://mcp.example.test' }))).status,
    ).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    await handler(request());
    authenticate.mockResolvedValue({ ...identity, expiresAt: 1 });
    expect((await handler(request())).status).toBe(401);
    authenticate.mockResolvedValue(null);
    expect((await handler(request())).status).toBe(401);
    expect(authenticate).toHaveBeenCalledTimes(3);
  });

  it('bounds bodies, fails closed on dependency failures and redacts their detail', async () => {
    const { handler, ready } = fixture();
    expect(
      (
        await handler(
          new Request('https://mcp.example.test/mcp', { method: 'POST', body: 'x'.repeat(65_537) }),
        )
      ).status,
    ).toBe(413);
    ready.mockRejectedValue(new Error('sensitive-upstream-detail'));
    const result = await handler(request());
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain('sensitive-upstream-detail');
    expect((await handler(new Request('http://localhost/live'))).status).toBe(200);
    expect((await handler(new Request('http://localhost/ready'))).status).toBe(503);
    expect((await handler(new Request('https://mcp.example.test/api/tasks'))).status).toBe(404);
  });

  it('requires explicit deployment configuration and sanitizes composition-load failures', async () => {
    await expect(loadTasksMcpComposition({})).rejects.toThrow('absolute module path');
    const root = await mkdtemp(join(tmpdir(), 'tasks-mcp-fixture-'));
    const modulePath = join(root, 'composition.mjs');
    await writeFile(modulePath, 'throw new Error("sensitive-module-detail");');
    await expect(
      loadTasksMcpComposition({ TASKS_MCP_COMPOSITION_MODULE: modulePath }),
    ).rejects.toThrow('Tasks MCP composition could not be loaded');
    const { composition } = fixture();
    expect(() =>
      createStandaloneMcpHandler(composition, {
        publicOrigin: 'https://user:password@example.test',
        release: 'x',
      }),
    ).toThrow('explicit HTTP(S) origin');
    expect(() =>
      createStandaloneMcpHandler(composition, {
        publicOrigin: 'https://mcp.example.test',
        release: '',
      }),
    ).toThrow('RELEASE_SHA');
  });
});
