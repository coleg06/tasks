// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRuntimeFeatures } from '../../shared/runtime-features';
import { AdminPanel } from '../../web/src/admin/AdminPanel';
import { keys } from '../../web/src/api/queries';
import type { AdminData } from '../../web/src/api/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userEmail = 'staff@example.org';

const adminData = {
  stats: { users: 1, projects: 0, tasks: 0, comments: 0 },
  users: [
    {
      id: 1,
      email: userEmail,
      firstName: 'Staff',
      lastName: 'Staff',
      name: 'Staff Member',
      photoUrl: null,
      hasSignedIn: true,
      createdAt: '2026-08-30T00:00:00Z',
      status: 'active',
      lastSeenAt: '2026-08-30T00:00:00Z',
      permissions: ['tasks.view'],
    },
  ],
  projects: [],
  events: [],
  notificationHealth: {
    environment: 'production',
    emailConfigured: false,
    portalAlertsConfigured: false,
    email: {
      accepted24h: 0,
      failed24h: 0,
      unresolvedFailed: 0,
      stalledPending: 0,
      lastAcceptedAt: null,
      lastFailedAt: null,
    },
    portalAlerts: {
      delivered24h: 0,
      readyToRetry: 0,
      stalledProcessing: 0,
      deadLetter: 0,
      lastDeliveredAt: null,
    },
    recentEmailDeliveries: [],
  },
  operationalHealth: {
    errors24h: 0,
    warnings24h: 0,
    lastEventAt: null,
    recentEvents: [],
  },
} satisfies AdminData;

afterEach(() => {
  document.body.replaceChildren();
});

describe('AdminPanel tenant capabilities', () => {
  it('keeps core user columns aligned when event administration is disabled', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(keys.admin, adminData);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(AdminPanel, {
            currentEmail: 'admin@example.org',
            features: {
              ...defaultRuntimeFeatures,
              events: false,
              eventPlanning: false,
              workflowAnalytics: false,
            },
          }),
        ),
      );
    });

    const usersTable = container.querySelector('.admin-table-users');
    const header = usersTable?.querySelector('.admin-table-header');
    const row = usersTable?.querySelector('.admin-table-row');
    const headerCells = Array.from(header?.children ?? []);
    const rowCells = Array.from(row?.children ?? []);

    expect(usersTable?.classList.contains('without-events')).toBe(true);
    expect(headerCells.map((cell) => cell.textContent)).toEqual([
      'User',
      'Last active',
      'Status',
      'Platform role',
      'Task role',
      'Actions',
    ]);
    expect(rowCells).toHaveLength(headerCells.length);
    expect(rowCells[0]?.textContent).toContain('Staff Member');
    expect(rowCells[1]?.classList.contains('admin-muted')).toBe(true);
    expect(rowCells[1]?.textContent).not.toBe('');
    expect(rowCells[2]?.querySelector(`[aria-label="Status for ${userEmail}"]`)).not.toBeNull();
    expect(rowCells[3]?.textContent).toBe('Standard');
    expect(rowCells[4]?.querySelector(`[aria-label="Role for ${userEmail}"]`)).not.toBeNull();
    expect(rowCells[5]?.querySelector(`[aria-label="Edit ${userEmail}"]`)).not.toBeNull();
    expect(headerCells.map((cell) => cell.textContent)).not.toContain('Event role');
    expect(headerCells.map((cell) => cell.textContent)).not.toContain('Approvals');
    expect(usersTable?.querySelector(`[aria-label="Event role for ${userEmail}"]`)).toBeNull();
    expect(
      usersTable?.querySelector(`[aria-label="Event approval role for ${userEmail}"]`),
    ).toBeNull();

    act(() => root.unmount());
    queryClient.clear();
  });
});
