/// <reference types="node" />

import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { tenantProfile } from '../../shared/tenant-profile';

let composed: string | undefined;

/**
 * Directory of the migrations that tests apply. For the neutral default profile in the maintained
 * source tree this is the original migrations with the neutral replacements from
 * `public-upstream/migrations-overrides` applied, exactly what the public export ships; in an
 * exported tree it is `migrations/` itself. Tests therefore run against the same schema and seeds
 * in both trees. A deployment whose overlay replaces the profile with its own tenant keeps its own
 * seeds: it gets the original migrations unchanged.
 */
export function effectiveMigrationsDirectory(): string {
  const overrides = resolve('public-upstream/migrations-overrides');
  if (!existsSync(overrides) || tenantProfile.key !== 'default') return resolve('migrations');
  if (composed) return composed;
  const directory = mkdtempSync(join(tmpdir(), 'tasks-effective-migrations-'));
  cpSync(resolve('migrations'), directory, { recursive: true });
  cpSync(overrides, directory, { recursive: true, force: true });
  process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
  composed = directory;
  return directory;
}
