// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultRuntimeFeatures } from '../../shared/runtime-features';
import { AdminPanel } from '../../web/src/admin/AdminPanel';
import { keys } from '../../web/src/api/queries';
import type { AdminRolesData, DirectoryPage } from '../../web/src/api/types';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const userEmail = 'staff@example.org';

const directory = {
  users: [
    {
      id: 1,
      email: userEmail,
      firstName: 'Staff',
      lastName: 'Staff',
      name: 'Staff Member',
      photoUrl: null,
      hasSignedIn: true,
      status: 'active',
      principalType: 'human',
      lastSeenAt: '2026-08-30T00:00:00Z',
      createdAt: '2026-08-30T00:00:00Z',
      roles: ['member'],
      isPlatformAdmin: false,
      isManager: false,
    },
    {
      id: 2,
      email: 'admin@example.org',
      firstName: 'Admin',
      lastName: 'Example',
      name: 'Admin Example',
      photoUrl: null,
      hasSignedIn: false,
      status: 'disabled',
      principalType: 'human',
      lastSeenAt: null,
      createdAt: '2026-08-30T00:00:00Z',
      roles: [],
      isPlatformAdmin: true,
      isManager: true,
    },
  ],
  total: 2,
  nextCursor: null,
} satisfies DirectoryPage;

const roles = {
  roles: [
    {
      key: 'member',
      label: 'Member',
      description: 'Work on shared tasks.',
      builtin: true,
      permissions: ['tasks.view'],
      grantsAll: false,
      userCount: 1,
      assignable: true,
    },
  ],
  catalog: [],
  canManageRoles: true,
} satisfies AdminRolesData;

afterEach(() => {
  document.body.replaceChildren();
  window.history.replaceState(null, '', '#');
});

function mount(hash: string) {
  window.history.replaceState(null, '', hash);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(keys.adminRoles, roles);
  queryClient.setQueryData(
    keys.adminDirectory({ q: '', status: '', role: '', cursor: '' }),
    directory,
  );
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
          features: { ...defaultRuntimeFeatures, events: false },
        }),
      ),
    );
  });
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      queryClient.clear();
    },
  };
}

describe('AdminPanel', () => {
  it('opens on the people directory with aligned columns and no all-users table', () => {
    const { container, cleanup } = mount('#');
    const table = container.querySelector('.admin-table-people');
    const header = table?.querySelector('.admin-table-header');
    const rows = table?.querySelectorAll('.admin-table-row') ?? [];
    const headerCells = Array.from(header?.children ?? []);

    expect(headerCells.map((cell) => cell.textContent)).toEqual([
      '',
      'Person',
      'Roles',
      'Status',
      'Last sign-in',
    ]);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.children).toHaveLength(headerCells.length);
    expect(rows[0]?.textContent).toContain('Staff Member');
    expect(rows[0]?.textContent).toContain('Member');
    expect(rows[1]?.textContent).toContain('Platform admin');
    expect(rows[1]?.textContent).toContain('Disabled');
    expect(container.textContent).toContain('1–2 of 2');
    // The signed-in administrator cannot select themselves for bulk actions.
    expect(
      container.querySelector<HTMLInputElement>('[aria-label="Select admin@example.org"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>(`[aria-label="Select ${userEmail}"]`)?.disabled,
    ).toBe(false);
    cleanup();
  });

  it('offers the four administration sections and switches between them', () => {
    const { container, cleanup } = mount('#');
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'People',
      'Roles',
      'Audit log',
      'Overview',
    ]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    act(() => (tabs[1] as HTMLElement).click());
    expect(container.querySelector('[aria-label="Roles"]')).not.toBeNull();
    expect(container.textContent).toContain('Create role');
    expect(window.location.hash).toBe('#roles');
    cleanup();
  });

  it('opens directly on the section named in the address', () => {
    const { container, cleanup } = mount('#audit');
    expect(container.querySelector('[aria-label="Audit log"]')).not.toBeNull();
    cleanup();
  });
});
