import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import { tenantProfile } from '../../shared/tenant-profile';
import { TASKS_RELEASE_VERSION } from '../../shared/version';
import type { Env } from '../env';
import { publicOrigin } from '../runtime/identity-config';
import { tenantRuntimeAdapters } from '../runtime/tenant-adapters';
import type { McpClientIdentity } from './auth';
import { MCP_AGENT_EMAIL, MCP_CLIENT_HEADER, MCP_GATEWAY_HEADER } from './auth';
import {
  boundedMcpRequest,
  MCP_MAX_REQUEST_BODY_SIZE,
  MCP_MAX_TOOL_INPUT_ELEMENTS,
} from './limits';
import { registerTasksMcpTools, type TasksMcpApiCaller } from './tools';

type McpDependencies = {
  client: McpClientIdentity;
  env: Env;
  request: Request;
  callApi: TasksMcpApiCaller;
};

export function createTasksMcpHandler(dependencies: McpDependencies) {
  const hostname = new URL(publicOrigin(dependencies.env, dependencies.request.url)).hostname;
  const handler = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: tenantProfile.mcp.serverName, version: TASKS_RELEASE_VERSION },
        {
          instructions: tenantProfile.mcp.instructions,
          maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS,
        },
      );
      registerTasksMcpTools(server, {
        client: dependencies.client,
        profile: tenantProfile,
        backend: tenantRuntimeAdapters.createTaskReadBackend(dependencies.env),
        access: {
          identity: {
            principal: {
              reference: `agent:${dependencies.client.clientId}`,
              kind: 'agent',
              name: tenantProfile.agent.name,
              email: MCP_AGENT_EMAIL,
            },
            permissions: [],
          },
        },
        callApi: dependencies.callApi,
      });
      return server;
    },
    {
      route: '/mcp',
      corsOptions: false,
      allowedHostnames: [hostname],
      allowedOriginHostnames: [],
      legacy: 'stateless',
      maxRequestBodySize: MCP_MAX_REQUEST_BODY_SIZE,
      authContext: { props: { clientId: dependencies.client.clientId } },
    },
  );

  // Agents 0.28.1 does not forward the body limit into its legacy compatibility
  // handler/classifier. Bound bytes before either SDK path, retaining its
  // callable Worker interface, verified auth context and fetch/notify API.
  const fetch: typeof handler.fetch = async (request, options) => {
    const bounded = await boundedMcpRequest(request);
    if (!bounded) return Response.json({ error: 'request_too_large' }, { status: 413 });
    return handler.fetch(bounded, options);
  };
  const worker = async (...[request, env, ctx]: Parameters<typeof handler>) => {
    const bounded = await boundedMcpRequest(request);
    if (!bounded) return Response.json({ error: 'request_too_large' }, { status: 413 });
    return handler(bounded, env, ctx);
  };
  return Object.assign(worker, { fetch, notify: handler.notify });
}

export function createMcpApiCaller(
  appRequest: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  request: Request,
): TasksMcpApiCaller {
  const gatewayToken = request.headers.get(MCP_GATEWAY_HEADER) ?? '';
  const authorization = request.headers.get('Authorization');
  const clientToken = request.headers.get(MCP_CLIENT_HEADER);
  const origin = new URL(request.url).origin;
  return (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set(MCP_GATEWAY_HEADER, gatewayToken);
    if (authorization) headers.set('Authorization', authorization);
    if (clientToken) headers.set(MCP_CLIENT_HEADER, clientToken);
    return Promise.resolve(appRequest(new URL(path, origin), { ...init, headers }));
  };
}
