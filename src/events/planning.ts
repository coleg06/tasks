import { tenantEventVocabulary } from '../../shared/tenant-profile-support';
import { type ResponsibilityArea, requestedResponsibilityAreas } from './responsibilities';
import type { EventIntake, WorkflowDefinition } from './schemas';

export type PlannedDeliverable = {
  key: string;
  channel: EventIntake['channels'][number];
  title: string;
  assetType: string;
  campus: string;
  language: EventIntake['languages'][number];
  dueDate: string;
  critical: boolean;
};

export type PlannedWorkItem = {
  key: string;
  phase:
    | 'intake'
    | 'administration'
    | 'copy'
    | 'translation'
    | 'design'
    | 'publishing'
    | 'operations'
    | 'post_event';
  title: string;
  description?: string;
  dueDate: string;
  critical: boolean;
  dependsOn: string[];
};

export type EventPlan = {
  templateKey: EventIntake['templateKey'];
  leadSundays: number;
  promotionStartDate: string;
  lateRequest: boolean;
  warnings: string[];
  deliverables: PlannedDeliverable[];
  workItems: PlannedWorkItem[];
  responsibilities: ResponsibilityArea[];
};

type DeliverableDefinition = {
  suffix: string;
  title: string;
  assetType: string;
  languages: 'all' | 'source';
  dueOffset: number;
};

const channelDeliverables: Record<EventIntake['channels'][number], DeliverableDefinition[]> = {
  calendar: [
    {
      suffix: 'copy',
      title: 'Calendar / registration copy',
      assetType: 'calendar_copy',
      languages: 'all',
      dueOffset: -7,
    },
    {
      suffix: 'image',
      title: 'Calendar / registration image',
      assetType: 'calendar_image',
      languages: 'all',
      dueOffset: -3,
    },
  ],
  website: [
    {
      suffix: 'copy',
      title: 'Website event copy',
      assetType: 'website_copy',
      languages: 'all',
      dueOffset: -7,
    },
    {
      suffix: 'image',
      title: 'Website event image',
      assetType: 'website_image',
      languages: 'source',
      dueOffset: -3,
    },
  ],
  program: [
    {
      suffix: 'copy',
      title: `${tenantEventVocabulary().programLabel} copy`,
      assetType: 'program_copy',
      languages: 'all',
      dueOffset: -5,
    },
  ],
  screens: [
    {
      suffix: 'slide',
      title: `${tenantEventVocabulary().screenName} screen slide`,
      assetType: 'screen_slide',
      languages: 'all',
      dueOffset: -3,
    },
  ],
  social: [
    {
      suffix: 'copy',
      title: 'Social launch and reminder copy',
      assetType: 'social_copy',
      languages: 'all',
      dueOffset: -5,
    },
    {
      suffix: 'square',
      title: 'Social square',
      assetType: 'social_square',
      languages: 'all',
      dueOffset: -3,
    },
    {
      suffix: 'story',
      title: 'Social story',
      assetType: 'social_story',
      languages: 'all',
      dueOffset: -3,
    },
  ],
  print: [
    {
      suffix: 'handout',
      title: 'Printed handout',
      assetType: 'handout',
      languages: 'all',
      dueOffset: -10,
    },
  ],
  physical: [
    {
      suffix: 'display',
      title: 'Banner / physical display',
      assetType: 'physical_display',
      languages: 'all',
      dueOffset: -14,
    },
  ],
  qr: [
    {
      suffix: 'code',
      title: 'Verified response QR code',
      assetType: 'qr_code',
      languages: 'source',
      dueOffset: -7,
    },
  ],
  media: [
    {
      suffix: 'photography',
      title: 'Event photography',
      assetType: 'event_photography',
      languages: 'source',
      dueOffset: -14,
    },
  ],
};

const operationLabels: Record<EventIntake['operations'][number], string> = {
  production: 'Confirm production and technology plan',
  facilities: 'Confirm facilities, room setup, and teardown',
  transportation: 'Confirm transportation and trailer plan',
  food: 'Confirm food and hospitality plan',
  vendors: 'Confirm vendors, contracts, and delivery details',
  volunteers: 'Confirm volunteer roles and schedule',
  media: 'Confirm creative support and deliverables',
};

