import { describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import { authenticateMcpRequest, MCP_CLIENT_HEADER, MCP_GATEWAY_HEADER } from '../src/mcp/auth';
import { testOrigins } from './support/origins';

const gateway = 'gateway-test-value-that-is-at-least-32-characters';
const clientToken = 'client-test-value-that-is-at-least-32-characters';
const env = {
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
} as Env;

function request(headers: HeadersInit = {}) {
  return new Request(`${testOrigins.production}/mcp`, { headers });
}

describe('MCP authentication', () => {
  it('requires both the private gateway and client credentials', async () => {
    await expect(
      authenticateMcpRequest(request({ Authorization: `Bearer ${clientToken}` }), env),
    ).rejects.toMatchObject({
      code: 'gateway_rejected',
      status: 403,
    });
    await expect(
      authenticateMcpRequest(request({ [MCP_GATEWAY_HEADER]: gateway }), env),
    ).rejects.toMatchObject({
      code: 'client_rejected',
      status: 401,
    });
  });

  it('accepts a bearer token or the non-browser MCP token header', async () => {
    const bearer = await authenticateMcpRequest(
      request({ Authorization: `Bearer ${clientToken}`, [MCP_GATEWAY_HEADER]: gateway }),
      env,
    );
    const header = await authenticateMcpRequest(
      request({ [MCP_CLIENT_HEADER]: clientToken, [MCP_GATEWAY_HEADER]: gateway }),
      env,
    );
    expect(bearer).toEqual(header);
    expect(bearer).toMatchObject({
      clientId: 'codex-test',
      role: 'Agent',
      runtime: 'codex',
      scope: 'read_write',
    });
    expect(bearer).not.toHaveProperty('token');
  });

  it('rejects expired credentials', async () => {
    const expiredEnv = {
      ...env,
      TASKS_MCP_CREDENTIALS_JSON: JSON.stringify({
        version: 1,
        credentials: [
          {
            clientId: 'expired-test',
            name: 'Expired Test',
            role: 'Agent',
            runtime: 'codex',
            scope: 'read',
            token: clientToken,
            expiresAt: 10,
          },
        ],
      }),
    };
    await expect(
      authenticateMcpRequest(
        request({ Authorization: `Bearer ${clientToken}`, [MCP_GATEWAY_HEADER]: gateway }),
        expiredEnv,
        11,
      ),
    ).rejects.toMatchObject({ code: 'client_rejected', status: 401 });
  });

  describe('modes', () => {
    const noGateway = { TASKS_MCP_CREDENTIALS_JSON: env.TASKS_MCP_CREDENTIALS_JSON } as Env;
    const tokenMode = { ...noGateway, TASKS_MCP_AUTH_MODE: 'token' } as Env;

    it('rejects the default mode without a gateway secret, even with a valid client token', async () => {
      await expect(
        authenticateMcpRequest(request({ Authorization: `Bearer ${clientToken}` }), noGateway),
      ).rejects.toMatchObject({ code: 'not_configured', status: 503 });
      await expect(
        authenticateMcpRequest(request({ Authorization: `Bearer ${clientToken}` }), {
          ...noGateway,
          TASKS_MCP_AUTH_MODE: 'gateway-and-token',
        } as Env),
      ).rejects.toMatchObject({ code: 'not_configured', status: 503 });
    });

    it('token mode needs no gateway secret and ignores a supplied gateway header', async () => {
      const bearer = await authenticateMcpRequest(
        request({ Authorization: `Bearer ${clientToken}` }),
        tokenMode,
      );
      const header = await authenticateMcpRequest(
        request({ [MCP_CLIENT_HEADER]: clientToken, [MCP_GATEWAY_HEADER]: 'not-the-secret' }),
        tokenMode,
      );
      expect(bearer).toEqual(header);
      expect(bearer.scope).toBe('read_write');
    });

    it('token mode still rejects missing and wrong tokens', async () => {
      await expect(authenticateMcpRequest(request(), tokenMode)).rejects.toMatchObject({
        code: 'client_rejected',
        status: 401,
      });
      await expect(
        authenticateMcpRequest(request({ Authorization: 'Bearer wrong' }), tokenMode),
      ).rejects.toMatchObject({ code: 'client_rejected', status: 401 });
    });

    it('token mode keeps expiry and reports the read-only scope', async () => {
      const readOnly = {
        TASKS_MCP_AUTH_MODE: 'token',
        TASKS_MCP_CREDENTIALS_JSON: JSON.stringify({
          version: 1,
          credentials: [
            {
              clientId: 'reader',
              name: 'Reader',
              role: 'Agent',
              runtime: 'test',
              scope: 'read',
              token: clientToken,
              expiresAt: 100,
            },
          ],
        }),
      } as Env;
      const identity = await authenticateMcpRequest(
        request({ Authorization: `Bearer ${clientToken}` }),
        readOnly,
        50,
      );
      expect(identity.scope).toBe('read');
      await expect(
        authenticateMcpRequest(request({ Authorization: `Bearer ${clientToken}` }), readOnly, 100),
      ).rejects.toMatchObject({ code: 'client_rejected' });
    });

    it('treats an unknown mode as not configured', async () => {
      await expect(
        authenticateMcpRequest(request({ Authorization: `Bearer ${clientToken}` }), {
          ...tokenMode,
          TASKS_MCP_AUTH_MODE: 'open',
        } as Env),
      ).rejects.toMatchObject({ code: 'not_configured', status: 503 });
    });
  });
});
