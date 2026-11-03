import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskReadBackend } from '../../src/core/contracts';
import type { Env } from '../../src/env';
import { MCP_MAX_REQUEST_BODY_SIZE, MCP_MAX_TOOL_INPUT_ELEMENTS } from '../../src/mcp/limits';
import { createTasksMcpHandler } from '../../src/mcp/server';
import { createStandaloneMcpHandler } from '../../src/mcp/standalone';
import { registerTasksMcpTools, type TasksMcpIdentity } from '../../src/mcp/tools';
import { tenantRuntimeAdapters } from '../../src/runtime/tenant-adapters';
import { testOrigins } from '../support/origins';

// These transport tests use the fake API caller below. Creating a deployment's
// real backend would require its private bindings and make this fixture depend
// on whichever tenant overlay is under test. No tested operation reads it.
beforeEach(() => {
  vi.spyOn(tenantRuntimeAdapters, 'createTaskReadBackend').mockReturnValue({} as TaskReadBackend);
});
afterEach(() => vi.restoreAllMocks());

const identity: TasksMcpIdentity = {
  clientId: 'security-fixture',
  name: 'Fixture Agent',
  runtime: 'test',
  scope: 'read_write',
};

function fixture(entryPoint: 'worker' | 'worker-callable' | 'standalone') {
  const callApi = vi.fn(async (_path: string, _init?: RequestInit) => Response.json({ tasks: [] }));
  if (entryPoint !== 'standalone') {
    const origin = testOrigins.development;
    const handler = createTasksMcpHandler({
      client: { ...identity, role: 'Agent' },
      env: { ENVIRONMENT: 'dev' } as Env,
      request: new Request(`${origin}/mcp`),
      callApi,
    });
    return {
      origin,
      callApi,
      fetch: (request: Request) =>
        entryPoint === 'worker'
          ? handler.fetch(request)
          : handler(request, {}, {} as ExecutionContext),
    };
  }
  const origin = 'https://mcp.example.test';
  const handler = createStandaloneMcpHandler(
    {
      tenant: 'fixture-tenant',
      serverName: 'fixture-tasks',
      instructions: 'Fixture tasks only.',
      authenticate: async () => identity,
      ready: async () => true,
      registerTools: (server, client) =>
        registerTasksMcpTools(server, {
          client,
          profile: {
            organizationName: 'Fixture',
            defaultProjectKey: 'FIXTURE',
            agent: { name: 'Fixture Agent', email: 'agent@example.test' },
          },
          backend: {} as TaskReadBackend,
          access: {
            identity: {
              principal: { reference: 'fixture', kind: 'agent', name: 'Fixture Agent' },
              permissions: [],
            },
          },
          callApi,
        }),
    },
    { publicOrigin: origin, release: 'fixture-release' },
  );
  return { origin, callApi, fetch: handler };
}

function body(method = 'tools/list', params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
}

function request(origin: string, data: string | ReadableStream<Uint8Array>) {
  return new Request(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      Host: new URL(origin).host,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: data,
    ...(typeof data === 'string' ? {} : { duplex: 'half' }),
  });
}

async function rpc(response: Response) {
  expect(response.status).toBe(200);
  const text = await response.text();
  const data = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? text
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
    : text;
  return JSON.parse(data ?? '{}');
}

