import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

/**
 * Text that commits on blur, and on Enter for single-line fields. There is no
 * save control: the value you see is the value that is stored.
 */
export function InlineText({
  ariaLabel,
  className,
  multiline = false,
  onCommit,
  placeholder,
  readOnly = false,
  value,
}: {
  ariaLabel: string;
  className: string;
  multiline?: boolean;
  onCommit: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  value: string;
}) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Adopt server changes unless the user is mid-edit on a different value.
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: resizing tracks the draft only; the ref is stable, so adding it would not change when this runs.
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [draft]);

  function commit() {
    const next = draft.trim();
    if (next === committed.current.trim()) return;
    if (!multiline && !next) {
      setDraft(committed.current);
      return;
    }
    committed.current = next;
    onCommit(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      setDraft(committed.current);
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Enter' && !multiline) {
      event.preventDefault();
      event.currentTarget.blur();
    }
  }

  if (readOnly) {
    return <p className={className}>{value || placeholder}</p>;
  }

  if (multiline) {
    return (
      <textarea
        aria-label={ariaLabel}
        className={className}
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder ?? ''}
        ref={textarea}
        rows={1}
        value={draft}
      />
    );
  }

  return (
    <input
      aria-label={ariaLabel}
      className={className}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder ?? ''}
      value={draft}
    />
  );
}
