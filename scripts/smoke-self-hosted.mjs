// Boots the built self-hosted server (dist/server.js) from an empty directory with SQLite and
// filesystem storage, without Docker, and proves the documented contract:
//   - migrations apply from empty and are idempotent;
//   - the UI and /readyz are served;
//   - session sign-in fails closed without its configuration, and redirects to Google with it;
//   - trusted-upstream sign-in fails closed without its configuration, and with it authenticates
//     only the configured header, bootstrapping the configured first administrator.
// Run after `npm run build`. No secrets are read; every credential below is generated here.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const root = process.cwd();
const server = resolve(root, 'dist/server.js');
const migrate = resolve(root, 'dist/migrate.js');
const work = mkdtempSync(join(tmpdir(), 'tasks-smoke-'));
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${message}`);
}

function baseEnv(extra = {}) {
  const path = process.env.PATH ?? '';
  return {
    PATH: path,
    ENVIRONMENT: 'production',
    RELEASE_SHA: 'smoke',
    TASKS_DATASTORE: 'sqlite',
    TASKS_SQLITE_PATH: join(work, 'tasks.db'),
    TASKS_OBJECT_STORE: 'filesystem',
    TASKS_OBJECT_STORE_PATH: join(work, 'objects'),
    TASKS_MIGRATIONS_DIR: resolve(root, 'migrations'),
    TASKS_SITE_HOST: '127.0.0.1',
    TASKS_SCHEDULER: 'disabled',
    ...extra,
  };
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

function exitsNonZeroQuickly(env) {
  const result = spawnSync(process.execPath, [server], { env, encoding: 'utf8', timeout: 15_000 });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

async function start(extra) {
  const port = await freePort();
  const child = spawn(process.execPath, [server], {
    env: baseEnv({ TASKS_SITE_PORT: String(port), ...extra }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${output.slice(0, 500)}`);
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return { child, base };
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`server did not start: ${output.slice(0, 500)}`);
}

async function stop({ child }) {
  child.kill('SIGTERM');
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt += 1) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
}

