import { z } from 'zod';
import { tenantProfile } from '../../shared/tenant-profile';

export const healthSchema = z.object({
  environment: z.enum(['local', 'dev', 'production']),
  ok: z.literal(true),
  release: z.string().min(1).max(64),
  service: z.literal(tenantProfile.serviceName),
});

export type Health = z.infer<typeof healthSchema>;

export const taskStatusSchema = z.enum([
  'backlog',
  'not_started',
  'in_progress',
  'blocked',
  'done',
]);
export const taskPrioritySchema = z.enum(['high', 'medium', 'low']).nullable();
export const taskEffortSchema = z.enum(['small', 'medium', 'large']).nullable();
export const taskCreationModeSchema = z.enum(['guided', 'quick']);

export const taskAlertChannelSchema = z.object({
  email: z.boolean(),
  inApp: z.boolean(),
  push: z.boolean(),
});

export const taskAlertPreferencesSchema = z.object({
  assignments: taskAlertChannelSchema,
  comments: taskAlertChannelSchema,
  mentions: taskAlertChannelSchema,
  deadlines: taskAlertChannelSchema,
});

const taskAlertChannelPatchSchema = taskAlertChannelSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one channel is required.',
  });

export const taskAlertPreferencesPatchSchema = z
  .object({
    assignments: taskAlertChannelPatchSchema.optional(),
    comments: taskAlertChannelPatchSchema.optional(),
    mentions: taskAlertChannelPatchSchema.optional(),
    deadlines: taskAlertChannelPatchSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one event preference is required.',
  });

export type TaskAlertPreferences = z.infer<typeof taskAlertPreferencesSchema>;

export const accountPreferencesSchema = z.object({
  taskCreationMode: taskCreationModeSchema,
  notificationEmails: z
    .object({
      assignments: z.boolean(),
      comments: z.boolean(),
      mentions: z.boolean(),
      deadlines: z.boolean(),
    })
    .optional(),
  notificationAlerts: taskAlertPreferencesSchema.optional(),
});

export const taskMutationSchema = z.object({
  mutationKey: z.uuid().optional(),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(10_000),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  effort: taskEffortSchema,
  assigneeEmail: z.string().email().max(320).nullable(),
  dueDate: z.iso.date().nullable(),
  projectKey: z.string().min(1).max(40),
  taskTypes: z.array(z.string().trim().min(1).max(60)).max(20),
});

export const taskPatchSchema = taskMutationSchema
  .omit({ mutationKey: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one property is required.',
  });

export const projectSettingsPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    visibility: z.enum(['workspace', 'private']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one project setting is required.',
  });

export const taskSummarySchema = z.object({
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status: taskStatusSchema,
  priority: taskPrioritySchema,
  effort: taskEffortSchema,
  dueDate: z.string().nullable(),
  completedAt: z.string().nullable(),
  assignee: z.object({ name: z.string(), email: z.string().nullable() }).nullable(),
  taskTypes: z.array(z.string()),
  attachments: z.array(z.unknown()),
  project: z.object({
    key: z.string(),
    name: z.string(),
    workspace: z.object({ key: z.string(), name: z.string() }),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().positive(),
});

export type TaskSummary = z.infer<typeof taskSummarySchema>;