function describeRegistration(input: EventIntake) {
  if (!input.registration.required) return 'No public registration or response path requested.';
  return [
    input.registration.closeDate ? `Closes ${input.registration.closeDate}` : '',
    input.registration.cost !== null ? `Cost $${input.registration.cost}` : '',
    input.registration.accountCode ? `COA ${input.registration.accountCode}` : '',
    input.registration.formFields.length
      ? `Fields: ${input.registration.formFields.join(', ')}`
      : '',
    input.registration.scholarshipAvailable
      ? `Scholarship: ${input.registration.scholarshipDetails || 'process needed'}`
      : '',
    input.registration.additionalQuestions,
  ]
    .filter(Boolean)
    .join(' · ');
}

function describeOperation(input: EventIntake, operation: EventIntake['operations'][number]) {
  const resources =
    operation === 'facilities'
      ? [...input.resourceRequests.rooms, ...input.resourceRequests.building]
      : operation === 'production'
        ? input.resourceRequests.technology
        : operation === 'transportation'
          ? input.resourceRequests.transportation
          : [];
  return [
    resources.length ? `Requested: ${resources.join(', ')}` : '',
    input.resourceRequests.notes,
  ]
    .filter(Boolean)
    .join(' · ');
}

function describeCreativeWork(input: EventIntake) {
  return [
    input.creativeBrief.designDirection,
    input.creativeBrief.productionDetails,
    input.creativeBrief.quantity !== null ? `Quantity: ${input.creativeBrief.quantity}` : '',
    input.creativeBrief.otherDeliverables,
  ]
    .filter(Boolean)
    .join(' · ');
}

function dateAtNoon(date: string) {
  return new Date(`${date}T12:00:00Z`);
}

