import type { Hono } from 'hono';
import { tenantProfile } from '../../shared/tenant-profile';
import {
  emailDeliveryPreferenceStatements,
  readEmailDeliveryPreferences,
  readEmailDeliverySettings,
} from '../notifications/delivery';
import { emailDeliveryPreferencesSchema } from '../shared/schemas';
import { auditStatement, requireTasksSession, type TaskAppEnv } from '../tasks/api';

/** Register inside the application's existing authenticated API / CSRF middleware boundary. */
export function registerAccountEmailRoutes(app: Hono<TaskAppEnv>) {
  app.get('/api/account/email-preferences', async (c) => {
    const identity =
      (await requireTasksSession(c)) ?? (await requireTasksSession(c, 'events.view'));
    if (!identity) return c.json({ error: 'unauthorized' }, 401);
    if (!tenantProfile.capabilities.emailNotifications)
      return c.json({ error: 'email_disabled' }, 403);
    return c.json({
      preferences: await readEmailDeliveryPreferences(c.env, identity.user.id),
      settings: await readEmailDeliverySettings(c.env),
    });
  });
  app.patch('/api/account/email-preferences', async (c) => {
    const identity =
      (await requireTasksSession(c)) ?? (await requireTasksSession(c, 'events.view'));
    if (!identity) return c.json({ error: 'unauthorized' }, 401);
    if (!tenantProfile.capabilities.emailNotifications)
      return c.json({ error: 'email_disabled' }, 403);
    const parsed = emailDeliveryPreferencesSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: 'invalid_email_preferences', issues: parsed.error.issues }, 400);
    const before = await readEmailDeliveryPreferences(c.env, identity.user.id);
    await c.env.DB.batch([
      ...emailDeliveryPreferenceStatements(c.env, identity.user.id, parsed.data),
      auditStatement(
        c,
        identity.auditUserId,
        'user',
        String(identity.user.id),
        'user.email_preferences_updated',
        { before, after: parsed.data },
      ),
    ]);
    return c.json({ preferences: parsed.data });
  });
}
