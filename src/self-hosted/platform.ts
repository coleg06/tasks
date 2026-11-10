import { resolve } from 'node:path';
import { tenantProfile } from '../../shared/tenant-profile';
import { sessionSecretIsConfigured } from '../auth/session';
import type { Env } from '../env';
import { authModeProblems, configuredAuthMode } from '../identity/auth-mode';
import { tenantRuntimeAdapters } from '../runtime/tenant-adapters';

/**
 * Self-hosted platform selection. Everything here is opt-in: with no TASKS_DATASTORE the server
 * is the adapter-only portable runtime, exactly as before, and none of the modules below load.
 *
 *   TASKS_DATASTORE=sqlite            TASKS_SQLITE_PATH=/data/tasks.db
 *   TASKS_OBJECT_STORE=filesystem     TASKS_OBJECT_STORE_PATH=/data/objects   (optional)
 *   TASKS_MIGRATE_ON_START=true|false (default true)   TASKS_MIGRATIONS_DIR (default ./migrations)
 *   TASKS_SCHEDULER=enabled|disabled  (default enabled)
 */

export interface PlatformConfig {
  sqlitePath: string;
  objectStorePath: string | null;
  migrateOnStart: boolean;
  migrationsDir: string;
  scheduler: boolean;
}

const PLATFORM_KEYS = [
  'TASKS_SQLITE_PATH',
  'TASKS_OBJECT_STORE',
  'TASKS_OBJECT_STORE_PATH',
  'TASKS_MIGRATE_ON_START',
  'TASKS_MIGRATIONS_DIR',
  'TASKS_SCHEDULER',
] as const;

function present(value: string | undefined) {
  return value !== undefined && value.trim() !== '';
}

function flag(name: string, value: string | undefined, positive: string, negative: string) {
  if (!present(value)) return null;
  const normalized = (value as string).trim().toLowerCase();
  if (normalized === positive) return true;
  if (normalized === negative) return false;
  throw new Error(`${name} must be ${positive} or ${negative}`);
}

/** Returns null for the default adapter-only mode; throws on invalid or partial configuration. */
export function parsePlatformConfig(source: NodeJS.ProcessEnv): PlatformConfig | null {
  const datastore = source.TASKS_DATASTORE?.trim().toLowerCase();
  if (!present(datastore)) {
    const stray = PLATFORM_KEYS.filter((key) => present(source[key]));
    if (stray.length > 0) {
      throw new Error(`${stray.join(', ')} set without TASKS_DATASTORE=sqlite`);
    }
    return null;
  }
  if (datastore !== 'sqlite') {
    throw new Error(
      `TASKS_DATASTORE=${datastore} is not supported (supported: sqlite; Postgres is not implemented)`,
    );
  }
  const sqlitePath = source.TASKS_SQLITE_PATH?.trim();
  if (!sqlitePath) throw new Error('TASKS_SQLITE_PATH is required when TASKS_DATASTORE=sqlite');
  if (sqlitePath === ':memory:' || sqlitePath.startsWith('file:')) {
    throw new Error('TASKS_SQLITE_PATH must be a filesystem path');
  }
  const store = source.TASKS_OBJECT_STORE?.trim().toLowerCase();
  const storePath = source.TASKS_OBJECT_STORE_PATH?.trim();
  let objectStorePath: string | null = null;
  if (present(store)) {
    if (store !== 'filesystem') {
      throw new Error(`TASKS_OBJECT_STORE=${store} is not supported (supported: filesystem)`);
    }
    if (!storePath) throw new Error('TASKS_OBJECT_STORE_PATH is required for the filesystem store');
    objectStorePath = resolve(storePath);
  } else if (storePath) {
    throw new Error('TASKS_OBJECT_STORE_PATH is set without TASKS_OBJECT_STORE=filesystem');
  }
  return {
    sqlitePath: resolve(sqlitePath),
    objectStorePath,
    migrateOnStart:
      flag('TASKS_MIGRATE_ON_START', source.TASKS_MIGRATE_ON_START, 'true', 'false') ?? true,
    migrationsDir: resolve(source.TASKS_MIGRATIONS_DIR?.trim() || 'migrations'),
    scheduler: flag('TASKS_SCHEDULER', source.TASKS_SCHEDULER, 'enabled', 'disabled') ?? true,
  };
}

