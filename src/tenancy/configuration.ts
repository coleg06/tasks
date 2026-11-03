import { type TenantProfile, tenantProfile } from '../../shared/tenant-profile';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import type { Env } from '../env';

type TenantConfigurationRow = {
  tenant_key: string;
  organization_name: string;
  workspace_key: string;
  default_project_key: string;
  default_project_name: string;
  default_project_description: string;
  initial_admin_email: string;
  agent_name: string;
  agent_email: string;
};

/**
 * Names the profile fields that an enabled capability needs but the profile does not set. A
 * deployment profile written before these fields existed would otherwise silently fall back to
 * neutral defaults (wrong wire headers, disabled integrations), so the deployment fails closed
 * with this list instead. `eventAssistEndpoint` is the configured model endpoint, if any.
 */
export function profileConfigurationProblems(
  profile: TenantProfile = tenantProfile,
  options: { eventAssistEndpoint?: string | undefined } = {},
): string[] {
  const integrations = tenantExtensions(profile).integrations;
  const problems: string[] = [];
  if (profile.capabilities.mobileApi && !integrations?.mobileGateway?.headerPrefix) {
    problems.push('integrations.mobileGateway.headerPrefix');
  }
  if (profile.capabilities.emailNotifications && !integrations?.emailGateway?.headerPrefix) {
    problems.push('integrations.emailGateway.headerPrefix');
  }
  if (profile.capabilities.portalAlerts && !integrations?.portalAlerts?.endpoint) {
    problems.push('integrations.portalAlerts.endpoint');
  }
  if (profile.capabilities.portalSupport && !integrations?.portalSupport?.ticketHosts?.length) {
    problems.push('integrations.portalSupport.ticketHosts');
  }
  if (options.eventAssistEndpoint?.trim() && !integrations?.eventAssist?.allowedHosts?.length) {
    problems.push('integrations.eventAssist.allowedHosts');
  }
  return problems;
}

export async function tenantConfigurationMatches(env: Env, profile: TenantProfile = tenantProfile) {
  const row = await env.DB.prepare(
    `SELECT tenant_key, organization_name, workspace_key,
      default_project_key, default_project_name, default_project_description,
      initial_admin_email, agent_name, agent_email
     FROM tenant_configuration WHERE id = 1`,
  ).first<TenantConfigurationRow>();
  if (!row) return false;
  const expected: TenantConfigurationRow = {
    tenant_key: profile.key,
    organization_name: profile.organizationName,
    workspace_key: profile.workspaceKey,
    default_project_key: profile.defaultProjectKey,
    default_project_name: profile.defaultProjectName,
    default_project_description: profile.defaultProjectDescription,
    initial_admin_email: profile.identity.initialAdminEmail,
    agent_name: profile.agent.name,
    agent_email: profile.agent.email,
  };
  const exactKeys: Array<keyof TenantConfigurationRow> = [
    'tenant_key',
    'organization_name',
    'workspace_key',
    'default_project_key',
    'default_project_name',
    'default_project_description',
    'agent_name',
  ];
  const emailKeys: Array<keyof TenantConfigurationRow> = ['initial_admin_email', 'agent_email'];
  return (
    exactKeys.every((key) => row[key] === expected[key]) &&
    emailKeys.every(
      (key) =>
        typeof row[key] === 'string' && row[key].toLowerCase() === expected[key].toLowerCase(),
    )
  );
}

export async function tenantConfigurationIsVerified(env: Env) {
  // A portable deployment wires no datastore; the legacy surface must stay closed.
  if (!(env as { DB?: unknown }).DB) return false;
  const problems = profileConfigurationProblems(tenantProfile, {
    eventAssistEndpoint: env.EVENT_AI_ENDPOINT,
  });
  if (problems.length > 0) {
    console.error(
      JSON.stringify({
        type: 'tenant_profile_incomplete',
        message: 'Enabled capabilities need profile fields that are not set',
        missing: problems,
        tenant: tenantProfile.key,
      }),
    );
    return false;
  }
  // Check each invocation: a binding object is not proof of the database's identity.
  // Never persist successful authorization in isolate-level state.
  try {
    if (await tenantConfigurationMatches(env)) return true;
  } catch {
    // Database errors must not write operational events into an unverified tenant.
  }
  console.error(
    JSON.stringify({
      type: 'tenant_boundary_rejected',
      environment: env.ENVIRONMENT,
      tenant: tenantProfile.key,
    }),
  );
  return false;
}
