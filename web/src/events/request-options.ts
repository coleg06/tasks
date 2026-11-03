import { tenantProfile } from '../../../shared/tenant-profile';
import { tenantEventVocabulary } from '../../../shared/tenant-profile-support';
import type { EventChannel, EventOperation } from '../api/types';

export const creativeOptions: Array<{
  channel: EventChannel;
  label: string;
  description: string;
}> = [
  {
    channel: 'calendar',
    label: 'Calendar listing',
    description: 'Event information and an image for the calendar.',
  },
  {
    channel: 'website',
    label: 'Website event listing',
    description: 'Event information and an image for the website.',
  },
  {
    channel: 'screens',
    label: `${tenantEventVocabulary().screenName} slide`,
    description: '16:9 announcement slide that can run in the scrolling announcements.',
  },
  {
    channel: 'media',
    label: 'Event Photography',
    description: 'Photography coverage during the event.',
  },
  {
    channel: 'social',
    label: 'Social images',
    description: 'Square and story graphics with approved copy.',
  },
  {
    channel: 'print',
    label: 'Printed handout',
    description: 'A specific handout with quantity and delivery details.',
  },
  {
    channel: 'physical',
    label: 'Sign or physical display',
    description: 'A sign, banner, or other on-site display.',
  },
];

export const coordinationOptions: Array<{
  operation: EventOperation;
  label: string;
  description: string;
}> = [
  {
    operation: 'facilities',
    label: 'Rooms, setup, or building resources',
    description: 'Reserve spaces and coordinate setup or teardown.',
  },
  {
    operation: 'production',
    label: 'Technology or production',
    description: 'Sound, lighting, projection, recording, or equipment.',
  },
  {
    operation: 'transportation',
    label: 'Transportation or trailers',
    description: `Transportation planning or a ${tenantProfile.organizationName} trailer.`,
  },
  {
    operation: 'food',
    label: 'Food or hospitality',
    description: 'Food service, hospitality, or kitchen coordination.',
  },
  {
    operation: 'volunteers',
    label: 'Volunteer coordination',
    description: 'Volunteer roles, scheduling, or communication.',
  },
];
