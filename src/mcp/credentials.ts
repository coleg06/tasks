import { z } from 'zod';

/**
 * The MCP credential registry (`TASKS_MCP_CREDENTIALS_JSON`). Version 1 stores each client token
 * verbatim, so the registry is itself a secret binding and must never be committed.
 */
export const credentialSchema = z.object({
  clientId: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
  name: z.string().trim().min(1).max(100),
  role: z.literal('Agent'),
  runtime: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,31}$/),
  scope: z.enum(['read', 'read_write']),
  token: z.string().min(32).max(512),
  expiresAt: z.number().int().positive().optional(),
});

export const credentialsSchema = z.object({
  version: z.literal(1),
  credentials: z.array(credentialSchema).min(1).max(32),
});

export type McpCredential = z.infer<typeof credentialSchema>;
export type McpCredentialRegistry = z.infer<typeof credentialsSchema>;

/** Parses a registry document; null when it is absent, not JSON, or not a valid version 1 registry. */
export function parseCredentialRegistry(json: string | undefined): McpCredentialRegistry | null {
  if (!json) return null;
  try {
    return credentialsSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}
