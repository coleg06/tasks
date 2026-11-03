/// <reference types="node" />

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import { createCredential } from '../../src/mcp/create-credential';
import { type RunningSelfHostedServer, startSelfHostedServer } from '../../src/self-hosted/server';
import { effectiveMigrationsDirectory } from '../support/migrations';

async function freePort() {
  return new Promise<number>((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

const legacy = tenantProfile.tasks.apiMode === 'legacy';
const writer = createCredential({ name: 'Writer', scope: 'read_write' });
const reader = createCredential({ name: 'Reader', scope: 'read' });

async function connect(base: string, token: string) {
  const client = new Client({ name: 'token-mode-e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      authProvider: { token: async () => token },
    }),
  );
  return client;
}

type TaskPayload = {
  task: { key: string; title: string; version: number };
  tasks: { key: string }[];
};

function payload(result: { content?: unknown; structuredContent?: unknown }) {
  return result.structuredContent as TaskPayload;
}

// A fresh public install: loopback server, SQLite, MCP in token mode, no gateway secret anywhere.
describe.skipIf(!legacy)('self-hosted MCP in token mode (real server, real MCP client)', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-mcp-token-'));
  let running: RunningSelfHostedServer;
  let base = '';

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    running = await startSelfHostedServer({
      ENVIRONMENT: 'local',
      RELEASE_SHA: 'e2e',
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
      GOOGLE_CLIENT_ID: 'e2e-client-id',
      GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
      TASKS_SITE_HOST: '127.0.0.1',
      TASKS_SITE_PORT: String(port),
      TASKS_DATASTORE: 'sqlite',
      TASKS_SQLITE_PATH: join(directory, 'data', 'tasks.db'),
      TASKS_MIGRATIONS_DIR: effectiveMigrationsDirectory(),
      TASKS_SCHEDULER: 'disabled',
      TASKS_MCP_ENABLED: 'true',
      TASKS_MCP_AUTH_MODE: 'token',
      TASKS_MCP_CREDENTIALS_JSON: JSON.stringify({ version: 1, credentials: [writer, reader] }),
    });
  });

  afterAll(async () => {
    await running?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('is ready, and rejects an unauthenticated or wrongly authenticated call', async () => {
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
    const wrong = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${'x'.repeat(40)}` },
      body: '{}',
    });
    expect(wrong.status).toBe(401);
  });

  it('initializes, lists tools, and round-trips a task read and write', async () => {
    const client = await connect(base, writer.token);
    try {
      expect(client.getServerVersion()?.name).toBe(tenantProfile.mcp.serverName);
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(['task_list', 'task_create', 'task_update']));

      const created = payload(
        await client.callTool({
          name: 'task_create',
          arguments: { title: 'Token mode round trip', idempotencyKey: 'token-mode-create-1' },
        }),
      );
      const key = created.task.key;
      expect(key).toBeTruthy();

      const fetched = payload(
        await client.callTool({ name: 'task_get', arguments: { task: key } }),
      );
      expect(fetched.task.title).toBe('Token mode round trip');

      const updated = payload(
        await client.callTool({
          name: 'task_update',
          arguments: {
            task: key,
            version: fetched.task.version,
            title: 'Token mode round trip (edited)',
            idempotencyKey: 'token-mode-update-1',
          },
        }),
      );
      expect(updated.task.title).toBe('Token mode round trip (edited)');

      const listed = payload(
        await client.callTool({ name: 'task_list', arguments: { view: 'all' } }),
      );
      expect(listed.tasks.map((task) => task.key)).toContain(key);
    } finally {
      await client.close();
    }
  });

  it('lets a read-only credential read but not write', async () => {
    const client = await connect(base, reader.token);
    try {
      const listed = payload(
        await client.callTool({ name: 'task_list', arguments: { view: 'all' } }),
      );
      expect(listed.tasks.length).toBeGreaterThan(0);
      const denied = await client
        .callTool({
          name: 'task_create',
          arguments: { title: 'Must not exist', idempotencyKey: 'token-mode-denied-1' },
        })
        .then(
          (result) => result,
          (error: Error) => error,
        );
      const text = denied instanceof Error ? denied.message : JSON.stringify(denied);
      expect(text).toContain('read-only');
    } finally {
      await client.close();
    }
  });
});

describe.skipIf(!legacy)('a fresh install reports MCP off', () => {
  it('answers 404 on /mcp and the agent API when no MCP setting exists', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-mcp-off-'));
    const port = await freePort();
    const server = await startSelfHostedServer({
      ENVIRONMENT: 'local',
      RELEASE_SHA: 'e2e',
      SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
      GOOGLE_CLIENT_ID: 'e2e-client-id',
      GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
      TASKS_SITE_HOST: '127.0.0.1',
      TASKS_SITE_PORT: String(port),
      TASKS_DATASTORE: 'sqlite',
      TASKS_SQLITE_PATH: join(directory, 'data', 'tasks.db'),
      TASKS_MIGRATIONS_DIR: effectiveMigrationsDirectory(),
      TASKS_SCHEDULER: 'disabled',
    });
    try {
      const base = `http://127.0.0.1:${port}`;
      expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
      expect((await fetch(`${base}/api/agent/v1/tasks`)).status).toBe(404);
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
    } finally {
      await server.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses to start in production when MCP is enabled with missing or invalid settings', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tasks-mcp-prod-'));
    try {
      const base = {
        ENVIRONMENT: 'production',
        RELEASE_SHA: 'e2e',
        SESSION_SECRET: 'e2e-session-secret-0123456789abcdef0123456789',
        GOOGLE_CLIENT_ID: 'e2e-client-id',
        GOOGLE_CLIENT_SECRET: 'e2e-client-secret',
        TASKS_SITE_HOST: '127.0.0.1',
        TASKS_SITE_PORT: String(await freePort()),
        TASKS_DATASTORE: 'sqlite',
        TASKS_SQLITE_PATH: join(directory, 'data', 'tasks.db'),
        TASKS_MIGRATIONS_DIR: effectiveMigrationsDirectory(),
      };
      const missing = await startSelfHostedServer({ ...base, TASKS_MCP_ENABLED: 'true' }).then(
        () => null,
        (error: Error) => error,
      );
      expect(missing?.message).toBe(
        'Invalid MCP configuration; set: TASKS_MCP_CREDENTIALS_JSON, TASKS_MCP_GATEWAY_SECRET',
      );
      const invalid = await startSelfHostedServer({ ...base, TASKS_MCP_ENABLED: 'yes' }).then(
        () => null,
        (error: Error) => error,
      );
      expect(invalid?.message).toBe('Invalid MCP configuration; set: TASKS_MCP_ENABLED');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
