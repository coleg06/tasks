import { resolveRuntimeFeatures } from '../../shared/runtime-features';
import { tenantProfile } from '../../shared/tenant-profile';
import type { Env } from '../env';
import type { SqlStatement } from '../platform/ports';
import { isInitialAdminEmail, mayCreateUserOnSignIn } from '../runtime/identity-config';

/**
 * Tenant membership and first-sign-in grants for a user whose identity was just established
 * (Google sign-in or a trusted upstream proxy). Idempotent. A user with no existing task
 * access gains none unless they are the configured initial administrator.
 */
export async function provisionSignedInUser(env: Env, user: { id: number; email: string }) {
  const existingTaskAccess = await env.DB.prepare(
    `SELECT 1 AS allowed FROM user_permissions
     WHERE user_id = ? AND permission_key LIKE 'tasks.%' LIMIT 1`,
  )
    .bind(user.id)
    .first<{ allowed: number }>();
  const isInitialAdmin = isInitialAdminEmail(env, user.email);
  const tenantAccessStatements: SqlStatement[] = [
    env.DB.prepare(
      `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role)
       SELECT id, ?, 'member' FROM workspaces WHERE workspace_key = ?`,
    ).bind(user.id, tenantProfile.workspaceKey),
  ];
  if (resolveRuntimeFeatures(env.FEATURE_MODULES).events) {
    tenantAccessStatements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
         VALUES (?, 'events.view')`,
      ).bind(user.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
         VALUES (?, 'events.create')`,
      ).bind(user.id),
    );
  }
  await env.DB.batch(tenantAccessStatements);
  if (existingTaskAccess || isInitialAdmin) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
         VALUES (?, 'tasks.view')`,
      ).bind(user.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
         VALUES (?, 'tasks.comment')`,
      ).bind(user.id),
      env.DB.prepare(
        `INSERT OR IGNORE INTO project_members (project_id, user_id, role)
         SELECT id, ?, 'viewer' FROM projects WHERE project_key = ?`,
      ).bind(user.id, tenantProfile.defaultProjectKey),
    ]);
  }
  if (isInitialAdmin) {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO user_permissions (user_id, permission_key)
         SELECT ?, key FROM permissions`,
      ).bind(user.id),
    ]);
  }
}

export class SignInDeniedError extends Error {
  constructor() {
    super('Access denied: this account has not been given access.');
    this.name = 'SignInDeniedError';
  }
}

/**
 * Admits a verified Google identity. A new user row is created only when a hosted domain is
 * configured and the address is in it, or the address is the configured first administrator; any
 * other unknown address is denied before any row or grant exists. Users that already exist
 * (created by an administrator, or earlier sign-ins) may sign in.
 */
export async function admitGoogleSignIn(
  env: Env,
  identity: {
    email: string;
    firstName: string;
    lastName: string;
    photoUrl: string | null;
    subject: string;
  },
) {
  // The agent principal is a service identity; it never signs in as a person.
  if (identity.email.toLowerCase() === tenantProfile.agent.email.toLowerCase()) {
    throw new SignInDeniedError();
  }
  const existing = await env.DB.prepare(
    'SELECT id, google_subject FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(identity.email)
    .first<{ id: number; google_subject: string | null }>();
  if (!existing && !mayCreateUserOnSignIn(env, identity.email)) throw new SignInDeniedError();
  if (existing?.google_subject && existing.google_subject !== identity.subject) {
    throw new Error('This email is already linked to a different Google identity.');
  }
  await env.DB.prepare(
    `INSERT INTO users (email, first_name, last_name, photo_url, google_subject, last_seen_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(email) DO UPDATE SET
       first_name=excluded.first_name, last_name=excluded.last_name,
       photo_url=excluded.photo_url, google_subject=excluded.google_subject,
       last_seen_at=excluded.last_seen_at, updated_at=excluded.last_seen_at`,
  )
    .bind(
      identity.email,
      identity.firstName,
      identity.lastName,
      identity.photoUrl,
      identity.subject,
    )
    .run();
  const user = await env.DB.prepare(
    'SELECT id, email, status FROM users WHERE email = ? COLLATE NOCASE',
  )
    .bind(identity.email)
    .first<{ id: number; email: string; status: string }>();
  if (user?.status !== 'active') throw new Error('Tasks access is disabled.');
  await provisionSignedInUser(env, user);
  return user;
}
