// @vitest-environment jsdom
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MentionTextarea, mentionAt } from '../../web/src/ui/MentionTextarea';

const people = [
  { name: 'Alice Example', email: 'alice@example.test' },
  { name: 'Bob Example', email: 'bob@example.test' },
];

describe('inline mentions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let input: HTMLTextAreaElement;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    function Composer() {
      const [value, setValue] = useState('');
      return createElement(MentionTextarea, { value, onChange: setValue, people });
    }
    act(() => root.render(createElement(Composer)));
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Textarea missing');
    input = textarea;
    act(() => input.focus());
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  function type(value: string, caret = value.length) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        input,
        value,
      );
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function key(key: string, isComposing = false) {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      isComposing,
    });
    act(() => input.dispatchEvent(event));
    return event;
  }
  it('offers names on @ and selects by keyboard without submitting', () => {
    type('Hello @');
    expect(container.querySelectorAll('[role=option]')).toHaveLength(2);
    key('ArrowDown');
    expect(key('Enter').defaultPrevented).toBe(true);
    expect(input.value).toBe('Hello @bob ');
    expect(container.querySelector('[role=listbox]')).toBeNull();
  });
  it('filters names and inserts at the caret while preserving surrounding text', () => {
    type('Ask @Exam tomorrow', 9);
    const options = container.querySelectorAll<HTMLButtonElement>('[role=option]');
    expect(options).toHaveLength(2);
    act(() => options[0]?.click());
    expect(input.value).toBe('Ask @alice tomorrow');
  });
  it('replaces the rest of a partially edited handle', () => {
    type('Ask @alice tomorrow', 7);
    key('Enter');
    expect(input.value).toBe('Ask @alice tomorrow');
  });
  it('dismisses Escape without closing a parent dialog, then allows ordinary Enter', () => {
    type('@');
    expect(key('Escape').defaultPrevented).toBe(true);
    expect(container.querySelector('[role=listbox]')).toBeNull();
    expect(key('Enter').defaultPrevented).toBe(false);
  });
  it('does not intercept IME confirmation or Enter with no matches', () => {
    type('@');
    expect(key('Enter', true).defaultPrevented).toBe(false);
    type('@nobody');
    expect(container.textContent).toContain('No matching people');
    expect(key('Enter').defaultPrevented).toBe(false);
  });
  it('does not trigger on email addresses or selected text', () => {
    type('alice@example.test');
    expect(container.querySelector('[role=listbox]')).toBeNull();
    expect(mentionAt('@alice', 1, 6)).toBeNull();
    expect(mentionAt('one\n@bo', 7)?.query).toBe('bo');
  });
});
