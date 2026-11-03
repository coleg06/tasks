import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';

const profilePath = resolve('shared/tenant-profile.ts');
const activeProfile =
  'export const tenantProfile: TenantProfile = validateTenantProfile(DEFAULT_TENANT_PROFILE);';
const integrationSupport = resolve('tests/support/integration-profile.ts');

/**
 * Swaps the active tenant profile for the integration test profile (every optional capability
 * enabled). It only applies to the neutral default profile; a deployment overlay that replaces
 * `shared/tenant-profile.ts` runs its own profile through the single `default` pass.
 */
function integrationTenantProfile(): Plugin {
  return {
    name: 'integration-tenant-profile',
    enforce: 'pre',
    load(id) {
      if (id.split('?')[0] !== profilePath) return null;
      const source = readFileSync(profilePath, 'utf8');
      return `import { buildIntegrationProfile } from ${JSON.stringify(integrationSupport)};\n${source.replace(
        activeProfile,
        'export const tenantProfile: TenantProfile = validateTenantProfile(buildIntegrationProfile(DEFAULT_TENANT_PROFILE));',
      )}`;
    },
  };
}

const usesNeutralProfile = readFileSync(profilePath, 'utf8').includes(activeProfile);
const include = ['tests/**/*.test.ts'];

export default defineConfig({
  test: {
    coverage: { reporter: ['text', 'json-summary'] },
    projects: [
      { test: { name: 'default', environment: 'node', include } },
      ...(usesNeutralProfile
        ? [
            {
              plugins: [integrationTenantProfile()],
              test: { name: 'integration', environment: 'node', include },
            },
          ]
        : []),
    ],
  },
});
