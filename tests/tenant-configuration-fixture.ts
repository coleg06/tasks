import { tenantProfile } from '../shared/tenant-profile';

export const matchingTenantConfigurationRow = {
  tenant_key: tenantProfile.key,
  organization_name: tenantProfile.organizationName,
  workspace_key: tenantProfile.workspaceKey,
  default_project_key: tenantProfile.defaultProjectKey,
  default_project_name: tenantProfile.defaultProjectName,
  default_project_description: tenantProfile.defaultProjectDescription,
  initial_admin_email: tenantProfile.identity.initialAdminEmail,
  agent_name: tenantProfile.agent.name,
  agent_email: tenantProfile.agent.email,
};

export function isTenantConfigurationQuery(sql: string) {
  return sql.includes('FROM tenant_configuration');
}
