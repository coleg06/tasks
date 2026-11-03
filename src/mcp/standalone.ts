import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { TASKS_RELEASE_VERSION } from '../../shared/version';
import {
  boundedMcpRequest,
  MCP_MAX_REQUEST_BODY_SIZE,
  MCP_MAX_TOOL_INPUT_ELEMENTS,
} from './limits';
import type { TasksMcpIdentity } from './tools';

/** A deployment supplies this contract; the image has no default tenant. */
export interface TasksMcpComposition {
  readonly tenant: string;
  readonly serverName: string;
  readonly instructions: string;
  /** Revalidate credentials on every request, including expiry and file reload. */
  authenticate(request: Request): Promise<TasksMcpIdentity | null>;
  /** Register tenant-compatible tools backed by the canonical audited task service. */
  registerTools(server: McpServer, identity: TasksMcpIdentity): void;
  /** Includes required backend, identity, capability and durable-ledger checks. */
  ready(): Promise<boolean>;
}

export type TasksMcpRuntimeConfiguration = {
  readonly publicOrigin: string;
  readonly release: string;
};

function response(status: number, error: string) {
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } });
}

function publicOrigin(value: string) {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    ['0.0.0.0', '[::]'].includes(url.hostname)
  ) {
    throw new Error('TASKS_MCP_PUBLIC_ORIGIN must be an explicit HTTP(S) origin');
  }
  return url;
}

export function createStandaloneMcpHandler(
  composition: TasksMcpComposition,
  configuration: TasksMcpRuntimeConfiguration,
) {
  const origin = publicOrigin(configuration.publicOrigin);
  if (!configuration.release.trim()) throw new Error('RELEASE_SHA is required');
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(composition.tenant)) {
    throw new Error('Composition tenant is required');
  }
  if (!composition.serverName.trim() || !composition.instructions.trim()) {
    throw new Error('Composition server identity is required');
  }

  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname === '/live' && ['GET', 'HEAD'].includes(request.method)) {
      return Response.json({ ok: true });
    }
    if (url.pathname === '/ready' && ['GET', 'HEAD'].includes(request.method)) {
      let ready = false;
      try {
        ready = await composition.ready();
      } catch {
        // Deployment or upstream errors must not become public response/log content.
      }
      return Response.json(
        { ok: ready },
        { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (url.pathname !== '/mcp') return response(404, 'not_found');
    if (
      url.host !== origin.host ||
      (request.headers.has('host') && request.headers.get('host') !== origin.host)
    ) {
      return response(403, 'host_rejected');
    }
    // Native MCP clients send no Origin. Browser requests require a separate reviewed surface.
    if (request.headers.has('origin')) return response(403, 'origin_rejected');
    try {
      const identity = await composition.authenticate(request);
      if (
        !identity ||
        (identity.expiresAt !== undefined && identity.expiresAt <= Date.now() / 1000)
      ) {
        return response(401, 'client_rejected');
      }
      if (!(await composition.ready())) return response(503, 'not_ready');
      const bounded = await boundedMcpRequest(request);
      if (!bounded) return response(413, 'request_too_large');
      const handler = createMcpHandler(
        () => {
          const server = new McpServer(
            { name: composition.serverName, version: TASKS_RELEASE_VERSION },
            {
              instructions: composition.instructions,
              maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
            },
          );
          composition.registerTools(server, identity);
          return server;
        },
        {
          legacy: 'stateless',
          maxRequestBodySize: MCP_MAX_REQUEST_BODY_SIZE,
        },
      );
      return await handler.fetch(bounded, {
        authInfo: {
          token: 'validated-by-deployment-composition',
          clientId: identity.clientId,
          scopes: [identity.scope],
          ...(identity.expiresAt === undefined ? {} : { expiresAt: identity.expiresAt }),
        },
      });
    } catch {
      return response(503, 'mcp_unavailable');
    }
  };
}

export async function loadTasksMcpComposition(source: NodeJS.ProcessEnv = process.env) {
  const modulePath = source.TASKS_MCP_COMPOSITION_MODULE;
  if (!modulePath?.startsWith('/')) {
    throw new Error('TASKS_MCP_COMPOSITION_MODULE must be an absolute module path');
  }
  try {
    const module = await import(pathToFileURL(resolve(modulePath)).href);
    if (typeof module.createComposition !== 'function') throw new Error();
    const composition: TasksMcpComposition = await module.createComposition(source);
    if (
      typeof composition.authenticate !== 'function' ||
      typeof composition.registerTools !== 'function' ||
      typeof composition.ready !== 'function'
    ) {
      throw new Error();
    }
    return composition;
  } catch {
    throw new Error('Tasks MCP composition could not be loaded');
  }
}

export async function startStandaloneMcpServer(source: NodeJS.ProcessEnv = process.env) {
  const composition = await loadTasksMcpComposition(source);
  const port = Number(source.TASKS_MCP_PORT ?? '8090');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('TASKS_MCP_PORT must be an integer between 1 and 65535');
  }
  const fetch = createStandaloneMcpHandler(composition, {
    publicOrigin: source.TASKS_MCP_PUBLIC_ORIGIN ?? '',
    release: source.RELEASE_SHA ?? '',
  });
  return serve({ fetch, hostname: source.TASKS_MCP_HOST ?? '0.0.0.0', port });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  startStandaloneMcpServer().catch(() => {
    console.error('Tasks MCP startup failed; verify deployment composition and configuration.');
    process.exitCode = 1;
  });
}
