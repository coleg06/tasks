import { describe, expect, it } from 'vitest';
import {
  accountPreferencesSchema,
  projectSettingsPatchSchema,
  taskAlertPreferencesPatchSchema,
  taskAlertPreferencesSchema,
  taskMutationSchema,
  taskPatchSchema,
} from '../src/shared/schemas';

describe('task property validation', () => {
  it('accepts the editable task property set', () => {
    const result = taskMutationSchema.safeParse({
      title: 'Replace lobby display',
      description: 'Coordinate the install.',
      status: 'in_progress',
      priority: 'high',
      effort: 'medium',
      assigneeEmail: 'admin@example.org',
      dueDate: '2026-09-01',
      projectKey: 'IT',
      taskTypes: ['project', 'hardware'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty updates and invalid property values', () => {
    expect(taskPatchSchema.safeParse({}).success).toBe(false);
    expect(taskPatchSchema.safeParse({ status: 'almost_done' }).success).toBe(false);
    expect(taskPatchSchema.safeParse({ dueDate: 'tomorrow' }).success).toBe(false);
  });

  it('accepts only the supported task creation preferences', () => {
    expect(accountPreferencesSchema.safeParse({ taskCreationMode: 'guided' }).success).toBe(true);
    expect(accountPreferencesSchema.safeParse({ taskCreationMode: 'quick' }).success).toBe(true);
    expect(
      accountPreferencesSchema.safeParse({
        taskCreationMode: 'guided',
        notificationEmails: {
          assignments: true,
          comments: false,
          mentions: true,
          deadlines: false,
        },
      }).success,
    ).toBe(true);
    expect(accountPreferencesSchema.safeParse({ taskCreationMode: 'advanced' }).success).toBe(
      false,
    );
    expect(
      accountPreferencesSchema.safeParse({
        taskCreationMode: 'guided',
        notificationEmails: { assignments: 'yes' },
      }).success,
    ).toBe(false);
  });

  it('validates every task alert channel independently', () => {
    const preferences = {
      assignments: { email: true, inApp: true, push: false },
      comments: { email: false, inApp: true, push: true },
      mentions: { email: true, inApp: true, push: true },
      deadlines: { email: true, inApp: false, push: false },
    };
    expect(taskAlertPreferencesSchema.safeParse(preferences).success).toBe(true);
    expect(
      taskAlertPreferencesSchema.safeParse({
        ...preferences,
        comments: { ...preferences.comments, push: 'yes' },
      }).success,
    ).toBe(false);
    expect(
      taskAlertPreferencesPatchSchema.safeParse({ assignments: { inApp: true } }).success,
    ).toBe(true);
    expect(taskAlertPreferencesPatchSchema.safeParse({ assignments: {} }).success).toBe(false);
    expect(taskAlertPreferencesPatchSchema.safeParse({}).success).toBe(false);
  });
});

describe('project settings validation', () => {
  it('accepts editable project identity and access fields', () => {
    expect(
      projectSettingsPatchSchema.parse({
        name: 'Communications',
        description: 'Promotion and publication work.',
        visibility: 'private',
      }),
    ).toEqual({
      name: 'Communications',
      description: 'Promotion and publication work.',
      visibility: 'private',
    });
  });

  it('rejects empty settings updates and blank names', () => {
    expect(projectSettingsPatchSchema.safeParse({}).success).toBe(false);
    expect(projectSettingsPatchSchema.safeParse({ name: '  ' }).success).toBe(false);
  });
});
