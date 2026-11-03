import type { Env } from '../env';
import { parseCredentialRegistry } from './credentials';

/**
 * Per-server switch for the hosted MCP endpoint.
 *
 * `TASKS_MCP_ENABLED`
 *   - `false`: `/mcp` (and the agent API behind it) answers 404, exactly as an absent route.
 *   - `true`: enabled. Missing settings keep it answering 503 `not_configured` and are named by
 *     startup (production, self-hosted) and `/readyz`.
 *   - unset or blank: enabled only when `TASKS_MCP_CREDENTIALS_JSON` is set, so a deployment that
 *     already has credentials is unchanged and a fresh install is off.
 *   - anything else is a configuration error and fails closed.
 *
 * `TASKS_MCP_AUTH_MODE`
 *   - `gateway-and-token` (default): a private gateway secret and a client token are both required.
 *   - `token`: the client token alone. Must be chosen explicitly; there is no fallback to it.
 */
export type McpAuthMode = 'gateway-and-token' | 'token';
export type McpAvailability = 'disabled' | 'enabled' | 'invalid';

type McpSettings = Pick<
  Env,
  | 'TASKS_MCP_ENABLED'
  | 'TASKS_MCP_AUTH_MODE'
  | 'TASKS_MCP_CREDENTIALS_JSON'
  | 'TASKS_MCP_GATEWAY_SECRET'
>;

function present(value: string | undefined) {
  return value !== undefined && value.trim() !== '';
}

function explicitEnabled(env: McpSettings): boolean | 'invalid' | null {
  if (!present(env.TASKS_MCP_ENABLED)) return null;
  const value = (env.TASKS_MCP_ENABLED as string).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return 'invalid';
}

/** The configured authentication mode, or `invalid` for any value other than the two documented. */
export function mcpAuthMode(env: Pick<Env, 'TASKS_MCP_AUTH_MODE'>): McpAuthMode | 'invalid' {
  if (!present(env.TASKS_MCP_AUTH_MODE)) return 'gateway-and-token';
  const value = (env.TASKS_MCP_AUTH_MODE as string).trim();
  return value === 'gateway-and-token' || value === 'token' ? value : 'invalid';
}

export function mcpAvailability(env: McpSettings): McpAvailability {
  const explicit = explicitEnabled(env);
  if (explicit === 'invalid') return 'invalid';
  if (explicit !== null) return explicit ? 'enabled' : 'disabled';
  return present(env.TASKS_MCP_CREDENTIALS_JSON) ? 'enabled' : 'disabled';
}

/**
 * Names (never values) of the settings that keep MCP from working as configured. Empty when MCP
 * is off, or enabled only implicitly (an existing deployment that predates `TASKS_MCP_ENABLED`).
 */
export function mcpConfigurationProblems(env: McpSettings): string[] {
  const problems: string[] = [];
  const explicit = explicitEnabled(env);
  if (explicit === 'invalid') problems.push('TASKS_MCP_ENABLED');
  const mode = mcpAuthMode(env);
  if (mode === 'invalid') problems.push('TASKS_MCP_AUTH_MODE');
  if (explicit !== true) return problems;
  if (!parseCredentialRegistry(env.TASKS_MCP_CREDENTIALS_JSON)) {
    problems.push('TASKS_MCP_CREDENTIALS_JSON');
  }
  if (mode === 'gateway-and-token' && (env.TASKS_MCP_GATEWAY_SECRET ?? '').length < 32) {
    problems.push('TASKS_MCP_GATEWAY_SECRET');
  }
  return problems;
}