describe.each(['worker', 'worker-callable', 'standalone'] as const)(
  '%s MCP security limits',
  (entryPoint) => {
    it('accepts the body byte boundary and cancels an oversized stream without tool dispatch', async () => {
      const { origin, fetch, callApi } = fixture(entryPoint);
      const accepted = await rpc(
        await fetch(request(origin, body().padEnd(MCP_MAX_REQUEST_BODY_SIZE, ' '))),
      );
      expect(accepted.result.tools).toHaveLength(6);

      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MCP_MAX_REQUEST_BODY_SIZE));
          controller.enqueue(new Uint8Array(1));
        },
        cancel,
      });
      const oversizedRequest = request(origin, stream);
      oversizedRequest.headers.set('Content-Length', '1');
      const result = await fetch(oversizedRequest);
      expect(result.status).toBe(413);
      expect(cancel).toHaveBeenCalledOnce();
      expect(callApi).not.toHaveBeenCalled();
    });

    it('accepts the largest task-create fields without changing the API payload', async () => {
      const { origin, fetch, callApi } = fixture(entryPoint);
      const arguments_ = {
        title: 't'.repeat(240),
        description: 'd'.repeat(10_000),
        taskTypes: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(60, 'x')),
        idempotencyKey: 'security-fixture-create',
      };
      const result = await rpc(
        await fetch(
          request(origin, body('tools/call', { name: 'task_create', arguments: arguments_ })),
        ),
      );
      expect(result.result.isError).not.toBe(true);
      expect(callApi).toHaveBeenCalledOnce();
      expect(JSON.parse(callApi.mock.calls[0]?.[1]?.body as string)).toMatchObject({
        title: arguments_.title,
        description: arguments_.description,
        taskTypes: arguments_.taskTypes,
      });
    });

    it('rejects an oversized task-type collection without API dispatch', async () => {
      const { origin, fetch, callApi } = fixture(entryPoint);
      const result = await rpc(
        await fetch(
          request(
            origin,
            body('tools/call', {
              name: 'task_create',
              arguments: {
                title: 'Bounded collection fixture',
                taskTypes: Array(21).fill(42),
                idempotencyKey: 'zod-collection-fixture',
              },
            }),
          ),
        ),
      );
      expect(result.result.isError).toBe(true);
      expect(result.result.content).toHaveLength(1);
      const message = result.result.content[0].text;
      expect(message.match(/taskTypes:/g)).toHaveLength(1);
      expect(message).toContain('<=20');
      expect(message).not.toMatch(/taskTypes\.\d+:/);
      expect(callApi).not.toHaveBeenCalled();
    });

    it('bounds array elements and nested object members before tool validation or API calls', async () => {
      const { origin, fetch, callApi } = fixture(entryPoint);
      // Two top-level keys plus 254 array elements are exactly the budget.
      const accepted = await rpc(
        await fetch(
          request(
            origin,
            body('tools/call', {
              name: 'task_list',
              arguments: {
                project: 'fixture',
                extra: Array(MCP_MAX_TOOL_INPUT_ELEMENTS - 2).fill(0),
              },
            }),
          ),
        ),
      );
      expect(accepted.result.isError).not.toBe(true);
      expect(callApi).toHaveBeenCalledOnce();
      callApi.mockClear();

      for (const extra of [
        Array(MCP_MAX_TOOL_INPUT_ELEMENTS - 1).fill(0),
        {
          nested: Object.fromEntries(
            Array.from({ length: MCP_MAX_TOOL_INPUT_ELEMENTS - 2 }, (_, i) => [String(i), 0]),
          ),
        },
      ]) {
        const result = await rpc(
          await fetch(
            request(
              origin,
              body('tools/call', { name: 'task_list', arguments: { project: 'fixture', extra } }),
            ),
          ),
        );
        expect(result.result.isError).toBe(true);
        expect(JSON.stringify(result.result)).toContain(String(MCP_MAX_TOOL_INPUT_ELEMENTS));
        expect(callApi).not.toHaveBeenCalled();
      }
    });

    it('rejects an overlong JSON-RPC batch without dispatching any tools', async () => {
      const { origin, fetch, callApi } = fixture(entryPoint);
      const result = await fetch(request(origin, `[${Array(101).fill(body()).join(',')}]`));
      expect(result.status).toBe(400);
      expect(callApi).not.toHaveBeenCalled();
    });

    it('keeps overlapping requests with the same JSON-RPC id isolated and remains usable', async () => {
      const { origin, fetch, callApi } = fixture(entryPoint);
      let completeFirst: (response: Response) => void = () => {};
      let startedFirst: () => void = () => {};
      const firstStarted = new Promise<void>((resolve) => {
        startedFirst = resolve;
      });
      callApi.mockImplementation(async (path) => {
        if (path.includes('project=first')) {
          startedFirst();
          return new Promise<Response>((resolve) => {
            completeFirst = resolve;
          });
        }
        return Response.json({ tasks: [{ key: 'second', title: 'Second request only' }] });
      });
      const first = fetch(
        request(origin, body('tools/call', { name: 'task_list', arguments: { project: 'first' } })),
      );
      await firstStarted;
      const second = await rpc(
        await fetch(
          request(
            origin,
            body('tools/call', { name: 'task_list', arguments: { project: 'second' } }),
          ),
        ),
      );
      completeFirst(Response.json({ tasks: [{ key: 'first', title: 'First request only' }] }));
      const firstResult = await rpc(await first);
      expect(firstResult.result.structuredContent.tasks).toEqual([
        { key: 'first', title: 'First request only' },
      ]);
      expect(second.result.structuredContent.tasks).toEqual([
        { key: 'second', title: 'Second request only' },
      ]);
      expect((await rpc(await fetch(request(origin, body())))).result.tools).toHaveLength(6);
    });
  },
);
