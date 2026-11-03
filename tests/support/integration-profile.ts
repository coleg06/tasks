import type { TenantProfile } from '../../shared/tenant-profile';
import type { TenantProfileExtensions } from '../../shared/tenant-profile-support';

/**
 * Profile used by the `integration` test pass: the neutral default profile with every optional
 * capability enabled and example integrations configured. Identity-bearing fields (tenant key,
 * workspace, default project, agent, hosted domain, initial administrator) are untouched, so
 * the seeded database still matches. Hosts use the reserved `example.org` domain.
 */
export function buildIntegrationProfile(base: TenantProfile): TenantProfile {
  // Fields owned by the base (optional on every deployment profile) are kept in a separately
  // typed object and spread in, so this helper compiles against a profile that predates them.
  const extensions: TenantProfileExtensions = {
    integrations: {
      emailGateway: { headerPrefix: 'X-Example' },
      mobileGateway: { headerPrefix: 'X-Example-Tasks' },
      portalAlerts: {
        endpoint: 'https://dev-api.example.org/api/v1/task-alert-ingest',
        headerPrefix: 'X-Example',
      },
      portalSupport: {
        ticketHosts: ['portal.example.org', 'dev.portal.example.org'],
        ownerEmails: ['admin@example.org', 'owner2@example.org'],
        actorEmail: 'admin@example.org',
      },
      eventAssist: { allowedHosts: ['llm.example.org'] },
    },
    events: {
      ministryPresets: ['Operations', 'Outreach', 'Education'],
      destinationsByMinistry: {
        operations: ['North'],
        outreach: ['Online'],
      },
      destinations: ['North', 'South', 'Online'],
      defaultDestination: 'North',
      defaultLocation: 'North Hall',
      defaultTimezone: 'UTC',
      rooms: ['Main Hall', 'Lobby', 'Kitchen', 'Off-site event'],
      transportation: ['Event trailer', 'Van'],
      screenName: 'Main Hall',
      programLabel: 'Weekly Program',
      ministryLabel: 'Group',
      destinationLabel: 'Site',
      weekLabel: 'Week',
      secondLanguageName: 'Second language',
      assistantOrganization: 'Example Organization',
    },
  };
  const { emailGateway, mobileGateway, ...otherIntegrations } = extensions.integrations ?? {};
  return {
    ...base,
    origins: {
      production: 'https://tasks.example.org',
      development: 'https://tasks-dev.example.org',
      portalProduction: 'https://portal.example.org',
      portalDevelopment: 'https://dev.portal.example.org',
    },
    links: { portal: 'https://portal.example.org/v2/' },
    capabilities: {
      ...base.capabilities,
      portal: true,
      mobileApi: true,
      portalSupport: true,
      emailNotifications: true,
      portalAlerts: true,
    },
    integrations: {
      emailGateway: {
        productionOrigin: 'https://email-api.example.org',
        clientId: 'tasks-production',
        fromEmail: 'tasks@example.org',
        ...emailGateway,
      },
      mobileGateway: {
        issuer: 'example-portal-api',
        audience: 'example-tasks-dev',
        environment: 'dev',
        ...mobileGateway,
      },
      ...otherIntegrations,
    },
    ...(extensions.events ? { events: extensions.events } : {}),
  };
}
