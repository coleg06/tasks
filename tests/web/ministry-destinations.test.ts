import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVENT_VOCABULARY,
  type EventVocabulary,
} from '../../shared/tenant-profile-support';
import { destinationsForMinistry } from '../../web/src/events/ministry-destinations';

const vocabulary: EventVocabulary = {
  ...DEFAULT_EVENT_VOCABULARY,
  destinationsByMinistry: {
    operations: ['North'],
    outreach: ['Online'],
    cafe: ['Café'],
  },
  defaultDestination: 'North',
};

describe('event routing destinations', () => {
  it('infers known destinations without a separate destination picker', () => {
    expect(destinationsForMinistry('Operations', ['Online'], vocabulary)).toEqual(['North']);
    expect(destinationsForMinistry(' OUTREACH ', ['North'], vocabulary)).toEqual(['Online']);
    expect(destinationsForMinistry('Café', ['North'], vocabulary)).toEqual(['Café']);
  });

  it('preserves the current destination for a custom ministry', () => {
    expect(destinationsForMinistry('Community Outreach', ['North'], vocabulary)).toEqual(['North']);
  });

  it('falls back to the default destination when nothing is selected', () => {
    expect(destinationsForMinistry('Community Outreach', [], vocabulary)).toEqual(['North']);
    expect(destinationsForMinistry('Anything', [], DEFAULT_EVENT_VOCABULARY)).toEqual(['Main']);
  });
});
