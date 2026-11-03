import { describe, expect, it } from 'vitest';
import { tenantExtensions } from '../shared/tenant-profile-support';
import type { Env } from '../src/env';
import {
  eventAssistDraftSchema,
  guidedAnswerPatch,
  mergeEventAssistDraft,
  missingEventAssistFields,
  nextEventAssistQuestion,
  redactEventAssistText,
} from '../src/events/ai-intake';
import { liteLlmConfig, parseLiteLlmResponse } from '../src/events/assist-api';

describe('AI-guided event intake guardrails', () => {
  it('asks for one required fact at a time in a deterministic order', () => {
    expect(nextEventAssistQuestion({})).toEqual({
      field: 'title',
      question: 'What should staff call this event?',
    });
    expect(
      missingEventAssistFields({
        title: 'Annual Dinner',
        purpose: 'Help women build relationships and invite guests.',
      }),
    ).toEqual(['ministry', 'audience', 'startDate', 'startTime', 'location']);
  });

  it('merges only a validated model patch while preserving nested answers', () => {
    const draft = mergeEventAssistDraft(
      { title: 'Annual Dinner', registration: { required: true } },
      {
        ministry: 'Outreach',
        registration: { cost: 0 },
        channels: ['calendar', 'website'],
        languages: ['en'],
      },
    );

    expect(draft.registration).toEqual({ required: true, cost: 0 });
    expect(draft.channels).toEqual(['calendar', 'website']);
    expect(draft.languages).toEqual(['en']);
  });

  it('keeps a deterministic guided flow available if inference is unavailable', () => {
    expect(guidedAnswerPatch({}, 'Annual Dinner')).toEqual({ title: 'Annual Dinner' });
    expect(
      guidedAnswerPatch(
        {
          title: 'Annual Dinner',
          purpose: 'Build relationships',
          ministry: 'Outreach',
          audience: 'Women and their guests',
          startDate: '2026-12-04',
          startTime: '18:00',
        },
        'Fellowship Hall',
      ),
    ).toEqual({ location: 'Fellowship Hall' });
    expect(
      guidedAnswerPatch(
        {
          title: 'Annual Dinner',
          purpose: 'Build relationships',
          ministry: 'Outreach',
          audience: 'Women and their guests',
          startDate: '2026-12-04',
        },
        '6:30 PM',
      ),
    ).toEqual({ startTime: '18:30' });
  });

  it('rejects unsupported destinations and second-language-only model suggestions', () => {
    expect(eventAssistDraftSchema.safeParse({ campuses: ['Unknown'] }).success).toBe(false);
    expect(eventAssistDraftSchema.safeParse({ languages: ['es'] }).success).toBe(false);
  });

  it('redacts likely credentials before conversation text reaches a model', () => {
    expect(redactEventAssistText('api_key=super-secret-value')).toBe('api_key=[redacted]');
    expect(redactEventAssistText('Bearer abcdefghijklmnop')).toBe('Bearer [redacted]');
  });

  it('accepts only the configured model hosts and validates its response', () => {
    const hosts = tenantExtensions().integrations?.eventAssist?.allowedHosts ?? [];
    const environment = (host: string) =>
      ({
        EVENT_AI_ENDPOINT: `https://${host}/v1/chat/completions`,
        EVENT_AI_API_KEY: 'test-key',
        EVENT_AI_MODEL: 'test-model',
      }) as Env;
    for (const host of hosts) {
      expect(liteLlmConfig(environment(host))?.endpoint).toBe(
        `https://${host}/v1/chat/completions`,
      );
    }
    // No profile host (the neutral default) means no endpoint is ever accepted.
    expect(liteLlmConfig(environment('unlisted.example.com'))).toBeNull();
    expect(
      liteLlmConfig({
        ...environment(hosts[0] ?? 'unlisted.example.com'),
        EVENT_AI_ENDPOINT: 'http://insecure.example.com/v1/chat/completions',
      } as Env),
    ).toBeNull();
    expect(
      parseLiteLlmResponse({
        choices: [{ message: { content: '{"patch":{"title":"Annual Dinner"}}' } }],
      }),
    ).toEqual({ title: 'Annual Dinner' });
    expect(
      parseLiteLlmResponse({
        choices: [{ message: { content: '{"patch":{"campuses":["Nope"]}}' } }],
      }),
    ).toBeNull();
  });
});
