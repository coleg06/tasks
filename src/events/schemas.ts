import { z } from 'zod';
import { tenantEventVocabulary } from '../../shared/tenant-profile-support';
import { responsibilityAreas } from './responsibilities';

export const eventTemplateKeySchema = z.enum(['announcement', 'standard', 'major', 'recurring']);
export const eventChannelSchema = z.enum([
  'calendar',
  'website',
  'program',
  'screens',
  'social',
  'print',
  'physical',
  'qr',
  'media',
]);
export const eventLanguageSchema = z.enum(['en', 'es']);
export const communicationPrioritySchema = z.enum(['level_1', 'level_2', 'level_3', 'level_4']);
export const eventOperationSchema = z.enum([
  'production',
  'facilities',
  'transportation',
  'food',
  'vendors',
  'volunteers',
  'media',
]);

const eventCostSchema = z
  .union([z.number(), z.string(), z.null()])
  .transform((value, context) => {
    if (value === null) return null;
    if (typeof value === 'number') return value;
    const normalized = value.trim().replace(/^\$/, '');
    if (!normalized) return null;
    if (/^free$/i.test(normalized)) return 0;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      context.addIssue({ code: 'custom', message: 'Cost must be a dollar amount.' });
      return z.NEVER;
    }
    return parsed;
  })
  .pipe(z.number().min(0).max(1_000_000).nullable());
export const eventStageSchema = z.enum([
  'draft',
  'needs_information',
  'planning',
  'producing',
  'approval',
  'scheduled',
  'event_ready',
  'post_event',
  'archived',
]);
export const eventReadinessSchema = z.enum(['blocked', 'at_risk', 'ready']);
export const deliverableStatusSchema = z.enum([
  'not_requested',
  'waiting_on_facts',
  'drafting',
  'proofing',
  'design_in_progress',
  'review_requested',
  'changes_requested',
  'approved',
  'scheduled',
  'published',
  'retired',
]);
export const workItemStatusSchema = z.enum([
  'not_started',
  'in_progress',
  'blocked',
  'done',
  'not_needed',
]);
export const eventWorkItemPhaseSchema = z.enum([
  'intake',
  'administration',
  'copy',
  'translation',
  'design',
  'publishing',
  'operations',
  'post_event',
]);
export const eventWorkItemPatchSchema = z
  .object({
    status: workItemStatusSchema.optional(),
    ownerEmail: z.string().email().max(320).nullable().optional(),
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().trim().max(2000).optional(),
    dueDate: z.iso.date().nullable().optional(),
    phase: eventWorkItemPhaseSchema.optional(),
    critical: z.boolean().optional(),
    responsibilityKey: z.string().min(1).max(80).nullable().optional(),
  })
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: 'At least one task change is required.',
  });

export const eventWorkItemCreateSchema = z.object({
  title: z.string().trim().min(1).max(240),
  description: z.string().trim().max(2000).default(''),
  ownerEmail: z.string().email().max(320).nullable().default(null),
  dueDate: z.iso.date().nullable().default(null),
  phase: eventWorkItemPhaseSchema.default('administration'),
  status: workItemStatusSchema.default('not_started'),
  critical: z.boolean().default(false),
  responsibilityKey: z.string().min(1).max(80).nullable().default(null),
});

// Stored links are rendered as hyperlinks and handed to other clients, so only web addresses are
// accepted; a `javascript:` or `data:` URL is rejected at the API.
const httpUrl = z.url({ protocol: /^https?$/ }).max(2000);

const optionalUrl = z
  .union([httpUrl, z.literal('')])
  .transform((value) => value || null)
  .nullable();

const optionalDate = z.iso.date().nullable();
const shortTextList = z.array(z.string().trim().min(1).max(120)).max(40);

export const eventSourceSchema = z
  .object({
    system: z.string().trim().min(1).max(60),
    id: z.string().trim().min(1).max(240),
    url: httpUrl.nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .nullable()
  .optional();

export const eventIntakeSchema = z
  .object({
    templateKey: eventTemplateKeySchema,
    requestApprovalConfirmed: z.boolean().default(false),
    title: z.string().trim().min(1).max(240),
    purpose: z.string().trim().min(1).max(2000),
    ministry: z.string().trim().min(1).max(120),
    communicationPriority: communicationPrioritySchema.nullable().default(null),
    ownerEmail: z.string().email().max(320).nullable(),
    campuses: z.array(z.string().trim().min(1).max(80)).min(1).max(12),
    audience: z.string().trim().min(1).max(500),
    startDate: z.iso.date(),
    endDate: optionalDate.default(null),
    startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    endTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable(),
    timezone: z.string().trim().min(1).max(80).default(tenantEventVocabulary().defaultTimezone),
    location: z.string().trim().min(1).max(500),
    registration: z.object({
      required: z.boolean(),
      url: optionalUrl,
      openDate: z.iso.date().nullable(),
      closeDate: z.iso.date().nullable(),
      cost: eventCostSchema,
      capacity: z.number().int().positive().max(1_000_000).nullable(),
      accountCode: z.string().trim().max(120).default(''),
      scholarshipAvailable: z.boolean().default(false),
      scholarshipDetails: z.string().trim().max(2000).default(''),
      formFields: shortTextList.default([]),
      additionalQuestions: z.string().trim().max(4000).default(''),
    }),
    channels: z.array(eventChannelSchema).max(9),
    languages: z.array(eventLanguageSchema).min(1).max(2),
    operations: z.array(eventOperationSchema).max(7),
    recurrence: z.object({
      kind: z.enum(['none', 'weekly', 'monthly', 'annual']),
      notes: z.string().trim().max(500),
    }),
    priorEvent: z
      .object({
        heldBefore: z.boolean(),
        sameAsPrevious: z.boolean().nullable(),
        previousName: z.string().trim().max(240),
      })
      .default({ heldBefore: false, sameAsPrevious: null, previousName: '' }),
    communicationBrief: z.string().trim().max(5000).default(''),
    creativeBrief: z
      .object({
        designDirection: z.string().trim().max(4000),
        productionDetails: z.string().trim().max(4000),
        quantity: z.number().int().nonnegative().max(1_000_000).nullable(),
        otherDeliverables: z.string().trim().max(2000),
      })
      .default({
        designDirection: '',
        productionDetails: '',
        quantity: null,
        otherDeliverables: '',
      }),
    resourceRequests: z
      .object({
        rooms: shortTextList,
        transportation: shortTextList,
        technology: shortTextList,
        building: shortTextList,
        notes: z.string().trim().max(4000),
      })
      .default({ rooms: [], transportation: [], technology: [], building: [], notes: '' }),
    notes: z.string().trim().max(5000),
    source: eventSourceSchema,
  })
  .superRefine((value, context) => {
    if (!value.languages.includes('en')) {
      context.addIssue({
        code: 'custom',
        path: ['languages'],
        message: 'English must remain the source language.',
      });
    }
    if (value.endDate && value.endDate < value.startDate) {
      context.addIssue({
        code: 'custom',
        path: ['endDate'],
        message: 'End date must be on or after the start date.',
      });
    }
    if (
      (!value.endDate || value.endDate === value.startDate) &&
      value.endTime &&
      value.endTime <= value.startTime
    ) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'End time must be after start time for a same-day event.',
      });
    }
  });

