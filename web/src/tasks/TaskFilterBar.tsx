import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronRight, ListFilter, X } from 'lucide-react';
import { tenantProfile } from '../../../shared/tenant-profile';
import type { Assignee, TaskStatus } from '../api/types';
import { priorityLabels, statusLabels, statusOrder } from '../api/types';
import { FilterMenu, type FilterOption } from '../ui/FilterMenu';
import { PriorityDot, StatusGlyph } from '../ui/fields';
import { parseList, type TaskFilterState } from './filters';

type FacetId = keyof TaskFilterState;

type Facet = {
  id: FacetId;
  label: string;
  options: FilterOption[];
  /** Due dates do not combine, so that facet behaves as a radio group. */
  single?: boolean;
};

const statusOptions: FilterOption[] = statusOrder.map((status: TaskStatus) => ({
  value: status,
  label: statusLabels[status],
  icon: <StatusGlyph status={status} />,
}));

const priorityOptions: FilterOption[] = tenantProfile.tasks.priorities.map((priority) => ({
  value: priority,
  label: priorityLabels[priority],
  icon: <PriorityDot priority={priority} />,
}));

const dueOptions: FilterOption[] = [
  { value: 'overdue', label: 'Overdue' },
  { value: 'today', label: 'Due today' },
  { value: 'week', label: 'Due this week' },
  { value: 'none', label: 'No due date' },
];

export function taskFacets(assignees: Assignee[]): Facet[] {
  return [
    { id: 'status', label: 'Status', options: statusOptions },
    {
      id: 'assignee',
      label: 'Assignee',
      options: [
        { value: 'me', label: 'Assigned to me' },
        { value: 'none', label: 'Unassigned' },
        ...assignees.map((assignee) => ({ value: assignee.email, label: assignee.name })),
      ],
    },
    { id: 'priority', label: 'Priority', options: priorityOptions },
    { id: 'due', label: 'Due', options: dueOptions, single: true },
  ];
}

/** "Overdue" when one value is picked, "Status: 2" when several are. */
function chipLabel(facet: Facet, value: string | undefined): string {
  const selected = parseList(value);
  if (selected.length === 1) {
    return facet.options.find((option) => option.value === selected[0])?.label ?? facet.label;
  }
  return `${facet.label}: ${selected.length}`;
}

/**
 * The row of applied filters. It renders nothing at all when no filter is set,
 * so the list starts flush against the header instead of under a band of
 * permanently-parked dropdowns.
 */
export function TaskFilterChips({
  assignees,
  filters,
  onChange,
  onClear,
}: {
  assignees: Assignee[];
  filters: TaskFilterState;
  onChange: (patch: Partial<TaskFilterState>) => void;
  onClear: () => void;
}) {
  const active = taskFacets(assignees).filter((facet) => Boolean(filters[facet.id]));
  if (active.length === 0) return null;

  return (
    <div className="filter-chips">
      {active.map((facet) => (
        <span className="filter-chip" key={facet.id}>
          <FilterMenu
            label={chipLabel(facet, filters[facet.id])}
            onChange={(value) => onChange({ [facet.id]: value } as Partial<TaskFilterState>)}
            options={facet.options}
            single={facet.single ?? false}
            value={filters[facet.id]}
          />
          <button
            aria-label={`Remove ${facet.label.toLowerCase()} filter`}
            className="filter-chip-remove"
            onClick={() => onChange({ [facet.id]: undefined } as Partial<TaskFilterState>)}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </span>
      ))}
      {active.length > 1 ? (
        <button className="filter-clear" onClick={onClear} type="button">
          Clear all
        </button>
      ) : null}
    </div>
  );
}

/** The single header control that adds a filter, with values one level in. */
export function AddFilterMenu({
  assignees,
  filters,
  onChange,
}: {
  assignees: Assignee[];
  filters: TaskFilterState;
  onChange: (patch: Partial<TaskFilterState>) => void;
}) {
  const available = taskFacets(assignees).filter((facet) => !filters[facet.id]);
  if (available.length === 0) return null;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="tasks-filter-button">
        <ListFilter aria-hidden="true" />
        Filter
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className="menu" sideOffset={4}>
          {available.map((facet) => (
            <DropdownMenu.Sub key={facet.id}>
              <DropdownMenu.SubTrigger className="menu-item">
                <span className="menu-item-label">{facet.label}</span>
                <ChevronRight className="menu-item-check" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent className="menu" sideOffset={2}>
                  {facet.options.map((option) => (
                    <DropdownMenu.Item
                      className="menu-item"
                      key={option.value}
                      onSelect={() =>
                        onChange({ [facet.id]: option.value } as Partial<TaskFilterState>)
                      }
                    >
                      {option.icon ? <span className="menu-item-icon">{option.icon}</span> : null}
                      <span className="menu-item-label">{option.label}</span>
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
