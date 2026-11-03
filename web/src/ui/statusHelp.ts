import type { TaskStatus } from '../api/types';
import { statusLabels } from '../api/types';

export type StatusHelp = { label: string; description: string };

export const taskStatusHelp: Record<TaskStatus, StatusHelp> = {
  backlog: {
    label: statusLabels.backlog,
    description: 'Saved for later and not ready to start.',
  },
  not_started: {
    label: statusLabels.not_started,
    description: 'Ready, but work has not started.',
  },
  open: {
    label: statusLabels.open,
    description: 'Ready to be picked up or scheduled.',
  },
  in_progress: {
    label: statusLabels.in_progress,
    description: 'Work is actively underway.',
  },
  blocked: {
    label: statusLabels.blocked,
    description: 'Waiting on something before work can continue.',
  },
  review: {
    label: statusLabels.review,
    description: 'Work is complete and awaiting review.',
  },
  done: {
    label: statusLabels.done,
    description: 'Work is complete.',
  },
  cancelled: {
    label: statusLabels.cancelled,
    description: 'Work was intentionally closed without completion.',
  },
};
