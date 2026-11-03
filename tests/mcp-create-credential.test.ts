import { describe, expect, it } from 'vitest';
import { mcpConfigurationProblems } from '../src/mcp/config';
import { createCredential, generateToken, parseArguments } from '../src/mcp/create-credential';
import { credentialsSchema } from '../src/mcp/credentials';

describe('mcp:create-credential', () => {
  it('generates strong, distinct tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateToken));
    expect(tokens.size).toBe(50);
    for (const token of tokens) expect(token).toMatch(/^mcp_[A-Za-z0-9_-]{43}$/);
  });

  it('produces an entry the registry accepts, in the existing format', () => {
    const entry = createCredential({ name: 'Claude Laptop', scope: 'read_write' }, 1_000);
    expect(entry).toMatchObject({
      clientId: 'claude-laptop',
      name: 'Claude Laptop',
      role: 'Agent',
      runtime: 'mcp',
      scope: 'read_write',
    });
    expect(entry).not.toHaveProperty('expiresAt');
    const registry = { version: 1, credentials: [entry] };
    expect(credentialsSchema.parse(registry)).toEqual(registry);
    expect(
      mcpConfigurationProblems({
        TASKS_MCP_ENABLED: 'true',
        TASKS_MCP_AUTH_MODE: 'token',
        TASKS_MCP_CREDENTIALS_JSON: JSON.stringify(registry),
      }),
    ).toEqual([]);
  });

  it('supports runtime, client id and expiry', () => {
    const entry = createCredential(
      { name: 'CI', scope: 'read', runtime: 'ci', clientId: 'ci-reader', expiresInDays: 2 },
      1_000,
    );
    expect(entry).toMatchObject({
      runtime: 'ci',
      clientId: 'ci-reader',
      expiresAt: 1_000 + 172_800,
    });
  });

  it('validates arguments', () => {
    expect(parseArguments(['--name', 'A B', '--scope', 'read'])).toEqual({
      name: 'A B',
      scope: 'read',
    });
    expect(() => parseArguments(['--scope', 'read'])).toThrow('--name is required');
    expect(() => parseArguments(['--name', 'x', '--scope', 'admin'])).toThrow('--scope');
    expect(() => parseArguments(['--name', 'x', '--scope', 'read', '--bogus', '1'])).toThrow(
      'Unknown argument',
    );
    expect(() =>
      parseArguments(['--name', 'x', '--scope', 'read', '--expires-in-days', '0']),
    ).toThrow('--expires-in-days');
  });

  it('rejects a name that cannot form a valid client id unless one is given', () => {
    expect(() => createCredential({ name: '!!', scope: 'read' })).toThrow();
    expect(createCredential({ name: '!!', scope: 'read', clientId: 'valid-id' }).clientId).toBe(
      'valid-id',
    );
  });
});