try {
  // 1. Fail closed: production without any sign-in configuration refuses to start.
  const refusalPort = String(await freePort());
  const noSession = exitsNonZeroQuickly(baseEnv({ TASKS_SITE_PORT: refusalPort }));
  check(noSession.status !== 0, 'session mode without configuration refuses to start');
  check(
    /SESSION_SECRET|GOOGLE_CLIENT_ID/.test(noSession.output) &&
      !/GOOGLE_CLIENT_SECRET=|SESSION_SECRET=/.test(noSession.output),
    'the refusal names the missing variables and prints no values',
  );
  const noTrust = exitsNonZeroQuickly(
    baseEnv({ TASKS_SITE_PORT: refusalPort, TASKS_AUTH_MODE: 'trusted-upstream' }),
  );
  check(noTrust.status !== 0, 'trusted-upstream mode without configuration refuses to start');
  check(
    /TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER/.test(noTrust.output) &&
      /TASKS_TRUSTED_UPSTREAM_TRUST/.test(noTrust.output),
    'the refusal names the missing trusted-upstream settings',
  );
  const badMode = exitsNonZeroQuickly(
    baseEnv({ TASKS_SITE_PORT: refusalPort, TASKS_AUTH_MODE: 'password' }),
  );
  check(badMode.status !== 0, 'an unknown TASKS_AUTH_MODE refuses to start');

  // 2. Migrate from empty with the standalone command, twice.
  const migrateEnv = baseEnv();
  const first = spawnSync(process.execPath, [migrate], { env: migrateEnv, encoding: 'utf8' });
  check(first.status === 0, 'migrations apply from an empty directory');
  const second = spawnSync(process.execPath, [migrate, '--status'], {
    env: migrateEnv,
    encoding: 'utf8',
  });
  check(second.status === 0, 'a second migrate run reports nothing pending');

  // 3. Session mode: UI, readiness and the Google redirect.
  const sessionEnv = {
    SESSION_SECRET: randomBytes(32).toString('hex'),
    GOOGLE_CLIENT_ID: 'smoke-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: randomBytes(16).toString('hex'),
    TASKS_HOSTED_DOMAIN: 'example.org',
    TASKS_INITIAL_ADMIN_EMAIL: 'admin@example.org',
    TASKS_PUBLIC_ORIGIN: 'https://tasks.example.org',
  };
  const session = await start(sessionEnv);
  try {
    const ready = await fetch(`${session.base}/readyz`);
    const readyBody = await ready.json();
    check(ready.status === 200 && readyBody.ok === true, '/readyz is ready after migration');
    const index = await fetch(session.base);
    const html = await index.text();
    check(index.status === 200 && html.includes('id="root"'), 'the web UI is served at /');
    const login = await fetch(`${session.base}/auth/login`, { redirect: 'manual' });
    const location = login.headers.get('location') ?? '';
    check(
      login.status === 302 && location.startsWith('https://accounts.google.com/'),
      'sign-in redirects to Google',
    );
    check(
      new URL(location).searchParams.get('hd') === 'example.org',
      'the hosted domain restriction is sent to Google',
    );
    check(
      new URL(location).searchParams.get('redirect_uri') ===
        'https://tasks.example.org/auth/callback',
      'the redirect URI uses TASKS_PUBLIC_ORIGIN',
    );
    const bootstrap = await fetch(`${session.base}/api/bootstrap`);
    check(bootstrap.status === 401, 'the API is closed without a session');
  } finally {
    await stop(session);
  }

  // 3b. Without a hosted domain only the first administrator and pre-created users are admitted.
  const closed = await start({
    TASKS_AUTH_MODE: 'trusted-upstream',
    TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER: 'X-Forwarded-Email',
    TASKS_TRUSTED_UPSTREAM_TRUST: 'proxy-replaces-headers',
    TASKS_INITIAL_ADMIN_EMAIL: 'admin@example.org',
  });
  try {
    const denied = await fetch(`${closed.base}/api/bootstrap`, {
      headers: { 'X-Forwarded-Email': 'stranger@example.org' },
    });
    check(denied.status === 403, 'default: an unknown address is denied when no domain is set');
    const first = await fetch(`${closed.base}/api/bootstrap`, {
      headers: { 'X-Forwarded-Email': 'admin@example.org' },
    });
    check(first.status === 200, 'default: the first administrator is still admitted');
  } finally {
    await stop(closed);
  }

  // 4. Trusted-upstream mode: only the configured header authenticates.
  const trusted = await start({
    TASKS_AUTH_MODE: 'trusted-upstream',
    TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER: 'X-Forwarded-Email',
    TASKS_TRUSTED_UPSTREAM_NAME_HEADER: 'X-Forwarded-User',
    TASKS_TRUSTED_UPSTREAM_TRUST: 'proxy-replaces-headers',
    TASKS_HOSTED_DOMAIN: 'example.org',
    TASKS_INITIAL_ADMIN_EMAIL: 'admin@example.org',
  });
  try {
    const anonymous = await fetch(`${trusted.base}/api/bootstrap`);
    check(
      anonymous.status === 401,
      'trusted-upstream: a request without the header is unauthenticated',
    );
    const wrongHeader = await fetch(`${trusted.base}/api/bootstrap`, {
      headers: { 'X-Authentik-Email': 'admin@example.org' },
    });
    check(
      wrongHeader.status === 401,
      'trusted-upstream: a header that is not configured is ignored',
    );
    const foreign = await fetch(`${trusted.base}/api/bootstrap`, {
      headers: { 'X-Forwarded-Email': 'admin@elsewhere.test' },
    });
    check(
      foreign.status === 401,
      'trusted-upstream: an email outside the hosted domain is rejected',
    );
    const stranger = await fetch(`${trusted.base}/api/bootstrap`, {
      headers: { 'X-Forwarded-Email': 'someone@example.org' },
    });
    const strangerBody = await stranger.json();
    check(
      stranger.status === 200 && !strangerBody.permissions?.includes('tasks.manage'),
      'trusted-upstream: another user in the domain gets a personal workspace and no administration',
    );
    const admin = await fetch(`${trusted.base}/api/bootstrap`, {
      headers: { 'X-Forwarded-Email': 'admin@example.org', 'X-Forwarded-User': 'Ada Admin' },
    });
    const adminBody = await admin.json();
    check(
      admin.status === 200 &&
        adminBody.user?.email === 'admin@example.org' &&
        adminBody.permissions?.includes('tasks.manage'),
      'trusted-upstream: the configured first administrator is bootstrapped with full access',
    );
    const login = await fetch(`${trusted.base}/auth/login`, { redirect: 'manual' });
    check(login.status === 404, 'trusted-upstream: Google sign-in is disabled');
    const cookie = await fetch(`${trusted.base}/api/bootstrap`, {
      headers: { Cookie: 'tasks_session=forged' },
    });
    check(cookie.status === 401, 'trusted-upstream: session cookies are never consulted');
  } finally {
    await stop(trusted);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`${failures.length} smoke check(s) failed.`);
  process.exit(1);
}
console.log('Self-hosted smoke test passed.');
