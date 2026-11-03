import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { tenantProfile } from '../../shared/tenant-profile';
import { app } from '../app';
import type { Env } from '../env';
import { mcpConfigurationProblems } from '../mcp/config';
import { runScheduledJob, scheduledJobs } from '../platform/jobs';
import { Scheduler } from '../platform/scheduler';
import { profileConfigurationProblems } from '../tenancy/configuration';
import { missingIdentityVariables, openSelfHostedPlatform, parsePlatformConfig } from './platform';

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function safeAssetPath(root: string, pathname: string) {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  const candidate = resolve(root, decoded.replace(/^\/+/, ''));
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null;
}

async function assetResponse(root: string, pathname: string, method: string) {
  const candidate = safeAssetPath(root, pathname === '/' ? '/index.html' : pathname);
  if (!candidate) return new Response('Not found', { status: 404 });
  try {
    const body = await readFile(candidate);
    return new Response(method === 'HEAD' ? null : body, {
      headers: {
        'Cache-Control': pathname.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        'Content-Type':
          CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      },
    });
  } catch {
    if (method !== 'GET' && method !== 'HEAD') return new Response('Not found', { status: 404 });
    if (pathname.startsWith('/assets/') || extname(pathname)) {
      return new Response('Not found', { status: 404 });
    }
    const index = await readFile(resolve(root, 'index.html'));
    return new Response(method === 'HEAD' ? null : index, {
      headers: { 'Cache-Control': 'no-cache', 'Content-Type': CONTENT_TYPES['.html'] },
    });
  }
}

export function createAssetFetcher(root = resolve('web/dist')) {
  const normalizedRoot = resolve(root);
  return {
    async fetch(input: RequestInfo | URL) {
      const request = input instanceof Request ? input : new Request(input);
      return assetResponse(normalizedRoot, new URL(request.url).pathname, request.method);
    },
  } as unknown as Fetcher;
}

/** Rejects malformed identity settings at startup. Reports variable names, never values. */
function validateIdentitySettings(source: NodeJS.ProcessEnv) {
  const origin = source.TASKS_PUBLIC_ORIGIN?.trim();
  if (origin) {
    let valid = false;
    try {
      const url = new URL(origin);
      valid =
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        url.origin === origin.replace(/\/$/, '');
    } catch {
      valid = false;
    }
    if (!valid) throw new Error('TASKS_PUBLIC_ORIGIN must be an http(s) origin without a path');
  }
  const domain = source.TASKS_HOSTED_DOMAIN?.trim();
  if (
    domain &&
    !/^@?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(domain)
  ) {
    throw new Error('TASKS_HOSTED_DOMAIN must be a domain name such as example.org');
  }
  const admin = source.TASKS_INITIAL_ADMIN_EMAIL?.trim();
  if (admin && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin)) {
    throw new Error('TASKS_INITIAL_ADMIN_EMAIL must be an email address');
  }
}

export function createSelfHostedEnv(
  source: NodeJS.ProcessEnv = process.env,
  assets: Fetcher = createAssetFetcher(),
) {
  const environment = source.ENVIRONMENT;
  if (!environment || !['local', 'dev', 'production'].includes(environment)) {
    throw new Error('ENVIRONMENT must be local, dev, or production');
  }
  if (!source.RELEASE_SHA?.trim()) throw new Error('RELEASE_SHA is required');
  validateIdentitySettings(source);
  return { ...source, ASSETS: assets, ENVIRONMENT: environment } as unknown as Env;
}

function boundedPort(value: string | undefined) {
  const port = Number(value ?? '8080');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('TASKS_SITE_PORT must be an integer between 1 and 65535');
  }
  return port;
}

export interface RunningSelfHostedServer {
  readonly server: ReturnType<typeof serve>;
  readonly env: Env;
  close(): Promise<void>;
}

/**
 * Start the server. With no TASKS_DATASTORE this is the adapter-only portable runtime (no
 * database, object store or scheduler). With TASKS_DATASTORE=sqlite the full application is
 * wired to SQLite and, optionally, a filesystem object store. Invalid or partial platform
 * configuration rejects before anything is opened or any port is bound.
 */
