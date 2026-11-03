import { LogIn } from 'lucide-react';
import type { ReactNode } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useBootstrap, useStopAdminImpersonation } from '../api/queries';
import { Sidebar } from './Sidebar';

export function AppShell({ children }: { children: ReactNode }) {
  const bootstrap = useBootstrap();
  const stopImpersonation = useStopAdminImpersonation();
  const signedIn = Boolean(bootstrap.data?.user);

  if (bootstrap.isLoading) {
    return <div className="tasks-shell" aria-busy="true" />;
  }

  if (!signedIn) {
    return (
      <div className="tasks-signin">
        <div>
          <span>{tenantProfile.organizationName}</span>
          <strong>{tenantProfile.productName}</strong>
          <p>Sign in with your {tenantProfile.identity.providerLabel} account to continue.</p>
          <a
            className="tasks-login"
            href={`/auth/login?returnTo=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`}
          >
            <LogIn aria-hidden="true" />
            Continue with {tenantProfile.identity.providerLabel}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="tasks-shell">
      <Sidebar />
      <main className="tasks-main">
        {bootstrap.data?.impersonation ? (
          <div className="impersonation-banner" role="status">
            <span>
              Viewing {tenantProfile.productName} as <strong>{bootstrap.data.user?.email}</strong>
            </span>
            <button
              disabled={stopImpersonation.isPending}
              onClick={() => stopImpersonation.mutate()}
              type="button"
            >
              Return to {bootstrap.data.impersonation.actor.email}
            </button>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