export const workflowDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  leadSundays: z.number().int().min(1).max(20),
  defaultChannels: z.array(eventChannelSchema),
  defaultOperations: z.array(eventOperationSchema),
});

export const eventFactsPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(240).optional(),
    requestApprovalConfirmed: z.boolean().optional(),
    purpose: z.string().trim().min(1).max(2000).optional(),
    ministry: z.string().trim().min(1).max(120).optional(),
    communicationPriority: communicationPrioritySchema.nullable().optional(),
    ownerEmail: z.string().email().max(320).nullable().optional(),
    campuses: z.array(z.string().trim().min(1).max(80)).min(1).max(12).optional(),
    audience: z.string().trim().min(1).max(500).optional(),
    startDate: z.iso.date().optional(),
    endDate: optionalDate.optional(),
    startTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .optional(),
    endTime: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
      .nullable()
      .optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    location: z.string().trim().min(1).max(500).optional(),
    registration: eventIntakeSchema.shape.registration.optional(),
    channels: eventIntakeSchema.shape.channels.optional(),
    languages: eventIntakeSchema.shape.languages.optional(),
    operations: eventIntakeSchema.shape.operations.optional(),
    priorEvent: eventIntakeSchema.shape.priorEvent.optional(),
    communicationBrief: eventIntakeSchema.shape.communicationBrief.optional(),
    creativeBrief: eventIntakeSchema.shape.creativeBrief.optional(),
    resourceRequests: eventIntakeSchema.shape.resourceRequests.optional(),
    notes: z.string().trim().max(5000).optional(),
    changeReason: z.string().trim().min(1).max(500),
    expectedVersion: z.number().int().positive(),
  })
  .refine(
    (value) => Object.keys(value).some((key) => !['changeReason', 'expectedVersion'].includes(key)),
    {
      message: 'At least one event fact must change.',
    },
  );

export const deliverablePatchSchema = z.object({
  status: deliverableStatusSchema,
});

export const eventStagePatchSchema = z.object({
  stage: eventStageSchema,
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
});

export const copyVersionMutationSchema = z.object({
  purpose: z.enum(['full_promo', 'slide', 'calendar', 'social', 'handout', 'website']),
  language: eventLanguageSchema,
  body: z.string().trim().min(1).max(20_000),
  authorType: z.enum(['human', 'ai_draft']).default('human'),
  sourceCopyVersionId: z.number().int().positive().nullable().optional(),
});

export const assetVersionMutationSchema = z.object({
  url: httpUrl,
  label: z.string().trim().max(240),
  storageProvider: z.string().trim().max(80).nullable(),
  providerFileId: z.string().trim().max(500).nullable(),
});

export const approvalMutationSchema = z.object({
  subjectType: z.enum(['copy', 'asset', 'deliverable', 'event']),
  subjectId: z.number().int().positive(),
  subjectVersion: z.number().int().positive(),
  scope: z.enum([
    'english_copy',
    'translation',
    'design',
    'publication',
    'event_facts',
    'event_ready',
  ]),
  decision: z.enum(['approved', 'changes_requested']),
  comment: z.string().trim().max(2000),
});

export type EventIntake = z.infer<typeof eventIntakeSchema>;
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const responsibilityCreateSchema = z.object({ area: z.enum(responsibilityAreas) });
export const responsibilityPatchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    expectedFactsVersion: z.number().int().positive(),
    ownerEmail: z.string().email().max(320).nullable().optional(),
    status: z
      .enum(['awaiting_acknowledgment', 'acknowledged', 'blocked', 'ready', 'not_needed'])
      .optional(),
    notes: z.string().trim().max(2000).optional(),
  })
  .refine((v) => v.ownerEmail !== undefined || v.status !== undefined || v.notes !== undefined, {
    message: 'At least one responsibility change is required.',
  });
