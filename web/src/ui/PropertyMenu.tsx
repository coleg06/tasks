import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

export type MenuOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

/**
 * A property control that reads as text until touched. Radix supplies the
 * roving focus, typeahead and escape handling that a native <select> gives up
 * the moment you want it to look like anything else.
 */
export function PropertyMenu<T extends string>({
  ariaLabel,
  disabled = false,
  onSelect,
  options,
  trigger,
  value,
}: {
  ariaLabel: string;
  disabled?: boolean;
  onSelect: (value: T) => void;
  options: MenuOption<T>[];
  trigger: ReactNode;
  value: T;
}) {
  if (disabled) return <span className="property-value is-readonly">{trigger}</span>;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label={ariaLabel} className="property-value" type="button">
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" className="menu" sideOffset={4}>
          {options.map((option) => (
            <DropdownMenu.Item
              className="menu-item"
              key={option.value}
              onSelect={() => onSelect(option.value)}
            >
              {option.icon ? <span className="menu-item-icon">{option.icon}</span> : null}
              <span className="menu-item-label">{option.label}</span>
              {option.value === value ? <Check className="menu-item-check" /> : null}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
