import { describe, expect, it, vi } from 'vitest';
import { scheduledJobs } from '../../src/platform/jobs';
import type { ScheduledJob } from '../../src/platform/ports';
import { parseCron, Scheduler } from '../../src/platform/scheduler';

const at = (iso: string) => new Date(iso);

describe('cron parsing', () => {
  it('matches the production expressions in UTC', () => {
    const daily = parseCron('0 13 * * *');
    expect(daily(at('2026-11-02T13:00:00Z'))).toBe(true);
    expect(daily(at('2026-11-02T13:01:00Z'))).toBe(false);
    expect(daily(at('2026-11-02T12:00:00Z'))).toBe(false);
    const every5 = parseCron('*/5 * * * *');
    expect(every5(at('2026-11-02T10:05:00Z'))).toBe(true);
    expect(every5(at('2026-11-02T10:07:00Z'))).toBe(false);
    expect(every5(at('2026-11-02T10:00:00Z'))).toBe(true);
  });

  it('supports lists, ranges, steps and weekday fields; rejects garbage', () => {
    expect(parseCron('0,30 9-17 * * 1-5')(at('2026-11-02T09:30:00Z'))).toBe(true); // Monday
    expect(parseCron('0,30 9-17 * * 1-5')(at('2026-11-01T09:30:00Z'))).toBe(false); // Sunday
    expect(parseCron('0 0 * * 7')(at('2026-11-01T00:00:00Z'))).toBe(true); // 7 == Sunday
    expect(parseCron('10-20/5 * * * *')(at('2026-11-02T00:15:00Z'))).toBe(true);
    for (const bad of ['* * * *', '61 * * * *', '*/0 * * * *', 'a * * * *', '5-1 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });

  it('every job in the shared table is a valid cron expression', () => {
    for (const job of scheduledJobs.jobs) expect(() => parseCron(job.cron), job.name).not.toThrow();
    expect(scheduledJobs.forCron('0 13 * * *').map((job) => job.name)).toEqual([
      'deadline_notifications',
      'operational_log_retention',
    ]);
    expect(scheduledJobs.forCron('*/5 * * * *').map((job) => job.name)).toEqual([
      'portal_alert_retry',
    ]);
  });
});

describe('Scheduler', () => {
  function job(name: string, cron: string, run: () => Promise<unknown>): ScheduledJob<object> {
    return { name, cron, run };
  }

  it('runs matching jobs once per tick and never overlaps a running job', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(() => gate);
    const fast = vi.fn(async () => 'ok');
    const runner = vi.fn(async (env: object, entry: ScheduledJob<object>) => {
      await entry.run(env);
    });
    const scheduler = new Scheduler<object>({
      jobs: [job('slow', '* * * * *', slow), job('fast', '*/2 * * * *', fast)],
      env: {},
      run: runner,
    });
    const minute = Date.parse('2026-11-02T10:00:00Z');
    const first = scheduler.tick(minute);
    expect(first).toHaveLength(2);
    const second = scheduler.tick(minute + 60_000); // slow still running -> skipped
    expect(second).toHaveLength(0);
    release();
    await Promise.all(first);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(fast).toHaveBeenCalledTimes(1);
    const third = scheduler.tick(minute + 120_000);
    await Promise.all(third);
    expect(slow).toHaveBeenCalledTimes(2);
    expect(fast).toHaveBeenCalledTimes(2);
  });

  it('survives failures and reports them through the failure hook', async () => {
    const failures: string[] = [];
    const scheduler = new Scheduler<object>({
      jobs: [job('boom', '* * * * *', async () => undefined)],
      env: {},
      run: async () => {
        throw new Error('exploded');
      },
      onFailure: (entry, error) => {
        failures.push(`${entry.name}:${(error as Error).message}`);
      },
    });
    await Promise.all(scheduler.tick(Date.parse('2026-11-02T10:00:00Z')));
    await Promise.all(scheduler.tick(Date.parse('2026-11-02T10:01:00Z')));
    expect(failures).toEqual(['boom:exploded', 'boom:exploded']);
  });

  it('timer aligns to the next minute and stop() waits for running jobs', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse('2026-11-02T09:59:30Z'));
      const ran: number[] = [];
      const scheduler = new Scheduler<object>({
        jobs: [job('daily', '0 10 * * *', async () => undefined)],
        env: {},
        run: async (_env, _entry, time) => {
          ran.push(time);
        },
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(29_000);
      expect(ran).toEqual([]);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ran).toEqual([Date.parse('2026-11-02T10:00:00Z')]);
      await scheduler.stop();
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(ran).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
