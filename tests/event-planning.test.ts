import { describe, expect, it } from 'vitest';
import { validateAssetUpload } from '../src/events/api';
import { buildEventPlan as buildNewEventPlan, promotionSunday } from '../src/events/planning';
import type { EventIntake, WorkflowDefinition } from '../src/events/schemas';

const buildEventPlan = (input: EventIntake, definition: WorkflowDefinition, today?: string) =>
  buildNewEventPlan(input, definition, today, 'legacy');

import {
  eventFactsPatchSchema,
  eventIntakeSchema,
  eventWorkItemCreateSchema,
  eventWorkItemPatchSchema,
  workflowDefinitionSchema,
} from '../src/events/schemas';

const standardDefinition = workflowDefinitionSchema.parse({
  schemaVersion: 1,
  leadSundays: 5,
  defaultChannels: ['calendar', 'website', 'screens', 'social'],
  defaultOperations: [],
});

function intake(overrides: Record<string, unknown> = {}) {
  return eventIntakeSchema.parse({
    templateKey: 'standard',
    requestApprovalConfirmed: true,
    title: 'Spring picnic',
    purpose: 'Celebrate community stories and invite everyone to gather together.',
    ministry: 'All Sites',
    ownerEmail: 'admin@example.org',
    campuses: ['North'],
    audience: 'Community members and guests',
    startDate: '2026-10-18',
    startTime: '16:00',
    endTime: '19:00',
    timezone: 'UTC',
    location: 'North Hall',
    registration: {
      required: false,
      url: null,
      openDate: null,
      closeDate: null,
      cost: '',
      capacity: null,
    },
    channels: ['calendar', 'website', 'screens', 'social'],
    languages: ['en'],
    operations: [],
    recurrence: { kind: 'none', notes: '' },
    notes: '',
    ...overrides,
  });
}

