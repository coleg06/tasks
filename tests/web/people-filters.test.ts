// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeopleTab } from '../../web/src/admin/PeopleTab';
import type { DirectoryUser } from '../../web/src/api/types';

/**
 * The People filters are dropdown menus, not native selects, so they match the
 * rest of the app's filters (the shared ActionMenu). This exercises the same
 * contract: labelled triggers, keyboard-reachable menu items, and the exact
 * `status`/`role` query parameters the directory endpoint receives.
 */

const directoryRequests: string[] = [];

/** Query parameters of a recorded request; fetch inputs are relative URLs. */
const paramsOf = (url: string) => new URL(url, 'https://example.org').searchParams;

function person(overrides: Partial<DirectoryUser> & { id: number }): DirectoryUser {
  return {
    email: `person-${overrides.id}@example.org`,
    firstName: 'Person',
    lastName: String(overrides.id),
    name: `Person ${overrides.id}`,
    photoUrl: null,
    hasSignedIn: true,
    status: 'active',
    principalType: 'human',
    lastSeenAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    roles: [],
    isPlatformAdmin: false,
    isManager: false,
    ...overrides,
  };
}

const page = {
  users: [
    person({ id: 1, status: 'active', roles: ['editor'] }),
    person({ id: 2, status: 'disabled', roles: [] }),
  ],
  total: 2,
  nextCursor: null,
};

describe('people filters', () => {
  let container: HTMLElement;
  let root: Root;

  async function settle(until?: () => boolean) {
    for (let pass = 0; pass < 50; pass += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (until?.()) return;
    }
    if (until && !until()) throw new Error('people filters never settled');
  }

  async function mount() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(PeopleTab, {
            currentEmail: 'admin@example.org',
            currentIsPlatformAdmin: true,
          }),
        ),
      );
    });
    await settle(() => directoryRequests.length > 0);
  }

  const trigger = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')].find(
      (button) => button.getAttribute('aria-label')?.startsWith(`${label}: `),
    );

  const menuItem = (label: string) =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.includes(label),
    );

  function openMenu(label: string) {
    const button = trigger(label);
    if (!button) throw new Error(`no trigger labelled ${label}`);
    act(() => {
      button.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }),
      );
    });
  }

  beforeEach(() => {
    directoryRequests.length = 0;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith('/api/admin/roles')) {
          return Response.json({
            roles: [
              {
                key: 'editor',
                label: 'Editor',
                description: 'Edits tasks',
                builtin: true,
                permissions: [],
                grantsAll: false,
                userCount: 1,
                assignable: true,
              },
            ],
            catalog: [],
            canManageRoles: true,
          });
        }
        if (url.startsWith('/api/admin/directory')) {
          directoryRequests.push(url);
          return Response.json(page);
        }
        return Response.json({});
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('offers the filters as labelled dropdown menus instead of native selects', async () => {
    await mount();

    expect(container.querySelector('.admin-toolbar select')).toBeNull();
    const status = trigger('Filter by status');
    const role = trigger('Filter by role');
    expect(status).toBeDefined();
    expect(role).toBeDefined();
    expect(status?.textContent).toContain('Status: Any status');
    expect(role?.textContent).toContain('Role: Any role');
    expect(status?.getAttribute('aria-expanded')).toBe('false');
  });

  it('sends no status or role parameter until one is chosen', async () => {
    await mount();
    const first = paramsOf(directoryRequests[0] ?? '');
    expect(first.has('status')).toBe(false);
    expect(first.has('role')).toBe(false);
  });

  it('filters by status, marks the choice and resets back to any status', async () => {
    await mount();
    const status = trigger('Filter by status');

    openMenu('Filter by status');
    await settle(() => Boolean(menuItem('Disabled')));
    expect(status?.getAttribute('aria-expanded')).toBe('true');
    act(() => {
      menuItem('Disabled')?.click();
    });
    await settle(() => status?.textContent?.includes('Status: Disabled') ?? false);

    const filtered = paramsOf(directoryRequests.at(-1) ?? '');
    expect(filtered.get('status')).toBe('disabled');
    expect(status?.textContent).toContain('Status: Disabled');

    openMenu('Filter by status');
    await settle(() => Boolean(menuItem('Any status')));
    // The chosen option carries the check mark while the menu is open.
    expect(menuItem('Disabled')?.querySelector('.menu-item-check')).not.toBeNull();
    act(() => {
      menuItem('Any status')?.click();
    });
    await settle(() => status?.textContent?.includes('Status: Any status') ?? false);

    const reset = paramsOf(directoryRequests.at(-1) ?? '');
    expect(reset.has('status')).toBe(false);
  });

  it('filters by role key', async () => {
    await mount();
    const role = trigger('Filter by role');

    openMenu('Filter by role');
    await settle(() => Boolean(menuItem('Editor')));
    act(() => {
      menuItem('Editor')?.click();
    });
    await settle(() => role?.textContent?.includes('Role: Editor') ?? false);

    const filtered = paramsOf(directoryRequests.at(-1) ?? '');
    expect(filtered.get('role')).toBe('editor');
    expect(role?.textContent).toContain('Role: Editor');
  });
});
