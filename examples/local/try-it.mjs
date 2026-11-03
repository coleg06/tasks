// Run Tasks on your own machine with no Google account, to look around.
//
//   npm ci && npm run build && node examples/local/try-it.mjs [you@example.org]
//
// Set PORT to use a different port than 8080. Starts the built server on 127.0.0.1 on the port
// after it (SQLite + filesystem under ./.tasks-local) in
// trusted-upstream mode, and a tiny proxy on http://127.0.0.1:8080 that stamps every request with
// the email address you give. That is the same contract a real reverse proxy has with the
// application, except that this proxy authenticates nobody: whoever can reach port 8080 is you,
// an administrator. It binds to the loopback interface only. For anything beyond a local trial use
// one of the real setups in examples/.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { resolve } from 'node:path';

const email = (process.argv[2] ?? 'admin@example.org').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: node examples/local/try-it.mjs [you@example.org]');
  process.exit(1);
}
const server = resolve('dist/server.js');
if (!existsSync(server) || !existsSync(resolve('web/dist/index.html'))) {
  console.error('Build first: npm ci && npm run build');
  process.exit(1);
}
const data = resolve('.tasks-local');
mkdirSync(data, { recursive: true });

const publicPort = Number(process.env.PORT ?? 8080);
const appPort = publicPort + 1;
if (!Number.isInteger(publicPort) || publicPort < 1 || appPort > 65_535) {
  console.error('PORT must be an integer from 1 to 65534.');
  process.exit(1);
}
const child = spawn(process.execPath, [server], {
  env: {
    PATH: process.env.PATH ?? '',
    ENVIRONMENT: 'local',
    RELEASE_SHA: 'local',
    TASKS_SITE_HOST: '127.0.0.1',
    TASKS_SITE_PORT: String(appPort),
    TASKS_PUBLIC_ORIGIN: `http://127.0.0.1:${publicPort}`,
    TASKS_DATASTORE: 'sqlite',
    TASKS_SQLITE_PATH: `${data}/tasks.db`,
    TASKS_OBJECT_STORE: 'filesystem',
    TASKS_OBJECT_STORE_PATH: `${data}/objects`,
    TASKS_MIGRATIONS_DIR: resolve('migrations'),
    TASKS_AUTH_MODE: 'trusted-upstream',
    TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER: 'X-Forwarded-Email',
    TASKS_TRUSTED_UPSTREAM_TRUST: 'proxy-replaces-headers',
    TASKS_INITIAL_ADMIN_EMAIL: email,
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code) => process.exit(code ?? 1));

const proxy = http
  .createServer((request, response) => {
    // Replace, never pass through, the identity header: this is the proxy's whole job.
    const headers = { ...request.headers, host: `127.0.0.1:${appPort}` };
    delete headers['x-forwarded-email'];
    headers['x-forwarded-email'] = email;
    const upstream = http.request(
      { host: '127.0.0.1', port: appPort, path: request.url, method: request.method, headers },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    upstream.on('error', () => {
      response.writeHead(502).end('The application is not ready yet; retry in a moment.');
    });
    request.pipe(upstream);
  })
  .listen(publicPort, '127.0.0.1', () => {
    console.log(
      `Tasks is on http://127.0.0.1:${publicPort}, signed in as ${email} (administrator).`,
    );
    console.log('Data is kept in ./.tasks-local. Press Ctrl+C to stop.');
  });

proxy.on('error', (error) => {
  console.error(
    `Cannot listen on 127.0.0.1:${publicPort}: ${error.message}. Try PORT=<free port>.`,
  );
  child.kill();
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
