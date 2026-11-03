// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tenantProfile } from '../../shared/tenant-profile';
import {
  notificationChannelsForCapabilities,
  TaskPreferencesDialog,
} from '../../web/src/tasks/TaskPreferencesDialog';

const alerts = {
  assignments: { email: true, inApp: false, push: false },
  comments: { email: true, inApp: false, push: false },
  mentions: { email: true, inApp: false, push: false },
  deadlines: { email: true, inApp: false, push: false },
};
const channels = notificationChannelsForCapabilities(tenantProfile.capabilities);

describe('task preferences dialog', () => {
  let container: HTMLElement;
  let root: Root;
  let patches: unknown[];
  const onOpenChange = vi.fn();

  async function settle() {
    for (let pass = 0; pass < 5; pass += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  async function mount(showTaskCreation = true) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(TaskPreferencesDialog, { onOpenChange, open: true, showTaskCreation }),
        ),
      );
    });
    await settle();
  }

  const q = <T extends Element>(selector: string) => document.body.querySelector<T>(selector);
  const saveButton = () =>
    [...document.body.querySelectorAll('button')].find((b) =>
      /^(Save changes|Saving…)$/.test(b.textContent ?? ''),
    );

  beforeEach(() => {
    patches = [];
    onOpenChange.mockReset();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/account/preferences')) {
          const body = JSON.parse(String(init?.body));
          patches.push(body);
          return Response.json({ preferences: body });
        }
        return Response.json({
          authConfigured: true,
          permissions: ['tasks.view'],
          user: {
            id: 1,
            email: 'admin@example.org',
            first_name: 'Alex',
            last_name: 'Admin',
            photo_url: null,
            task_creation_mode: 'guided',
            task_alert_preferences: alerts,
          },
        });
      }),
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('keeps Save disabled until something changes, then saves only the changed model', async () => {
    await mount();
    expect(saveButton()?.disabled).toBe(true);
    expect(q('[role="alert"]')).toBeNull();

    const quick = q<HTMLInputElement>('input[name="task-creation-mode"][value="quick"]');
    await act(async () => quick?.click());
    expect(saveButton()?.disabled).toBe(false);
    expect(document.body.textContent).toContain('Unsaved changes');

    await act(async () => {
      q<HTMLFormElement>('form.preferences-form')?.requestSubmit();
    });
    await settle();

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ taskCreationMode: 'quick' });
    expect(Object.keys(patches[0] as object).sort()).toEqual([
      'notificationAlerts',
      'taskCreationMode',
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('discards changes on Cancel without saving', async () => {
    await mount();
    await act(async () =>
      q<HTMLInputElement>('input[name="task-creation-mode"][value="quick"]')?.click(),
    );
    const cancel = [...document.body.querySelectorAll('button')].find(
      (b) => b.textContent === 'Cancel',
    );
    await act(async () => cancel?.click());
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(patches).toHaveLength(0);
  });

  it('closes on Escape', async () => {
    await mount();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('is a labelled dialog with a grouped task-creation choice', async () => {
    await mount();
    const dialog = q('[role="dialog"]');
    expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(q('fieldset.preferences-section legend')?.textContent).toBe('Creating tasks');
    expect(document.body.querySelectorAll('input[name="task-creation-mode"]')).toHaveLength(2);
  });

  it.runIf(channels.length > 0)(
    'lays alerts out as one labelled checkbox per alert and enabled channel',
    async () => {
      await mount();
      const boxes = document.body.querySelectorAll<HTMLInputElement>(
        '.preferences-matrix input[type="checkbox"]',
      );
      expect(boxes).toHaveLength(4 * channels.length);
      const first = channels[0];
      expect(
        q<HTMLInputElement>(`input[aria-label="${first?.shortLabel} for Assignments"]`),
      ).not.toBeNull();

      const comments = q<HTMLInputElement>(`input[aria-label="${first?.shortLabel} for Comments"]`);
      await act(async () => comments?.click());
      expect(saveButton()?.disabled).toBe(false);
      await act(async () => comments?.click());
      expect(saveButton()?.disabled).toBe(true);
    },
  );

  it.runIf(channels.length === 0)(
    'omits the alert matrix when no delivery channel is enabled',
    async () => {
      await mount();
      expect(q('.preferences-matrix')).toBeNull();
      expect(document.body.textContent).toContain('Alert delivery is not enabled');
    },
  );

  it.runIf(channels.length === 0)(
    'offers only Close when there is nothing to configure',
    async () => {
      await mount(false);
      expect(saveButton()).toBeUndefined();
      expect(
        [...document.body.querySelectorAll('button')].some((b) => b.textContent === 'Close'),
      ).toBe(true);
    },
  );
});
