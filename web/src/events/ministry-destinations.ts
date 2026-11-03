import { tenantProfile } from '../../../shared/tenant-profile';
import {
  type EventVocabulary,
  tenantEventVocabulary,
} from '../../../shared/tenant-profile-support';

function normalize(value: string) {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase();
}

/** Destinations preselected for a ministry; unknown ministries keep the current selection. */
export function destinationsForMinistry(
  ministry: string,
  current: string[],
  vocabulary: EventVocabulary = tenantEventVocabulary(tenantProfile),
) {
  const mapped = vocabulary.destinationsByMinistry[normalize(ministry)];
  if (mapped) return [...mapped];
  return current.length ? current : [vocabulary.defaultDestination];
}
