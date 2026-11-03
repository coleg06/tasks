import { useEffect, useId, useRef, useState } from 'react';

export type MentionPerson = { name: string; email: string };

export function mentionAt(value: string, start: number, end = start) {
  if (start !== end) return null;
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value.slice(0, start));
  if (!match) return null;
  const query = match[1] ?? '';
  const tail = /^[a-z0-9._+-]*/i.exec(value.slice(start))?.[0] ?? '';
  return { start: start - query.length - 1, end: start + tail.length, query };
}

export function MentionTextarea({
  value,
  onChange,
  people,
  label = 'Add a comment',
  rows = 2,
  maxLength = 5000,
}: {
  value: string;
  onChange: (value: string) => void;
  people: MentionPerson[];
  label?: string;
  rows?: number;
  maxLength?: number;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [composing, setComposing] = useState(false);
  const mention =
    range && !dismissed && !composing ? mentionAt(value, range.start, range.end) : null;
  const query = mention?.query.toLowerCase() ?? '';
  const matches = people.filter((person) =>
    `${person.name} ${person.email}`.toLowerCase().includes(query),
  );
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  const open = mention !== null;

  useEffect(() => {
    if (open)
      document.getElementById(`${id}-option-${selected}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, open, selected]);

  function track(target: HTMLTextAreaElement) {
    setRange({ start: target.selectionStart, end: target.selectionEnd });
    setActive(0);
    setDismissed(false);
  }

  function choose(person: MentionPerson) {
    if (!mention) return;
    const handle = `@${person.email.split('@')[0]}`;
    const suffix = value.slice(mention.end);
    const insertion = handle + (/^\s/.test(suffix) ? '' : ' ');
    const next = value.slice(0, mention.start) + insertion + suffix;
    if (next.length > maxLength) return;
    onChange(next);
    setDismissed(true);
    const caret = mention.start + insertion.length;
    setRange({ start: caret, end: caret });
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
      setDismissed(true);
    });
  }

  return (
    <div className="mention-input">
      <textarea
        ref={input}
        aria-label={label}
        data-mention-open={open || undefined}
        aria-autocomplete="list"
        aria-controls={open ? `${id}-options` : undefined}
        aria-activedescendant={open && matches.length ? `${id}-option-${selected}` : undefined}
        maxLength={maxLength}
        rows={rows}
        value={value}
        placeholder="Add a comment — type @ to mention someone"
        onChange={(event) => {
          onChange(event.target.value);
          track(event.target);
        }}
        onSelect={(event) => {
          const target = event.currentTarget;
          if (target.selectionStart !== range?.start || target.selectionEnd !== range?.end)
            track(target);
        }}
        onBlur={() => setRange(null)}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={(event) => {
          setComposing(false);
          track(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (!open || event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(true);
          } else if (matches.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setActive(
              (selected + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length,
            );
          } else if (matches.length && event.key === 'Enter') {
            event.preventDefault();
            const person = matches[selected];
            if (person) choose(person);
          } else if (event.key === 'Tab') {
            setDismissed(true);
          }
        }}
      />
      {open ? (
        <div className="mention-suggestions">
          <div id={`${id}-options`} role="listbox" aria-label="People to mention">
            {matches.map((person, index) => (
              <button
                type="button"
                tabIndex={-1}
                key={person.email}
                id={`${id}-option-${index}`}
                role="option"
                aria-selected={index === selected}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(person)}
                onMouseEnter={() => setActive(index)}
              >
                <strong>{person.name}</strong> <span>@{person.email.split('@')[0]}</span>
              </button>
            ))}
          </div>
          {!matches.length ? <p role="status">No matching people</p> : null}
        </div>
      ) : null}
    </div>
  );
}
