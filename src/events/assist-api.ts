import type { Context } from 'hono';
import { tenantExtensions } from '../../shared/tenant-profile-support';
import type { Env } from '../env';
import { auditStatement, requireTasksSession, type TaskAppEnv } from '../tasks/api';
import {
  type EventAssistDraft,
  eventAssistModelResultSchema,
  eventAssistRequestSchema,
  eventAssistSystemPrompt,
  guidedAnswerPatch,
  mergeEventAssistDraft,
  missingEventAssistFields,
  nextEventAssistQuestion,
  redactEventAssistText,
} from './ai-intake';

type AppContext = Context<TaskAppEnv>;

export function parseLiteLlmResponse(value: unknown): EventAssistDraft | null {
  const response =
    value && typeof value === 'object' && 'choices' in value
      ? (value as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message
          ?.content
      : null;
  try {
    const payload = typeof response === 'string' ? JSON.parse(response) : response;
    const parsed = eventAssistModelResultSchema.safeParse(payload);
    return parsed.success ? parsed.data.patch : null;
  } catch {
    return null;
  }
}

export function liteLlmConfig(env: Env) {
  const endpoint = env.EVENT_AI_ENDPOINT?.trim() ?? '';
  const apiKey = env.EVENT_AI_API_KEY?.trim() ?? '';
  const model = env.EVENT_AI_MODEL?.trim() ?? '';
  try {
    const url = new URL(endpoint);
    if (
      url.protocol !== 'https:' ||
      !(tenantExtensions().integrations?.eventAssist?.allowedHosts ?? []).includes(url.hostname)
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return apiKey && model ? { endpoint, apiKey, model } : null;
}

async function anonymousUserId(email: string) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(email.toLowerCase()),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function assistEventIntake(context: AppContext) {
  const identity = await requireTasksSession(context, 'events.create');
  if (!identity) return context.json({ error: 'forbidden' }, 403);
  const parsed = eventAssistRequestSchema.safeParse(await context.req.json());
  if (!parsed.success) {
    return context.json({ error: 'invalid_event_assist', issues: parsed.error.issues }, 400);
  }
  const totalCharacters = parsed.data.messages.reduce(
    (sum, message) => sum + message.content.length,
    0,
  );
  if (totalCharacters > 12_000) return context.json({ error: 'event_assist_too_large' }, 413);

  const messages = parsed.data.messages.map((message) => ({
    role: message.role,
    content: redactEventAssistText(message.content),
  }));
  const latestAnswer =
    [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';
  let patch = guidedAnswerPatch(parsed.data.draft, latestAnswer);
  let source: 'litellm' | 'guided_fallback' = 'guided_fallback';
  let notice = 'Guided questions are active; AI extraction was unavailable for this response.';

  const config = liteLlmConfig(context.env);
  if (config) {
    try {
      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-LiteLLM-No-Log': 'true',
        },
        body: JSON.stringify({
          model: config.model,
          messages: [
            {
              role: 'system',
              content: eventAssistSystemPrompt(new Date().toISOString().slice(0, 10)),
            },
            {
              role: 'user',
              content: `CURRENT_DRAFT\n${JSON.stringify(parsed.data.draft)}\n\nCONVERSATION\n${JSON.stringify(messages)}`,
            },
          ],
          response_format: { type: 'json_object' },
          max_completion_tokens: 600,
          reasoning_effort: 'none',
          temperature: 0,
          store: false,
          user: await anonymousUserId(identity.user.email),
        }),
        signal: AbortSignal.timeout(12_000),
      });
      const body = await response.text();
      const result = response.ok && body.length <= 50_000 ? JSON.parse(body) : null;
      const modelPatch = parseLiteLlmResponse(result);
      if (modelPatch) {
        patch = modelPatch;
        source = 'litellm';
        notice =
          'AI extracted only the facts it could identify; review every field before creating the plan.';
      }
    } catch {
      // The deterministic one-question flow remains available if inference is unavailable.
    }
  }

  const draft = mergeEventAssistDraft(parsed.data.draft, patch);
  const missing = missingEventAssistFields(draft);
  const next = nextEventAssistQuestion(draft);
  const requestId = crypto.randomUUID();
  await auditStatement(
    context,
    identity.auditUserId,
    'system',
    `event-assist:${requestId}`,
    'event.assistance_requested',
    {
      source,
      provider: source === 'litellm' ? new URL(config?.endpoint ?? '').hostname : null,
      model: source === 'litellm' ? config?.model : null,
      filledFields: Object.keys(patch),
      missingFields: missing,
      messageCount: messages.length,
    },
  ).run();

  return context.json({
    requestId,
    source,
    notice,
    patch,
    draft,
    missing,
    ready: missing.length === 0,
    question: next?.question ?? 'The required event facts are filled in. Review the form below.',
  });
}