export interface SelfHostedPlatform {
  /** Bindings to merge into the Env (DB, EVENT_ASSETS, readiness probes). */
  bindings: Partial<Env>;
  close(): Promise<void>;
}

/**
 * Open the configured stores. Imports are dynamic so `node:sqlite` is only loaded when selected.
 */
export async function openSelfHostedPlatform(config: PlatformConfig): Promise<SelfHostedPlatform> {
  const { mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { SqliteDatabase } = await import('../platform/sqlite/driver');
  const { pendingMigrations, readMigrations, runMigrations } = await import(
    '../platform/sqlite/migrate'
  );
  mkdirSync(dirname(config.sqlitePath), { recursive: true });
  const database = new SqliteDatabase(config.sqlitePath);
  try {
    const migrations = readMigrations(config.migrationsDir);
    if (config.migrateOnStart) {
      const report = runMigrations(database.raw, migrations);
      console.log(
        JSON.stringify({
          type: 'migrations',
          applied: report.applied,
          skipped: report.skipped.length,
        }),
      );
    } else {
      const pending = pendingMigrations(database.raw, migrations);
      if (pending.length > 0) {
        throw new Error(
          `${pending.length} migration(s) pending (${pending[0]}...); run the migrate command or set TASKS_MIGRATE_ON_START=true`,
        );
      }
    }
    const checks: Array<() => Promise<void>> = [() => database.ping()];
    const bindings: Partial<Env> = { DB: database };
    if (config.objectStorePath) {
      const { FilesystemObjectStore } = await import('../platform/fs-object-store');
      const store = new FilesystemObjectStore(config.objectStorePath);
      await store.initialize();
      bindings.EVENT_ASSETS = store;
      checks.push(() => store.ping());
    }
    bindings.PLATFORM_READINESS_CHECKS = checks;
    return {
      bindings,
      close: async () => database.close(),
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Variables the default session-cookie identity path cannot work without: Google sign-in. A
 * different identity provider means a different tenant adapter (and a different list). Only
 * variable names are ever reported, never values.
 */
export { MINIMUM_SESSION_SECRET_LENGTH } from '../auth/session';

export const SESSION_IDENTITY_VARIABLES = [
  'SESSION_SECRET',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
] as const;

/**
 * Names of required identity variables that are missing or blank. Empty when the full legacy
 * application is not served with cookie sessions (portable profile or trusted-upstream auth).
 */
export function missingIdentityVariables(source: NodeJS.ProcessEnv | Env): string[] {
  if (
    tenantProfile.tasks.apiMode !== 'legacy' ||
    tenantRuntimeAdapters.browserAuthentication !== 'session-cookie'
  ) {
    return [];
  }
  const values = source as unknown as Record<string, unknown>;
  // TASKS_AUTH_MODE selects the identity source. Trusted-upstream needs its own settings and no
  // Google or session-secret variables; an unknown mode is reported rather than guessed.
  const modeSettings = source as Pick<Env, 'TASKS_AUTH_MODE'> &
    Parameters<typeof authModeProblems>[0];
  if (configuredAuthMode(modeSettings) !== 'session') return authModeProblems(modeSettings);
  return SESSION_IDENTITY_VARIABLES.filter((name) => {
    const value = values[name];
    if (typeof value !== 'string' || value.trim() === '') return true;
    // A short signing key can be guessed, and anyone holding it can forge any user's session.
    return name === 'SESSION_SECRET' && !sessionSecretIsConfigured(value);
  });
}
