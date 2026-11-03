import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const stylesheetUrl = new URL('../../web/src/styles/tokens.css', import.meta.url);

function rule(stylesheet: string, selector: RegExp) {
  const match = new RegExp(`${selector.source}\\s*\\{([^}]*)\\}`).exec(stylesheet);
  if (!match) throw new Error(`Missing CSS rule for ${selector.source}`);
  return match[1];
}

describe('viewport scroll containment', () => {
  it('keeps the document fixed while task panes own vertical scrolling', async () => {
    const stylesheet = await readFile(stylesheetUrl, 'utf8');
    const rootRule = rule(stylesheet, /html\s*,\s*body\s*,\s*#root/);
    const documentRule = rule(stylesheet, /html\s*,\s*body/);
    const contentRule = rule(stylesheet, /\.tasks-content/);
    const sidebarRule = rule(stylesheet, /\.tasks-sidebar/);
    const sidebarTopRule = rule(stylesheet, /\.tasks-sidebar-top/);
    const scrollingSidebarTopRule = rule(stylesheet, /\.tasks-sidebar-top\.is-scrolling/);
    const sidebarThumbRule = rule(stylesheet, /\.tasks-sidebar-top::-webkit-scrollbar-thumb/);
    const scrollingSidebarThumbRule = rule(
      stylesheet,
      /\.tasks-sidebar-top\.is-scrolling::-webkit-scrollbar-thumb/,
    );
    const accountRule = rule(stylesheet, /\.tasks-account/);

    expect(rootRule).toMatch(/height:\s*100%/);
    expect(rootRule).toMatch(/min-height:\s*0/);
    expect(rootRule).toMatch(/overflow:\s*hidden/);
    expect(documentRule).toMatch(/overscroll-behavior:\s*none/);
    expect(contentRule).toMatch(/overflow-y:\s*auto/);
    expect(contentRule).toMatch(/overscroll-behavior-y:\s*contain/);
    expect(sidebarRule).toMatch(/overflow:\s*hidden/);
    expect(sidebarRule).toMatch(/min-height:\s*0/);
    expect(sidebarTopRule).toMatch(/overflow-y:\s*auto/);
    expect(sidebarTopRule).toMatch(/min-height:\s*0/);
    expect(sidebarTopRule).toMatch(/flex:\s*1/);
    expect(sidebarTopRule).toMatch(/overscroll-behavior-y:\s*contain/);
    expect(sidebarTopRule).toMatch(/scrollbar-color:\s*transparent transparent/);
    expect(sidebarThumbRule).toMatch(/background-color:\s*transparent/);
    expect(scrollingSidebarTopRule).toMatch(/scrollbar-color:\s*var\(--text-subtle\) transparent/);
    expect(scrollingSidebarThumbRule).toMatch(/background-color:\s*var\(--text-subtle\)/);
    expect(accountRule).toMatch(/flex:\s*none/);
  });
});
