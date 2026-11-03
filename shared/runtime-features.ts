import { type TenantProfile, tenantProfile } from './tenant-profile';

export const runtimeFeatureModules = ['tasks', 'projects', 'events', 'workflows'] as const;
export type RuntimeFeatureModule = (typeof runtimeFeatureModules)[number];

export type RuntimeFeatures = {
  tasks: true;
  projects: boolean;
  events: boolean;
  eventPlanning: boolean;
  workflowAnalytics: boolean;
};

export const defaultFeatureModules = runtimeFeatureModules.join(',');

/**
 * Resolves the deployment overlay without allowing it to exceed the capabilities
 * compiled into the tenant profile. Tasks is the stable core and cannot be disabled.
 */
export function resolveRuntimeFeatures(
  configuredModules?: string,
  profile: TenantProfile = tenantProfile,
): RuntimeFeatures {
  const configured = configuredModules?.trim() || defaultFeatureModules;
  const modules = new Set(
    configured
      .split(',')
      .map((module) => module.trim().toLowerCase())
      .filter(Boolean),
  );
  const unknown = [...modules].filter(
    (module) => !runtimeFeatureModules.includes(module as RuntimeFeatureModule),
  );
  if (unknown.length) throw new Error(`Unknown feature modules: ${unknown.join(', ')}`);
  if (!modules.has('tasks')) throw new Error('FEATURE_MODULES must include tasks');

  const events = profile.capabilities.events && modules.has('events');
  return {
    tasks: true,
    projects: modules.has('projects'),
    events,
    eventPlanning: events && profile.capabilities.eventPlanning,
    workflowAnalytics: events && profile.capabilities.workflowAnalytics && modules.has('workflows'),
  };
}

export const defaultRuntimeFeatures = resolveRuntimeFeatures();
