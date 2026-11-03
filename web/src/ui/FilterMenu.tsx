import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

export type FilterOption = {
  value: string;
  label: string;
  icon?: ReactNode;
};

/**
 * A column heading that is also its filter control. Multi-select by default,
 * because "show me in progress and blocked" is the common ask; `single` swaps
 * to radio behaviour for filters where combining makes no sense (due date).
 */
export function FilterMenu({
  label,
  onChange,
  options,
  single = false,
  value,
}: {
  label: string;
  onChange: (value: string | undefined) => void;
  options: FilterOption[];
  single?: boolean;
  value: string | undefined;
}) {
  const selected = (value ?? '').split(',').filter(Boolean);
  const active = selected.length > 0;

  function toggle(option: string) {
    if (single) {
      onChange(selected[0] === option ? undefined : option);
      return;
    }
    const next = selected.includes(option)
      ? selected.filter((entry) => entry !== option)
      : [...selected, option];
    onChange(next.length ? next.join(',') : undefined);
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={active ? 'column-filter is-active' : 'column-filter'}>
        {label}
        {active ? <span className="column-filter-count">{selected.length}</span> : null}
        <ChevronDown aria-hidden="true" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" className="menu" sideOffset={4}>
          {options.map((option) => (
            <DropdownMenu.CheckboxItem
              checked={selected.includes(option.value)}
              className="menu-item"
              key={option.value}
              onSelect={(event) => {
                event.preventDefault();
                toggle(option.value);
              }}
            >
              {option.icon ? <span className="menu-item-icon">{option.icon}</span> : null}
              <span className="menu-item-label">{option.label}</span>
              {selected.includes(option.value) ? <Check className="menu-item-check" /> : null}
            </DropdownMenu.CheckboxItem>
          ))}
          {active ? (
            <>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item" onSelect={() => onChange(undefined)}>
                <span className="menu-item-label">Clear {label.toLowerCase()}</span>
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
