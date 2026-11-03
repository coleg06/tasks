import { tenantProfile } from '../../../shared/tenant-profile';
import { AdminPanel } from '../admin/AdminPanel';
import { useBootstrap } from '../api/queries';

export function AdminPage() {
  const bootstrap = useBootstrap();
  const email = bootstrap.data?.user?.email;

  if (!tenantProfile.tasks.userAdministration) {
    return (
      <div className="tasks-empty">
        <strong>Administration is unavailable</strong>
        <span>This deployment manages users and access through its identity provider.</span>
      </div>
    );
  }

  if (!bootstrap.data?.permissions.includes('tasks.manage')) {
    return (
      <div className="tasks-empty">
        <strong>Administration is restricted</strong>
        <span>Your account can view tasks but cannot manage them.</span>
      </div>
    );
  }

  return (
    <>
      <header className="tasks-topbar">
        <h1 className="tasks-page-title">Administration</h1>
      </header>
      <div className="tasks-content">
        {email ? <AdminPanel currentEmail={email} features={bootstrap.data.features} /> : null}
      </div>
    </>
  );
}
