import type { ScheduledJob } from './ports';

/** Five-field cron (minute hour day-of-month month day-of-week), UTC. Supports `*`, `a`, `a-b`, lists and `/step`. */
interface CronField {
  readonly values: ReadonlySet<number>;
  readonly wildcard: boolean;
}

const RANGES = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
] as const;

function parseField(source: string, [min, max]: readonly [number, number]): CronField {
  const values = new Set<number>();
  for (const part of source.split(',')) {
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined || !range) throw new Error(`Invalid cron field: ${source}`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid cron step: ${source}`);
    let from = min;
    let to = max;
    if (range !== '*') {
      const [startText, endText, more] = range.split('-');
      if (more !== undefined) throw new Error(`Invalid cron range: ${source}`);
      from = Number(startText);
      to = endText === undefined ? (stepText === undefined ? from : max) : Number(endText);
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < min || to > max || from > to) {
      throw new Error(`Cron value out of range: ${source}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return { values, wildcard: source === '*' };
}

export function parseCron(expression: string) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have five fields: ${expression}`);
  const parsed = fields.map((field, index) => parseField(field, RANGES[index] as [number, number]));
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [
    CronField,
    CronField,
    CronField,
    CronField,
    CronField,
  ];
  return (date: Date) => {
    if (!minute.values.has(date.getUTCMinutes()) || !hour.values.has(date.getUTCHours())) {
      return false;
    }
    if (!month.values.has(date.getUTCMonth() + 1)) return false;
    const weekday = date.getUTCDay();
    const dowMatch = dayOfWeek.values.has(weekday) || (weekday === 0 && dayOfWeek.values.has(7));
    const domMatch = dayOfMonth.values.has(date.getUTCDate());
    // Standard cron: when both day fields are restricted, either may match.
    if (!dayOfMonth.wildcard && !dayOfWeek.wildcard) return domMatch || dowMatch;
    return domMatch && dowMatch;
  };
}

export interface SchedulerOptions<Environment> {
  jobs: readonly ScheduledJob<Environment>[];
  env: Environment;
  /** Runs one job with shared logging; must reject on failure so the scheduler can log it. */
  run: (env: Environment, job: ScheduledJob<Environment>, scheduledTime: number) => Promise<void>;
  /** Called with every job failure; the default is `console.error` JSON. */
  onFailure?: (job: ScheduledJob<Environment>, error: unknown) => void | Promise<void>;
  now?: () => number;
}

/**
 * In-process scheduler for self-hosted deployments. It evaluates the shared job table once per
 * UTC minute. A job that is still running when its next tick arrives is skipped (never run
 * concurrently with itself). Ticks missed while the process is down are not replayed.
 */
export class Scheduler<Environment> {
  private readonly entries: { job: ScheduledJob<Environment>; matches: (date: Date) => boolean }[];
  private readonly running = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = true;
  private readonly now: () => number;

  constructor(private readonly options: SchedulerOptions<Environment>) {
    this.entries = options.jobs.map((job) => ({ job, matches: parseCron(job.cron) }));
    this.now = options.now ?? Date.now;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.arm();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.running.values()]);
  }

  private arm() {
    const now = this.now();
    const delay = 60_000 - (now % 60_000) + 50;
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      this.tick(this.now());
      this.arm();
    }, delay);
    this.timer.unref?.();
  }

  /** Evaluate one minute. Exposed for tests; returns the promises of the jobs it started. */
  tick(time: number): Promise<void>[] {
    const minute = Math.floor(time / 60_000) * 60_000;
    const date = new Date(minute);
    const started: Promise<void>[] = [];
    for (const { job, matches } of this.entries) {
      if (!matches(date)) continue;
      if (this.running.has(job.name)) {
        console.warn(
          JSON.stringify({ type: 'scheduled_job', name: job.name, status: 'skipped_overlap' }),
        );
        continue;
      }
      const promise = this.options
        .run(this.options.env, job, minute)
        .catch((error) => this.fail(job, error))
        .finally(() => this.running.delete(job.name));
      this.running.set(job.name, promise);
      started.push(promise);
    }
    return started;
  }

  private async fail(job: ScheduledJob<Environment>, error: unknown) {
    try {
      // runScheduledJob has already recorded the failure through logApplicationError.
      await this.options.onFailure?.(job, error);
    } catch {
      // A failing failure hook must never stop the scheduler.
    }
  }
}
