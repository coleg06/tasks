import type { Hono } from 'hono';
import { tenantProfile } from '../../shared/tenant-profile';
import { readEmailDeliverySettings } from '../notifications/delivery';
import { emailDeliverySettingsSchema } from '../shared/schemas';
import { auditStatement, requireTasksSession, type TaskAppEnv } from '../tasks/api';

/** Platform administrators only, using fresh effective permissions via requireTasksSession. */
export function registerAdminEmailRoutes(app: Hono<TaskAppEnv>) {
  app.get('/api/admin/email-settings', async (c) => {
    const identity = await requireTasksSession(c, 'platform.admin');
    if (!identity) return c.json({ error: 'forbidden' }, 403);
    if (!tenantProfile.capabilities.emailNotifications)
      return c.json({ error: 'email_disabled' }, 403);
    return c.json({ settings: await readEmailDeliverySettings(c.env) });
  });
  app.patch('/api/admin/email-settings', async (c) => {
    const identity = await requireTasksSession(c, 'platform.admin');
    if (!identity) return c.json({ error: 'forbidden' }, 403);
    if (!tenantProfile.capabilities.emailNotifications)
      return c.json({ error: 'email_disabled' }, 403);
    const parsed = emailDeliverySettingsSchema.safeParse(await c.req.json());
    if (!parsed.success)
      return c.json({ error: 'invalid_email_settings', issues: parsed.error.issues }, 400);
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE email_delivery_settings SET per_minute = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = 1`).bind(
        parsed.data.perMinute,
      ),
      auditStatement(
        c,
        identity.auditUserId,
        'system',
        'email',
        'platform.email_settings_updated',
        { after: parsed.data },
      ),
    ]);
    return c.json({ settings: parsed.data });
  });
}
