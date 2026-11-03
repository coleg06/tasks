import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type { AdminRole } from '../api/types';

export function dateTime(value: string | null, empty = 'Never') {
  if (!value) return empty;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function shortDate(value: string | null, empty = 'Never') {
  if (!value) return empty;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(value));
}

/** Debounces a fast-changing value (search boxes) so each keystroke is not a request. */
export function useDebounced<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function errorText(error: unknown, fallback = 'That request could not be completed.') {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Role labels for a list of keys; unknown keys fall back to the key itself. */
export function RoleChips({
  keys,
  roles,
  limit = 2,
}: {
  keys: string[];
  roles: Map<string, AdminRole>;
  limit?: number;
}) {
  if (keys.length === 0) return <span className="admin-muted">No role</span>;
  const shown = keys.slice(0, limit);
  return (
    <span className="role-chips">
      {shown.map((key) => (
        <span className={`badge role-chip${key === 'admin' ? ' is-accent' : ''}`} key={key}>
          {roles.get(key)?.label ?? key}
        </span>
      ))}
      {keys.length > limit ? (
        <span className="badge role-chip" title={keys.slice(limit).join(', ')}>
          +{keys.length - limit}
        </span>
      ) : null}
    </span>
  );
}

export type ActionOption = { value: string; label: string; hint?: string; disabled?: boolean };

/** A button that opens a menu of choices; used for bulk actions and filters. */
export function ActionMenu({
  ariaLabel,
  children,
  disabled = false,
  onSelect,
  options,
  value,
  className = 'button-quiet',
}: {
  ariaLabel: string;
  children: ReactNode;
  disabled?: boolean;
  onSelect: (value: string) => void;
  options: ActionOption[];
  value?: string;
  className?: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={ariaLabel}
        className={className}
        disabled={disabled}
        type="button"
      >
        {children}
        <ChevronDown aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" className="menu admin-action-menu" sideOffset={4}>
          {options.length === 0 ? <div className="menu-empty">Nothing to choose</div> : null}
          {options.map((option) => (
            <DropdownMenu.Item
              className="menu-item"
              disabled={option.disabled === true}
              key={option.value}
              onSelect={() => onSelect(option.value)}
            >
              <span className="menu-item-label">
                {option.label}
                {option.hint ? <small>{option.hint}</small> : null}
              </span>
              {option.value === value ? <Check className="menu-item-check" /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
