import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { credentialSchema, type McpCredential, type McpCredentialRegistry } from './credentials';

const USAGE = `Usage: npm run mcp:create-credential -- --name <name> --scope read|read_write
         [--runtime <runtime>] [--client-id <id>] [--expires-in-days <n>] [--output <path>]

Generates a client token and prints it once, with the registry entry to add to the "credentials"
array of TASKS_MCP_CREDENTIALS_JSON (document version 1). The registry stores tokens as written,
so treat it as a secret. Nothing is read, and nothing is written unless --output is given
(the file is created with mode 0600 and never overwritten).`;

export interface CreateCredentialOptions {
  name: string;
  scope: 'read' | 'read_write';
  runtime?: string;
  clientId?: string;
  expiresInDays?: number;
  output?: string;
}

const VALUE_FLAGS = new Map<string, keyof CreateCredentialOptions>([
  ['--name', 'name'],
  ['--scope', 'scope'],
  ['--runtime', 'runtime'],
  ['--client-id', 'clientId'],
  ['--expires-in-days', 'expiresInDays'],
  ['--output', 'output'],
]);

export function parseArguments(argv: readonly string[]): CreateCredentialOptions {
  const raw: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const key = VALUE_FLAGS.get(flag);
    if (!key) throw new Error(`Unknown argument ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    raw[key] = value;
    index += 1;
  }
  if (!raw.name?.trim()) throw new Error('--name is required');
  if (raw.scope !== 'read' && raw.scope !== 'read_write') {
    throw new Error('--scope must be read or read_write');
  }
  const options: CreateCredentialOptions = { name: raw.name.trim(), scope: raw.scope };
  if (raw.runtime !== undefined) options.runtime = raw.runtime;
  if (raw.clientId !== undefined) options.clientId = raw.clientId;
  if (raw.output !== undefined) options.output = raw.output;
  if (raw.expiresInDays !== undefined) {
    const days = Number(raw.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 3650) {
      throw new Error('--expires-in-days must be a whole number from 1 to 3650');
    }
    options.expiresInDays = days;
  }
  return options;
}

function slug(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
}

/** A 256-bit random token, URL-safe, from the platform CSPRNG. */
export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `mcp_${base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** Builds one registry entry in the exact shape `TASKS_MCP_CREDENTIALS_JSON` validates. */
export function createCredential(
  options: CreateCredentialOptions,
  now = Math.floor(Date.now() / 1000),
): McpCredential {
  return credentialSchema.parse({
    clientId: options.clientId ?? slug(options.name),
    name: options.name,
    role: 'Agent',
    runtime: options.runtime ?? 'mcp',
    scope: options.scope,
    token: generateToken(),
    ...(options.expiresInDays !== undefined
      ? { expiresAt: now + options.expiresInDays * 86_400 }
      : {}),
  });
}

export function main(argv: readonly string[]) {
  const options = parseArguments(argv);
  const credential = createCredential(options);
  if (options.output) {
    const document: McpCredentialRegistry = { version: 1, credentials: [credential] };
    writeFileSync(options.output, `${JSON.stringify(document, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  const lines = [
    `Client token (shown once; give it to the client now): ${credential.token}`,
    '',
    `Registry entry (add it to "credentials" in TASKS_MCP_CREDENTIALS_JSON, {"version":1,...}):`,
    JSON.stringify(credential, null, 2),
  ];
  if (options.output) lines.push('', `Wrote a one-entry registry document to ${options.output}`);
  console.log(lines.join('\n'));
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    process.exit(1);
  }
}
