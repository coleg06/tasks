import { hostedEmailMatches } from './hosted-domain.ts';
import type { TaskEffort, TaskPriority, TaskWorkflowState } from './task-domain.ts';
import type { TenantProfileExtensions } from './tenant-profile-support.ts';

export type TenantBrandPalette = {
  accent: string;
  accentHover: string;
  accentSubtle: string;
  accentBorder: string;
  brand: string;
  brandStrong: string;
  onAccent: string;
};

export type TenantProfile = {
  key: string;
  organizationName: string;
  productName: string;
  serviceName: string;
  workspaceKey: string;
  defaultProjectKey: string;
  defaultProjectName: string;
  defaultProjectDescription: string;
  tasks: {
    apiMode: 'legacy' | 'portable';
    workflow: readonly TaskWorkflowState[];
    priorities: readonly TaskPriority[];
    allowsUnprioritized: boolean;
    effort: readonly TaskEffort[];
    taskTypes: boolean;
    projectAdministration: boolean;
    userAdministration: boolean;
    accountPreferences: boolean;
  };
  origins: {
    production: string;
    development: string;
    portalProduction: string;
    portalDevelopment: string;
  };
  identity: {
    providerLabel: string;
    hostedDomain: string;
    initialAdminEmail: string;
    logoutPath: string;
    logoutMethod: 'get' | 'post';
  };
  agent: {
    enabled: boolean;
    name: string;
    email: string;
  };
  links: {
    portal: string;
  };
  capabilities: {
    hideAgentTasks: boolean;
    portal: boolean;
    mobileApi: boolean;
    events: boolean;
    eventPlanning: boolean;
    portalSupport: boolean;
    workflowAnalytics: boolean;
    emailNotifications: boolean;
    portalAlerts: boolean;
  };
  branding: {
    light: TenantBrandPalette;
    dark: TenantBrandPalette;
  };
  security: {
    cookiePrefix: string;
    tokenIssuer: string;
  };
  mcp: {
    serverName: string;
    gatewayHeader: string;
    clientHeader: string;
    instructions: string;
  };
  integrations: {
    emailGateway: {
      productionOrigin: string;
      clientId: string;
      fromEmail: string;
    };
    mobileGateway: {
      issuer: string;
      audience: string;
      environment: string;
    };
  };
} & TenantProfileExtensions;

export const DEFAULT_TENANT_PROFILE = {
  key: 'default',
  organizationName: 'Team',
  productName: 'Tasks',
  serviceName: 'tasks',
  workspaceKey: 'default',
  defaultProjectKey: 'TASKS',
  defaultProjectName: 'Tasks',
  defaultProjectDescription: 'Default project',
  tasks: {
    apiMode: 'legacy',
    workflow: ['not_started', 'in_progress', 'blocked', 'backlog', 'done'],
    priorities: ['high', 'medium', 'low'],
    allowsUnprioritized: true,
    effort: ['small', 'medium', 'large'],
    taskTypes: true,
    projectAdministration: true,
    userAdministration: true,
    accountPreferences: true,
  },
  // Empty origins mean "use the request origin" (or TASKS_PUBLIC_ORIGIN when it is set).
  origins: {
    production: '',
    development: '',
    portalProduction: '',
    portalDevelopment: '',
  },
  identity: {
    providerLabel: 'Google',
    // No default: set TASKS_HOSTED_DOMAIN at runtime to restrict sign-in to one email domain.
    hostedDomain: '',
    // No default: set TASKS_INITIAL_ADMIN_EMAIL at runtime to bootstrap the first administrator.
    initialAdminEmail: '',
    logoutPath: '/auth/logout',
    logoutMethod: 'post',
  },
  agent: {
    enabled: true,
    name: 'Agent',
    email: 'agent@tasks.invalid',
  },
  links: {
    portal: '',
  },
  capabilities: {
    hideAgentTasks: true,
    portal: false,
    mobileApi: false,
    events: true,
    eventPlanning: true,
    portalSupport: false,
    workflowAnalytics: true,
    emailNotifications: false,
    portalAlerts: false,
  },
  branding: {
    light: {
      accent: '#2f5d8a',
      accentHover: '#24486c',
      accentSubtle: '#dceaf7',
      accentBorder: '#a9c8e4',
      brand: '#243851',
      brandStrong: '#15263d',
      onAccent: '#ffffff',
    },
    dark: {
      accent: '#7ca7cf',
      accentHover: '#9cc0e0',
      accentSubtle: '#1a2c3f',
      accentBorder: '#3a6087',
      brand: '#7ca7cf',
      brandStrong: '#a9c8e4',
      onAccent: '#0b1520',
    },
  },
  security: {
    cookiePrefix: 'tasks',
    tokenIssuer: 'tasks',
  },
  mcp: {
    serverName: 'tasks',
    gatewayHeader: 'X-Tasks-MCP-Gateway-Token',
    clientHeader: 'X-Tasks-MCP-Token',
    instructions:
      'Use idempotency keys for every mutation and comment meaningful progress on the tasks you change.',
  },
  integrations: {
    emailGateway: {
      productionOrigin: 'https://disabled.invalid',
      clientId: 'disabled',
      fromEmail: 'tasks@disabled.invalid',
    },
    mobileGateway: {
      issuer: 'disabled',
      audience: 'disabled',
      environment: 'disabled',
    },
  },
} as const satisfies TenantProfile;