export async function startSelfHostedServer(
  source: NodeJS.ProcessEnv = process.env,
  assets?: Fetcher,
): Promise<RunningSelfHostedServer> {
  const baseEnv = createSelfHostedEnv(source, assets);
  const hostname = source.TASKS_SITE_HOST?.trim() || '0.0.0.0';
  const port = boundedPort(source.TASKS_SITE_PORT);
  const config = parsePlatformConfig(source);
  const missingIdentity = config ? missingIdentityVariables(source) : [];
  if (config && baseEnv.ENVIRONMENT === 'production' && missingIdentity.length > 0) {
    throw new Error(`Missing required identity configuration: ${missingIdentity.join(', ')}`);
  }
  const profileProblems = config
    ? profileConfigurationProblems(tenantProfile, { eventAssistEndpoint: source.EVENT_AI_ENDPOINT })
    : [];
  if (profileProblems.length > 0) {
    throw new Error(`Tenant profile is incomplete; set: ${profileProblems.join(', ')}`);
  }
  // MCP settings are checked like the other fail-closed settings: production refuses to start and
  // names them; elsewhere the server starts and /readyz names them.
  const mcpProblems = tenantProfile.agent.enabled
    ? mcpConfigurationProblems(baseEnv as Parameters<typeof mcpConfigurationProblems>[0])
    : [];
  if (baseEnv.ENVIRONMENT === 'production' && mcpProblems.length > 0) {
    throw new Error(`Invalid MCP configuration; set: ${mcpProblems.join(', ')}`);
  }
  const platform = config ? await openSelfHostedPlatform(config) : null;
  if (platform && missingIdentity.length > 0) {
    // Non-production only: start, but never report ready while sign-in cannot work.
    platform.bindings.PLATFORM_READINESS_CHECKS = [
      ...(platform.bindings.PLATFORM_READINESS_CHECKS ?? []),
      async () => {
        throw new Error(`Missing required identity configuration: ${missingIdentity.join(', ')}`);
      },
    ];
  }
  const env = platform ? ({ ...baseEnv, ...platform.bindings } as Env) : baseEnv;
  const scheduler =
    config?.scheduler === true
      ? new Scheduler<Env>({
          jobs: scheduledJobs.jobs,
          env,
          run: runScheduledJob,
          onFailure: (job, error) => {
            console.error(
              JSON.stringify({
                type: 'scheduled_job',
                name: job.name,
                status: 'failed',
                message: error instanceof Error ? error.message : String(error),
              }),
            );
          },
        })
      : null;
  const pending = new Set<Promise<unknown>>();
  const executionContext = {
    waitUntil(promise: Promise<unknown>) {
      const tracked = promise.catch((error) => {
        console.error(
          JSON.stringify({
            type: 'background_task_failed',
            message: error instanceof Error ? error.message : String(error),
          }),
        );
      });
      pending.add(tracked);
      void tracked.finally(() => pending.delete(tracked));
    },
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolveServer, reject) => {
      const listening = serve(
        {
          fetch: (request) => app.fetch(request, env, executionContext),
          hostname,
          port,
        },
        (info) => {
          console.log(
            JSON.stringify({
              type: 'server_listening',
              environment: env.ENVIRONMENT,
              hostname,
              port: info.port,
              release: env.RELEASE_SHA,
              service: 'tasks',
              datastore: config ? 'sqlite' : 'none',
              objectStore: config?.objectStorePath ? 'filesystem' : 'none',
              scheduler: scheduler ? 'enabled' : 'disabled',
            }),
          );
          resolveServer(listening);
        },
      );
      listening.once('error', reject);
    });
  } catch (error) {
    await platform?.close();
    throw error;
  }
  scheduler?.start();
  return {
    server,
    env,
    async close() {
      await scheduler?.stop();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      await Promise.allSettled([...pending]);
      await platform?.close();
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  startSelfHostedServer().then(
    (running) => {
      const stop = () => {
        void running.close().then(() => process.exit(0));
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
    },
    (error) => {
      console.error(
        JSON.stringify({
          type: 'startup_failed',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exit(1);
    },
  );
}
