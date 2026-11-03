import { describe, expect, it } from 'vitest';
import { eventArchiveVisibilityClause } from '../src/events/filters';

describe('event list archive visibility', () => {
  it('includes active and archived events when All stages is selected', () => {
    expect(eventArchiveVisibilityClause('')).toBeNull();
  });

  it('selects the matching archive partition for a specific stage', () => {
    expect(eventArchiveVisibilityClause('archived')).toBe('e.archived_at IS NOT NULL');
    expect(eventArchiveVisibilityClause('planning')).toBe('e.archived_at IS NULL');
  });
});