/**
 * The active profile is intentionally a source-controlled, non-secret value.
 * A downstream deployment replaces this export while retaining the contract and
 * supplies its own identity, persistence, migration, integration, and infrastructure
 * adapters. Replacing the profile alone is not a supported tenant conversion.
 */
export function validateTenantProfile(profile: TenantProfile): TenantProfile {
  const failures: string[] = [];
  if (profile.capabilities.eventPlanning && !profile.capabilities.events) {
    failures.push('eventPlanning requires events');
  }
  if (profile.capabilities.workflowAnalytics && !profile.capabilities.events) {
    failures.push('workflowAnalytics requires events');
  }
  if (profile.capabilities.portalSupport && !profile.capabilities.portal) {
    failures.push('portalSupport requires portal');
  }
  if (profile.capabilities.portalAlerts && !profile.capabilities.portal) {
    failures.push('portalAlerts requires portal');
  }
  if (
    profile.identity.initialAdminEmail &&
    profile.identity.hostedDomain &&
    !isTenantHostedEmail(profile.identity.initialAdminEmail, profile)
  ) {
    failures.push('initialAdminEmail must use identity.hostedDomain');
  }
  if (!profile.agent.name.trim()) failures.push('agent.name must not be empty');
  if (!profile.agent.email.includes('@')) failures.push('agent.email must be an email address');
  if (profile.capabilities.hideAgentTasks && !profile.agent.enabled) {
    failures.push('hideAgentTasks requires agent.enabled');
  }
  if (profile.tasks.workflow.length === 0) failures.push('tasks.workflow must not be empty');
  if (profile.tasks.priorities.length === 0) failures.push('tasks.priorities must not be empty');
  if (failures.length) throw new Error(`Invalid tenant profile: ${failures.join('; ')}`);
  return profile;
}

export const tenantProfile: TenantProfile = validateTenantProfile(DEFAULT_TENANT_PROFILE);

export function tenantTitle(profile: TenantProfile = tenantProfile) {
  return `${profile.organizationName} ${profile.productName}`.trim();
}

/**
 * True for a syntactically plain email address inside the profile's hosted domain. A profile with no
 * hosted domain accepts any plain address; the runtime `TASKS_HOSTED_DOMAIN` setting is applied by
 * `isHostedEmail` in `src/runtime/identity-config.ts`.
 */
export function isTenantHostedEmail(
  value: string,
  profile: TenantProfile = tenantProfile,
): boolean {
  return hostedEmailMatches(value, profile.identity.hostedDomain);
}

export function tenantAppOrigin(
  environment: string | undefined,
  fallbackOrigin: string,
  profile: TenantProfile = tenantProfile,
) {
  if (environment === 'production') return profile.origins.production || fallbackOrigin;
  if (environment === 'dev') return profile.origins.development || fallbackOrigin;
  return fallbackOrigin;
}

export function tenantPortalOrigin(
  environment: string | undefined,
  profile: TenantProfile = tenantProfile,
) {
  return environment === 'production'
    ? profile.origins.portalProduction
    : profile.origins.portalDevelopment;
}
