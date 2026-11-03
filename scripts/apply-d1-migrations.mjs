import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const databaseName = process.argv[2];
const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

if (!databaseName || !token || !accountId) {
  throw new Error(
    'Usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/apply-d1-migrations.mjs <database-name>',
  );
}

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?name=${encodeURIComponent(databaseName)}`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const payload = await response.json();
const database = payload.success
  ? payload.result.find((candidate) => candidate.name === databaseName)
  : undefined;

if (!response.ok || !database) {
  throw new Error(`Unable to resolve D1 database ${databaseName}.`);
}

const temporaryDirectory = mkdtempSync(resolve(tmpdir(), 'tasks-migrations-'));
const configPath = resolve(temporaryDirectory, 'wrangler.json');
writeFileSync(
  configPath,
  JSON.stringify({
    name: 'tasks-migrations',
    compatibility_date: '2026-08-01',
    account_id: accountId,
    d1_databases: [
      {
        binding: 'DB',
        database_name: databaseName,
        database_id: database.uuid ?? database.id,
        migrations_dir: resolve('migrations'),
      },
    ],
  }),
);

const wrangler = fileURLToPath(
  new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [wrangler, 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath],
  { env: process.env, stdio: 'inherit' },
);
rmSync(temporaryDirectory, { force: true, recursive: true });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
