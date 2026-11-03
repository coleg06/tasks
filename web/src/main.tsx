import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tenantProfile } from '../../shared/tenant-profile';
import { router } from './router';
import './styles/tokens.css';
import { AppErrorBoundary } from './telemetry/AppErrorBoundary';
import { installGlobalErrorReporting } from './telemetry/client-errors';
import { installTenantProfile } from './tenant-branding';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');

installGlobalErrorReporting();
const uninstallTenantProfile = installTenantProfile();
if (import.meta.hot) import.meta.hot.dispose(uninstallTenantProfile);

if (!root) {
  throw new Error(`${tenantProfile.productName} application root is unavailable.`);
}

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
