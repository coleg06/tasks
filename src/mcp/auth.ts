import { z } from 'zod';
import { tenantProfile } from '../../shared/tenant-profile';
import { constantTimeEqual } from '../auth/google';
import type { Env } from '../env';
import { sha256Hex } from '../mobile/assertion';

export const MCP_GATEWAY_HEADER = tenantProfile.mcp.gatewayHeader;
export const MCP_CLIENT_HEADER = tenantProfile.mcp.clientHeader;
export const MCP_AGENT_EMAIL = tenantProfile.agent.email;

const credentialSchema = z.object({
  clientId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  name: z.string().trim().min(1).max(100),
  role: z.literal('Agent'),
  runtime: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,31}$/),
  scope: z.enum(['read', 'read_write']),
  token: z.string().min(32).max(512),
  expiresAt: z.number().int().positive().optional(),
});

const credentialsSchema = z.object({
  version: z.literal(1),
  credentials: z.array(credentialSchema).min(1).max(32),
});

export type McpClientIdentity = Omit<z.infer<typeof credentialSchema>, 'token'>;

export class McpAuthenticationError extends Error {
  constructor(
    readonly code: 'not_configured' | 'gateway_rejected' | 'client_rejected',
    readonly status: 401 | 403 | 503,
  ) {
    super(code);
    this.name = 'McpAuthenticationError';
  }
}

function bearerToken(request: Request) {
  const authorization = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? request.headers.get(MCP_CLIENT_HEADER) ?? '';
}

async function tokenMatches(candidate: string, expected: string) {
  if (!candidate || !expected) return false;
  const [candidateHash, expectedHash] = await Promise.all([
    sha256Hex(candidate),
    sha256Hex(expected),
  ]);
  return constantTimeEqual(candidateHash, expectedHash);
}

export async function authenticateMcpRequest(
  request: Request,
  env: Env,
  now = Math.floor(Date.now() / 1000),
): Promise<McpClientIdentity> {
  const gatewaySecret = env.TASKS_MCP_GATEWAY_SECRET ?? '';
  const credentialsJson = env.TASKS_MCP_CREDENTIALS_JSON ?? '';
  if (gatewaySecret.length < 32 || !credentialsJson) {
    throw new McpAuthenticationError('not_configured', 503);
  }
  if (!(await tokenMatches(request.headers.get(MCP_GATEWAY_HEADER) ?? '', gatewaySecret))) {
    throw new McpAuthenticationError('gateway_rejected', 403);
  }

  let parsed: z.infer<typeof credentialsSchema>;
  try {
    parsed = credentialsSchema.parse(JSON.parse(credentialsJson));
  } catch {
    throw new McpAuthenticationError('not_configured', 503);
  }

  const suppliedToken = bearerToken(request);
  let matched: z.infer<typeof credentialSchema> | undefined;
  for (const credential of parsed.credentials) {
    if (await tokenMatches(suppliedToken, credential.token)) matched = credential;
  }
  if (!matched || (matched.expiresAt !== undefined && matched.expiresAt <= now)) {
    throw new McpAuthenticationError('client_rejected', 401);
  }
  const { token: _token, ...identity } = matched;
  return identity;
}

export function mcpAuthErrorResponse(error: McpAuthenticationError) {
  return new Response(JSON.stringify({ error: error.code }), {
    status: error.status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=UTF-8',
      ...(error.status === 401
        ? { 'WWW-Authenticate': `Bearer realm="${tenantProfile.mcp.serverName}"` }
        : {}),
    },
  });
}
