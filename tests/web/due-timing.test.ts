import { describe, expect, it } from 'vitest';
import { dueTiming } from '../../web/src/events/due-timing';

const august = new Date('2026-08-19T12:00:00Z');

describe('event task due timing', () => {
  it('separates future readiness requirements from current urgency', () => {
    expect(dueTiming('2026-11-01', august)).toBe('Upcoming');
    expect(dueTiming('2026-09-02', august)).toBe('Due in 2 weeks');
    expect(dueTiming('2026-08-24', august)).toBe('Due in 5 days');
  });

  it('identifies work that is due now or overdue', () => {
    expect(dueTiming('2026-08-19', august)).toBe('Due today');
    expect(dueTiming('2026-08-18', august)).toBe('Overdue');
    expect(dueTiming(null, august)).toBe('No due date');
  });
});
