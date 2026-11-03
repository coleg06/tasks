import { describe, expect, it } from 'vitest';
import { hostedEmailMatches, normalizeHostedDomain } from '../../shared/hosted-domain';
import { renderTenantHtml, tenantBrandingCss } from '../../shared/tenant-html';
import {
  DEFAULT_TENANT_PROFILE,
  isTenantHostedEmail,
  type TenantProfile,
  tenantAppOrigin,
  tenantPortalOrigin,
  tenantProfile,
  tenantTitle,
  validateTenantProfile,
} from '../../shared/tenant-profile';
import {
  notificationChannelsForCapabilities,
  notificationPreferencesForCapabilities,
} from '../../web/src/tasks/TaskPreferencesDialog';
import { applyTenantBranding, installTenantProfile } from '../../web/src/tenant-branding';

const exampleProfile: TenantProfile = {
  ...tenantProfile,
  organizationName: 'Example Organization',
  origins: {
    production: 'https://tasks.example.org',
    development: 'https://tasks-dev.example.org',
    portalProduction: 'https://portal.example.org',
    portalDevelopment: 'https://dev.portal.example.org',
  },
  identity: { ...tenantProfile.identity, hostedDomain: 'example.org' },
};

describe('default tenant profile', () => {
  it('is neutral: no hosted domain, no administrator, no private origins', () => {
    expect(DEFAULT_TENANT_PROFILE.organizationName).toBe('Team');
    expect(DEFAULT_TENANT_PROFILE.productName).toBe('Tasks');
    expect(DEFAULT_TENANT_PROFILE.identity.hostedDomain).toBe('');
    expect(DEFAULT_TENANT_PROFILE.identity.initialAdminEmail).toBe('');
    expect(Object.values(DEFAULT_TENANT_PROFILE.origins)).toEqual(['', '', '', '']);
    expect(DEFAULT_TENANT_PROFILE.links.portal).toBe('');
    expect(DEFAULT_TENANT_PROFILE.capabilities.events).toBe(true);
    expect(DEFAULT_TENANT_PROFILE.capabilities.portal).toBe(false);
    expect(validateTenantProfile(DEFAULT_TENANT_PROFILE)).toBe(DEFAULT_TENANT_PROFILE);
  });

  it('keeps the identity-bearing fields the seeded database expects', () => {
    expect(tenantProfile.key).toBe(DEFAULT_TENANT_PROFILE.key);
    expect(tenantProfile.workspaceKey).toBe(DEFAULT_TENANT_PROFILE.workspaceKey);
    expect(tenantProfile.agent).toEqual({
      enabled: true,
      name: 'Agent',
      email: 'agent@tasks.invalid',
    });
  });

  it('falls back to the request origin when no origin is configured', () => {
    expect(tenantAppOrigin('production', 'http://localhost:8787', DEFAULT_TENANT_PROFILE)).toBe(
      'http://localhost:8787',
    );
    expect(tenantAppOrigin('dev', 'http://localhost:8787', exampleProfile)).toBe(
      'https://tasks-dev.example.org',
    );
    expect(tenantAppOrigin('production', 'http://localhost:8787', exampleProfile)).toBe(
      'https://tasks.example.org',
    );
    expect(tenantAppOrigin('local', 'http://localhost:8787', exampleProfile)).toBe(
      'http://localhost:8787',
    );
    expect(tenantPortalOrigin('production', exampleProfile)).toBe('https://portal.example.org');
    expect(tenantPortalOrigin('local', exampleProfile)).toBe('https://dev.portal.example.org');
  });

  it('maps the profile palette to the application CSS properties', () => {
    const properties = new Map<string, string>();
    const root = {
      style: { setProperty: (property: string, value: string) => properties.set(property, value) },
    } as unknown as HTMLElement;

    applyTenantBranding(root, tenantProfile.branding.light);

    expect(properties.get('--accent')).toBe(tenantProfile.branding.light.accent);
    expect(properties.get('--accent-hover')).toBe(tenantProfile.branding.light.accentHover);
    expect(properties.get('--brand-strong')).toBe(tenantProfile.branding.light.brandStrong);
    expect(properties.get('--on-accent')).toBe('#ffffff');
  });

  it('validates exact hosted-domain boundaries and capability dependencies', () => {
    expect(isTenantHostedEmail('staff@example.org', exampleProfile)).toBe(true);
    expect(isTenantHostedEmail(' STAFF@EXAMPLE.ORG ', exampleProfile)).toBe(true);
    expect(isTenantHostedEmail('staff@example.org.attacker.example', exampleProfile)).toBe(false);
    expect(isTenantHostedEmail('staff+example.org@example.com', exampleProfile)).toBe(false);
    expect(isTenantHostedEmail('staff@a@example.org', exampleProfile)).toBe(false);
    expect(isTenantHostedEmail('staff@', exampleProfile)).toBe(false);
    // The runtime setting replaces an unset profile domain; with neither set any plain email passes.
    expect(isTenantHostedEmail('staff@example.net', DEFAULT_TENANT_PROFILE)).toBe(true);
    expect(hostedEmailMatches('staff@example.net', 'example.org')).toBe(false);
    expect(hostedEmailMatches('staff@example.org', ' @Example.org')).toBe(true);
    expect(hostedEmailMatches('staff@example.net', '')).toBe(true);
    expect(normalizeHostedDomain(' @Example.ORG ')).toBe('example.org');
    expect(normalizeHostedDomain(undefined)).toBe('');

    expect(() =>
      validateTenantProfile({
        ...tenantProfile,
        capabilities: { ...tenantProfile.capabilities, events: false },
      }),
    ).toThrow(/eventPlanning requires events/);

    expect(() =>
      validateTenantProfile({
        ...exampleProfile,
        identity: { ...exampleProfile.identity, initialAdminEmail: 'admin@elsewhere.test' },
      }),
    ).toThrow(/initialAdminEmail must use identity.hostedDomain/);

    expect(() =>
      validateTenantProfile({
        ...tenantProfile,
        agent: { ...tenantProfile.agent, enabled: false },
      }),
    ).toThrow(/hideAgentTasks requires agent.enabled/);
  });

  it('hides and clears notification channels disabled by tenant capabilities', () => {
    const capabilities = {
      ...tenantProfile.capabilities,
      emailNotifications: false,
      portalAlerts: false,
    };
    const enabledChannels = notificationChannelsForCapabilities(capabilities);
    const preferences = notificationPreferencesForCapabilities(
      {
        assignments: { email: true, inApp: true, push: true },
        comments: { email: true, inApp: true, push: true },
        mentions: { email: true, inApp: true, push: true },
        deadlines: { email: true, inApp: true, push: true },
      },
      capabilities,
    );

    expect(enabledChannels).toEqual([]);
    expect(Object.values(preferences)).toEqual([
      { email: false, inApp: false, push: false },
      { email: false, inApp: false, push: false },
      { email: false, inApp: false, push: false },
      { email: false, inApp: false, push: false },
    ]);
  });

  it('renders profile title and both palettes before application JavaScript runs', () => {
    const html = renderTenantHtml(
      '<head><!-- tenant-profile-branding --><title>Tasks</title></head>',
    );
    expect(html).toContain(`<title>${tenantTitle()}</title>`);
    expect(html).toContain('id="tenant-profile-branding"');
    expect(html).toContain(`--accent:${tenantProfile.branding.light.accent}`);
    expect(html).toContain('@media (prefers-color-scheme:dark)');
    expect(tenantBrandingCss()).toContain(`--on-accent:${tenantProfile.branding.dark.onAccent}`);
  });

  it('updates title and theme on scheme changes and removes its listener on cleanup', () => {
    const properties = new Map<string, string>();
    const root = {
      style: { setProperty: (property: string, value: string) => properties.set(property, value) },
    } as unknown as HTMLElement;
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    };
    const documentValue = { documentElement: root, title: '' } as unknown as Document;
    const windowValue = { matchMedia: () => media } as unknown as Window;

    const firstCleanup = installTenantProfile(documentValue, windowValue);
    const secondCleanup = installTenantProfile(documentValue, windowValue);
    expect(documentValue.title).toBe(tenantTitle());
    expect(properties.get('--accent')).toBe(tenantProfile.branding.light.accent);
    expect(listeners.size).toBe(2);

    media.matches = true;
    for (const listener of listeners) listener();
    expect(properties.get('--accent')).toBe(tenantProfile.branding.dark.accent);

    firstCleanup();
    secondCleanup();
    expect(listeners.size).toBe(0);
  });
});
