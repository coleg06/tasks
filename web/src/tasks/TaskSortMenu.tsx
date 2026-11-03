import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowUpDown, Check } from 'lucide-react';
import { type TaskSort, taskSorts } from './sorting';

const labels: Record<TaskSort, string> = {
  smart: 'Smart order',
  due_asc: 'Due date · Soonest',
  due_desc: 'Due date · Latest',
  created_desc: 'Date added · Newest',
  created_asc: 'Date added · Oldest',
  owner_asc: 'Task owner · A–Z',
  owner_desc: 'Task owner · Z–A',
  updated_desc: 'Recently updated',
  title_asc: 'Task name · A–Z',
  title_desc: 'Task name · Z–A',
};

export function TaskSortMenu({
  onChange,
  value,
}: {
  onChange: (value: TaskSort) => void;
  value: TaskSort;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        aria-label={`Sort tasks: ${labels[value]}`}
        className="tasks-filter-button"
      >
        <ArrowUpDown aria-hidden="true" />
        {value === 'smart' ? 'Sort' : labels[value]}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="menu" sideOffset={4}>
          <DropdownMenu.RadioGroup
            onValueChange={(next) => onChange(next as TaskSort)}
            value={value}
          >
            {taskSorts.map((sort) => (
              <DropdownMenu.RadioItem className="menu-item" key={sort} value={sort}>
                <span className="menu-item-label">{labels[sort]}</span>
                {sort === value ? <Check className="menu-item-check" /> : null}
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
