import { tenantProfile } from '../../shared/tenant-profile';

/**
 * Origins used by request fixtures. They follow the active profile when it configures origins
 * (the integration pass and deployment overlays) and otherwise use the reserved example domain.
 */
export const testOrigins = {
  production: tenantProfile.origins.production || 'https://tasks.example.org',
  development: tenantProfile.origins.development || 'https://tasks-dev.example.org',
} as const;