export function addDays(date: string, days: number) {
  const value = dateAtNoon(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function promotionSunday(eventDate: string, leadSundays: number) {
  const value = dateAtNoon(eventDate);
  value.setUTCDate(value.getUTCDate() - value.getUTCDay() - leadSundays * 7);
  return value.toISOString().slice(0, 10);
}

function copyWorkItems(input: EventIntake, promotionStartDate: string): PlannedWorkItem[] {
  const items: PlannedWorkItem[] = [
    {
      key: 'facts',
      phase: 'intake',
      title: 'Confirm event details',
      description: `${input.title} · ${input.startDate} at ${input.startTime} · ${input.location} · ${input.purpose}`,
      dueDate: addDays(promotionStartDate, -14),
      critical: true,
      dependsOn: [],
    },
    {
      key: 'registration',
      phase: 'administration',
      title: input.registration.required
        ? 'Create and verify registration response path'
        : 'Confirm that no registration is required',
      description: describeRegistration(input),
      dueDate: addDays(promotionStartDate, -12),
      critical: true,
      dependsOn: ['facts'],
    },
    {
      key: 'copy-en',
      phase: 'copy',
      title: 'Write source promotional copy',
      dueDate: addDays(promotionStartDate, -10),
      critical: true,
      dependsOn: ['facts', 'registration'],
    },
    {
      key: 'proof-en',
      phase: 'copy',
      title: 'Proof and approve English copy',
      dueDate: addDays(promotionStartDate, -7),
      critical: true,
      dependsOn: ['copy-en'],
    },
  ];

  if (input.languages.includes('es')) {
    items.push(
      {
        key: 'translate-es',
        phase: 'translation',
        title: `Translate approved copy into ${tenantEventVocabulary().secondLanguageName}`,
        dueDate: addDays(promotionStartDate, -5),
        critical: true,
        dependsOn: ['proof-en'],
      },
      {
        key: 'proof-es',
        phase: 'translation',
        title: `Human-proof and approve ${tenantEventVocabulary().secondLanguageName} translation`,
        dueDate: addDays(promotionStartDate, -3),
        critical: true,
        dependsOn: ['translate-es'],
      },
    );
  }
  return items;
}

export function buildEventPlan(
  input: EventIntake,
  definition: WorkflowDefinition,
  today = new Date().toISOString().slice(0, 10),
  workflowMode: 'legacy' | 'responsibilities' = 'responsibilities',
): EventPlan {
  const promotionStartDate = promotionSunday(input.startDate, definition.leadSundays);
  const warnings: string[] = [];
  const lateRequest = promotionStartDate < today;
  if (lateRequest) {
    warnings.push(
      `The normal ${definition.leadSundays}-${tenantEventVocabulary().weekLabel} promotion window began ${promotionStartDate}. Communications should approve a reduced or accelerated plan.`,
    );
  }
  if (input.registration.required && !input.registration.url) {
    warnings.push('Registration is required but the public response URL is missing.');
  }
  if (
    input.registration.cost !== null &&
    input.registration.cost > 0 &&
    !input.registration.accountCode
  ) {
    warnings.push('A paid event needs a chart of accounts value before registration is published.');
  }
  if (input.languages.includes('es')) {
    warnings.push(
      `${tenantEventVocabulary().secondLanguageName} output remains blocked until a qualified person proofs the translation.`,
    );
  }

  const deliverables: PlannedDeliverable[] = [];
  for (const channel of input.channels) {
    for (const definitionItem of channelDeliverables[channel]) {
      const languages = definitionItem.languages === 'all' ? input.languages : (['en'] as const);
      for (const campus of input.campuses) {
        for (const language of languages) {
          const campusKey = campus.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          deliverables.push({
            key: `${channel}-${definitionItem.suffix}-${campusKey}-${language}`,
            channel,
            title: `${definitionItem.title} — ${campus}${language === 'es' ? ` / ${tenantEventVocabulary().secondLanguageName}` : ''}`,
            assetType: definitionItem.assetType,
            campus,
            language,
            dueDate: addDays(promotionStartDate, definitionItem.dueOffset),
            critical: true,
          });
        }
      }
    }
  }

  const workItems: PlannedWorkItem[] = [];
  if (workflowMode === 'legacy') {
    workItems.push(...copyWorkItems(input, promotionStartDate));
    for (const deliverable of deliverables) {
      const languageGate = deliverable.language === 'es' ? 'proof-es' : 'proof-en';
      const designKey = `produce-${deliverable.key}`;
      workItems.push(
        {
          key: designKey,
          phase: deliverable.assetType.endsWith('_copy') ? 'copy' : 'design',
          title: `Produce ${deliverable.title}`,
          description: deliverable.assetType.endsWith('_copy')
            ? input.communicationBrief
            : describeCreativeWork(input),
          dueDate: deliverable.dueDate,
          critical: deliverable.critical,
          dependsOn: [languageGate],
        },
        {
          key: `publish-${deliverable.key}`,
          phase: 'publishing',
          title: `Approve and publish ${deliverable.title}`,
          dueDate: promotionStartDate,
          critical: deliverable.critical,
          dependsOn: [designKey],
        },
      );
    }

    for (const operation of input.operations) {
      workItems.push({
        key: `operation-${operation}`,
        phase: 'operations',
        title: operationLabels[operation],
        description: describeOperation(input, operation),
        dueDate: addDays(input.startDate, -7),
        critical: true,
        dependsOn: ['facts'],
      });
    }

    workItems.push(
      {
        key: 'readiness',
        phase: 'operations',
        title: 'Complete final event readiness review',
        dueDate: addDays(input.startDate, -3),
        critical: true,
        dependsOn: workItems.filter((item) => item.critical).map((item) => item.key),
      },
      {
        key: 'retire',
        phase: 'post_event',
        title: 'Retire expired promotion and capture lessons learned',
        dueDate: addDays(input.startDate, 2),
        critical: false,
        dependsOn: ['readiness'],
      },
    );
  }

  return {
    responsibilities: requestedResponsibilityAreas(input),
    templateKey: input.templateKey,
    leadSundays: definition.leadSundays,
    promotionStartDate,
    lateRequest,
    warnings,
    deliverables,
    workItems,
  };
}