describe('event workflow planning', () => {
  it('defaults to concrete deliverables and accountable areas without generated tasks', () => {
    const plan = buildNewEventPlan(
      intake({ channels: [], operations: ['facilities'] }),
      standardDefinition,
    );
    expect(plan.workItems).toEqual([]);
    expect(plan.deliverables).toEqual([]);
    expect(plan.responsibilities).toEqual(['facilities']);
  });
  it('records approval without blocking a request that still needs it', () => {
    expect(intake().requestApprovalConfirmed).toBe(true);
    expect(intake({ requestApprovalConfirmed: false }).requestApprovalConfirmed).toBe(false);
  });

  it('calculates a Sunday-based promotion window deterministically', () => {
    expect(promotionSunday('2026-10-18', 5)).toBe('2026-09-13');
    expect(promotionSunday('2026-10-21', 5)).toBe('2026-09-13');
  });

  it('generates channel deliverables without creating generic IT tasks', () => {
    const plan = buildEventPlan(intake(), standardDefinition, '2026-08-18');

    expect(plan.promotionStartDate).toBe('2026-09-13');
    expect(plan.lateRequest).toBe(false);
    expect(plan.deliverables).toHaveLength(8);
    expect(plan.deliverables.map((item) => item.assetType)).toEqual(
      expect.arrayContaining([
        'calendar_copy',
        'calendar_image',
        'website_copy',
        'website_image',
        'screen_slide',
        'social_copy',
        'social_square',
        'social_story',
      ]),
    );
    expect(plan.workItems.some((item) => item.title === 'Proof and approve English copy')).toBe(
      true,
    );
    expect(plan.workItems.at(-2)?.key).toBe('readiness');
  });

  it('creates separately gated second-language deliverables for every destination', () => {
    const plan = buildEventPlan(
      intake({
        campuses: ['North', 'South'],
        channels: ['screens'],
        languages: ['en', 'es'],
      }),
      standardDefinition,
      '2026-08-18',
    );

    expect(plan.deliverables).toHaveLength(4);
    expect(plan.deliverables.map((item) => `${item.campus}:${item.language}`)).toEqual([
      'North:en',
      'North:es',
      'South:en',
      'South:es',
    ]);
    expect(plan.workItems.find((item) => item.key === 'proof-es')?.dependsOn).toEqual([
      'translate-es',
    ]);
    expect(
      plan.workItems.find((item) => item.key.includes('screens-slide-north-es'))?.dependsOn,
    ).toEqual(['proof-es']);
  });

  it('plans event photography as a creative deliverable', () => {
    const plan = buildEventPlan(intake({ channels: ['calendar', 'media'] }), standardDefinition);

    expect(plan.deliverables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: 'media',
          title: 'Event photography — North',
          assetType: 'event_photography',
        }),
      ]),
    );
  });

  it('accepts an incomplete registration response path and exposes it as a warning', () => {
    const input = intake({
      registration: {
        required: true,
        url: null,
        openDate: null,
        closeDate: null,
        cost: 'Free',
        capacity: 100,
      },
    });
    const plan = buildEventPlan(input, standardDefinition, '2026-08-18');

    expect(plan.warnings).toContain(
      'Registration is required but the public response URL is missing.',
    );
    expect(input.registration.cost).toBe(0);
  });

  it('stores cost as non-negative dollars and permits a zero-dollar event', () => {
    const input = intake({
      communicationPriority: 'level_1',
      registration: {
        required: true,
        url: 'https://example.org/register',
        openDate: null,
        closeDate: null,
        cost: 0,
        capacity: null,
      },
    });

    expect(input.communicationPriority).toBe('level_1');
    expect(input.registration.cost).toBe(0);
    expect(() => intake({ registration: { ...input.registration, cost: -1 } })).toThrow(/>=0/);
  });

  it('accepts the blank cost value sent by the event intake form', () => {
    const input = intake({
      registration: {
        required: false,
        url: null,
        openDate: null,
        closeDate: null,
        cost: null,
        capacity: null,
      },
      channels: ['calendar', 'website'],
      languages: ['en'],
    });

    expect(input.registration.cost).toBeNull();
    expect(input.channels).toEqual(['calendar', 'website']);
    expect(input.languages).toEqual(['en']);
  });

  it('preserves conditional fields from the current ministry event request', () => {
    const input = intake({
      endDate: '2026-10-19',
      communicationBrief: 'Invite families to gather, eat, and celebrate.',
      priorEvent: {
        heldBefore: true,
        sameAsPrevious: false,
        previousName: 'Spring picnic 2025',
      },
      registration: {
        required: true,
        url: null,
        openDate: null,
        closeDate: '2026-10-12',
        cost: 25,
        capacity: 200,
        accountCode: 'MIN-4100',
        scholarshipAvailable: true,
        scholarshipDetails: 'Ask the ministry lead.',
        formFields: ['Liability waiver', 'T-shirt size'],
        additionalQuestions: 'Which serving team can you join?',
      },
      creativeBrief: {
        designDirection: 'Warm, celebratory, and people-focused.',
        productionDetails: 'Letter-size handout at the welcome desk.',
        quantity: 100,
        otherDeliverables: 'Directional sign',
      },
      resourceRequests: {
        rooms: ['Main Hall', 'Lobby'],
        transportation: ['Hospitality trailer'],
        technology: ['Live sound', 'Projection / slides'],
        building: ['Tables', 'Trash cans'],
        notes: 'Set tables in the lobby.',
      },
      operations: ['production', 'facilities', 'transportation'],
    });
    const plan = buildEventPlan(input, standardDefinition, '2026-08-18');

    expect(input.endDate).toBe('2026-10-19');
    expect(input.registration.accountCode).toBe('MIN-4100');
    expect(input.resourceRequests.rooms).toContain('Main Hall');
    expect(plan.workItems.find((item) => item.key === 'operation-transportation')).toMatchObject({
      description: 'Requested: Hospitality trailer · Set tables in the lobby.',
    });
    expect(plan.workItems.find((item) => item.key === 'registration')?.description).toContain(
      'COA MIN-4100',
    );
  });

  it('keeps incomplete paid-event accounting visible instead of rejecting the draft', () => {
    const input = intake({
      registration: {
        required: true,
        url: null,
        openDate: null,
        closeDate: null,
        cost: 25,
        capacity: null,
      },
    });
    const plan = buildEventPlan(input, standardDefinition, '2026-08-18');

    expect(plan.warnings).toContain(
      'A paid event needs a chart of accounts value before registration is published.',
    );
  });

  it('flags a late request without refusing to build a visible plan', () => {
    const plan = buildEventPlan(intake(), standardDefinition, '2026-10-01');

    expect(plan.lateRequest).toBe(true);
    expect(plan.warnings[0]).toContain('reduced or accelerated plan');
    expect(plan.deliverables.length).toBeGreaterThan(0);
  });

  it('rejects a second-language-only event because English remains the source language', () => {
    expect(() => intake({ languages: ['es'] })).toThrow(/English must remain the source language/);
  });

  it('validates editable event task details and assignment changes', () => {
    expect(
      eventWorkItemPatchSchema.parse({
        title: 'Confirm final event facts',
        description: 'Verify the date, time, location, cost, and registration link.',
        dueDate: '2026-10-01',
        phase: 'intake',
        ownerEmail: 'admin@example.org',
        status: 'in_progress',
        critical: true,
      }),
    ).toMatchObject({ title: 'Confirm final event facts', critical: true });
    expect(eventWorkItemPatchSchema.safeParse({ dueDate: 'not-a-date' }).success).toBe(false);
    expect(eventWorkItemPatchSchema.safeParse({}).success).toBe(false);
  });

  it('validates custom event tasks and supplies safe defaults', () => {
    expect(eventWorkItemCreateSchema.parse({ title: 'Confirm volunteer arrival time' })).toEqual({
      title: 'Confirm volunteer arrival time',
      responsibilityKey: null,
      description: '',
      ownerEmail: null,
      dueDate: null,
      phase: 'administration',
      status: 'not_started',
      critical: false,
    });
    expect(eventWorkItemCreateSchema.safeParse({ title: '  ' }).success).toBe(false);
    expect(
      eventWorkItemCreateSchema.safeParse({ title: 'Book room', phase: 'unknown' }).success,
    ).toBe(false);
  });

  it('accepts creative and coordination changes when event facts are edited', () => {
    expect(
      eventFactsPatchSchema.parse({
        channels: ['calendar', 'media'],
        operations: ['facilities'],
        changeReason: 'Photography and room setup were added.',
        expectedVersion: 2,
      }),
    ).toMatchObject({ channels: ['calendar', 'media'], operations: ['facilities'] });
  });

  it('accepts supported creative files and rejects unsafe or oversized uploads', () => {
    expect(validateAssetUpload({ size: 2_000_000, type: 'image/png' })).toBeNull();
    expect(validateAssetUpload({ size: 2_000_000, type: 'application/pdf' })).toBeNull();
    expect(validateAssetUpload({ size: 0, type: 'image/png' })).toBe('asset_empty');
    expect(validateAssetUpload({ size: 60 * 1024 * 1024, type: 'image/jpeg' })).toBe(
      'asset_too_large',
    );
    expect(validateAssetUpload({ size: 2_000, type: 'image/svg+xml' })).toBe('asset_invalid_type');
  });
});
