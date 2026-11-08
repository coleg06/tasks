import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { type RuntimeFeatures, resolveRuntimeFeatures } from '../shared/runtime-features';
import { tenantPortalOrigin, tenantProfile } from '../shared/tenant-profile';
import {
  defaultTaskAlertPreferences,
  getTaskAlertPreferences,
  readTaskAlertPreferences,
  updateTaskAlertPreferences,
} from './account/alerts';
import { updateAccountPreferences } from './account/api';
import {
  getAdminOverview,
  impersonateAdminUser,
  inviteAdminUser,
  stopAdminImpersonation,
  updateAdminUser,
} from './admin/api';
import { listAuditEvents } from './admin/audit';
import {
  bulkAdminUsers,
  bulkInviteAdminUsers,
  getAdminUserDetail,
  listDirectory,
  setAdminUserRoles,
} from './admin/people';
import { createAdminRole, deleteAdminRole, listAdminRoles, updateAdminRole } from './admin/roles';
import { getWorkflowAnalytics } from './analytics/api';
import {
  authIsConfigured,
  base64Url,
  constantTimeEqual,
  exchangeCode,
  pkceChallenge,
  verifyGoogleIdentity,
} from './auth/google';
import { impersonationStillAuthorized } from './auth/impersonation';
import { effectivePermissionKeys } from './auth/permissions';
import { admitGoogleSignIn } from './auth/provision';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  safeReturnTo,
  signOAuthState,
  signSession,
  verifyOAuthState,
  verifySession,
} from './auth/session';
import type { Env } from './env';
import {
  convertResponsibilityWorkflow,
  createApproval,
  createAssetVersion,
  createCopyVersion,
  createEvent,
  createEventComment,
  createResponsibility,
  createWorkItem,
  downloadAssetVersion,
  finalizeAssetVersion,
  getEvent,
  listAssignedEventWorkItems,
  listEventOptions,
  listEvents,
  listEventTemplates,
  maximumAssetBytes,
  patchDeliverable,
  patchEventFacts,
  patchEventStage,
  patchResponsibility,
  patchWorkItem,
  previewEventPlan,
  uploadAssetVersion,
} from './events/api';
import { assistEventIntake } from './events/assist-api';
import { apiBodyLimit, securityHeaders } from './http-hardening';
import { trustedUpstreamSettings, usesEnvTrustedUpstream } from './identity/auth-mode';
import { resolveTasksIdentity } from './identity/context';
import { trustedUpstreamIdentity } from './identity/trusted-upstream';
import {
  ingestPortalDesignRequest,
  PORTAL_DESIGN_MAX_BYTES,
  portalDesignHealth,
  redirectPortalDesignRequest,
} from './integrations/portal-design';
import { ingestPortalSupportTicket, portalSupportHealth } from './integrations/portal-support';
import { logApplicationError, logUnhandledError, requestLogger } from './logging';
import { authenticateMcpRequest, McpAuthenticationError, mcpAuthErrorResponse } from './mcp/auth';
import { mcpAvailability, mcpConfigurationProblems } from './mcp/config';
import { createMcpApiCaller, createTasksMcpHandler } from './mcp/server';
import {
  GatewayAssertionError,
  reserveGatewayRequest,
  resolveGatewayUser,
  verifyGatewayAssertion,
} from './mobile/assertion';
import { withMobileIdempotency } from './mobile/idempotency';
import { getMyWorkSummary } from './my-work/api';
import { configuredHostedDomain, publicOrigin } from './runtime/identity-config';
import { tenantRuntimeAdapters } from './runtime/tenant-adapters';
import { taskServiceApi } from './task-service/api';
import {
  createComment,
  createProject,
  createTask,
  deleteComment,
  getTask,
  listProjectAssignees,
  listProjectMembers,
  listProjects,
  listTasks,
  type TaskAppEnv,
  updateProject,
  updateTask,
  upsertProjectMember,
} from './tasks/api';
import { recordClientError } from './telemetry/api';

export const app = new Hono<TaskAppEnv>();

const CSRF_COOKIE = `${tenantProfile.security.cookiePrefix}_csrf`;

function issueCsrfCookie(context: Parameters<typeof setCookie>[0]) {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  setCookie(context, CSRF_COOKIE, token, {
    httpOnly: false,
    maxAge: 43_200,
    path: '/',
    sameSite: 'Strict',
    secure: true,
  });
  return token;
}

function expectedBrowserOrigin(context: { env: Env; req: { url: string } }) {
  return publicOrigin(context.env, context.req.url);
}

function requireRuntimeFeature(
  feature: 'events' | 'projects' | 'workflowAnalytics',
): MiddlewareHandler<TaskAppEnv> {
  return async (context, next) => {
    const features = resolveRuntimeFeatures(context.env.FEATURE_MODULES);
    if (!features[feature]) {
      return context.json({ error: 'feature_disabled', feature }, 404);
    }
    await next();
  };
}

app.use('*', requestLogger);
app.use('*', securityHeaders);
app.use(
  '/api/integrations/portal/design-requests',
  bodyLimit({
    maxSize: PORTAL_DESIGN_MAX_BYTES,
    onError: (context) => context.json({ error: 'payload_too_large' }, 400),
  }),
);
app.use('/api/*', apiBodyLimit(maximumAssetBytes));

function isPortableApiPath(path: string) {
  return (
    path === '/api/bootstrap' ||
    path === '/api/telemetry/client-error' ||
    path === '/api/task-service/v1' ||
    path.startsWith('/api/task-service/v1/')
  );
}

app.use('*', async (context, next) => {
  if (tenantProfile.tasks.apiMode !== 'portable') {
    await next();
    return;
  }
  const path = context.req.path;
  if (
    path === '/mcp' ||
    path === '/auth' ||
    path.startsWith('/auth/') ||
    ((path === '/api' || path.startsWith('/api/')) && !isPortableApiPath(path))
  ) {
    return context.json({ error: 'not_found' }, 404);
  }
  await next();
});

// The hosted MCP server is a per-server option (TASKS_MCP_ENABLED). When it is off, /mcp and the
// agent API it calls answer exactly as absent routes, before any other configuration is consulted.
app.use('*', async (context, next) => {
  const path = context.req.path;
  if (path !== '/mcp' && path !== '/api/agent/v1' && !path.startsWith('/api/agent/v1/')) {
    await next();
    return;
  }
  const availability = tenantProfile.agent.enabled ? mcpAvailability(context.env) : 'disabled';
  if (availability === 'disabled') return context.json({ error: 'not_found' }, 404);
  if (availability === 'invalid') return context.json({ error: 'not_configured' }, 503);
  await next();
});

app.use('*', async (context, next) => {
  const path = context.req.path;
  const requiresTenantConfiguration =
    path === '/mcp' ||
    path === '/api' ||
    path.startsWith('/api/') ||
    path === '/auth' ||
    path.startsWith('/auth/') ||
    path.startsWith('/r/');
  if (!requiresTenantConfiguration) {
    await next();
    return;
  }
  try {
    if (await tenantRuntimeAdapters.verifyTenantConfiguration(context.env)) {
      await next();
      return;
    }
  } catch (error) {
    await logApplicationError(
      'tenant.configuration_unavailable',
      error,
      context.env,
      context.get('requestId'),
    );
  }
  return context.json({ error: 'tenant_configuration_mismatch' }, 503);
});

app.use('/api/*', trustedUpstreamIdentity);

app.use('/api/*', async (context, next) => {
  const trustedUpstreamBrowser = tenantRuntimeAdapters.browserAuthentication === 'trusted-upstream';
  const trustedIdentityHeader = trustedUpstreamBrowser
    ? tenantRuntimeAdapters.browserIdentityHeader
    : trustedUpstreamSettings(context.env)?.emailHeader;
  const hasTrustedUpstreamIdentity =
    (trustedUpstreamBrowser || usesEnvTrustedUpstream(context.env)) &&
    trustedIdentityHeader !== undefined &&
    Boolean(context.req.header(trustedIdentityHeader));
  if (
    context.req.path.startsWith('/api/mobile/v1/') ||
    ['GET', 'HEAD', 'OPTIONS'].includes(context.req.method.toUpperCase()) ||
    (!hasTrustedUpstreamIdentity && !getCookie(context, SESSION_COOKIE))
  ) {
    await next();
    return;
  }
  const csrfCookie = getCookie(context, CSRF_COOKIE) ?? '';
  const csrfHeader = context.req.header('X-CSRF-Token') ?? '';
  if (
    context.req.header('Origin') !== expectedBrowserOrigin(context) ||
    csrfCookie.length < 32 ||
    csrfHeader.length !== csrfCookie.length ||
    !constantTimeEqual(csrfCookie, csrfHeader)
  ) {
    return context.json({ error: 'csrf_rejected' }, 403);
  }
  await next();
});

app.use('/api/analytics/workflows', requireRuntimeFeature('workflowAnalytics'));
app.use('/api/event-options', requireRuntimeFeature('events'));
app.use('/api/event-templates', requireRuntimeFeature('events'));
app.use('/api/event-work-items', requireRuntimeFeature('events'));
app.use('/api/events', requireRuntimeFeature('events'));
app.use('/api/events/*', requireRuntimeFeature('events'));

if (tenantProfile.capabilities.mobileApi) {
  app.use('/api/mobile/v1/*', async (context, next) => {
    try {
      const assertion = await verifyGatewayAssertion(context.req.raw, context.env);
      const user = await resolveGatewayUser(context.env, assertion);
      await reserveGatewayRequest(context.env, assertion, user.id);
      const permissions = await effectivePermissionKeys(context.env, user.id);
      context.set('taskIdentity', {
        session: {
          sub: String(user.id),
          email: user.email,
          perms: permissions,
          exp: assertion.exp,
        },
        user: { id: user.id, email: user.email, status: user.status },
        auditUserId: user.id,
      });
      context.set('mobileAdapter', true);
      await next();
    } catch (error) {
      if (error instanceof GatewayAssertionError) {
        return context.json({ error: error.code }, error.status);
      }
      await logApplicationError(
        'mobile.assertion_rejected',
        error,
        context.env,
        context.get('requestId'),
      );
      return context.json({ error: 'mobile_auth_failed' }, 401);
    }
  });
}

app.use('/api/agent/v1/*', async (context, next) => {
  if (!tenantProfile.agent.enabled) return context.json({ error: 'not_found' }, 404);
  try {
    const client = await authenticateMcpRequest(context.req.raw, context.env);
    // Credential scope is otherwise enforced only by the /mcp tool layer; apply it
    // to the HTTP surface too so a read-only credential cannot mutate directly.
    if (!['GET', 'HEAD'].includes(context.req.method) && client.scope !== 'read_write') {
      return context.json({ error: 'credential_read_only' }, 403);
    }
    const user = await context.env.DB.prepare(
      `SELECT id, email, status FROM users
       WHERE email = ? COLLATE NOCASE AND status = 'active' AND principal_type = 'agent'`,
    )
      .bind(tenantProfile.agent.email)
      .first<{ id: number; email: string; status: string }>();
    if (!user) return context.json({ error: 'agent_principal_unavailable' }, 503);
    const permissions = await effectivePermissionKeys(context.env, user.id);
    context.set('taskIdentity', {
      session: {
        sub: String(user.id),
        email: user.email,
        perms: permissions,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      user,
      auditUserId: user.id,
    });
    context.set('mobileAdapter', true);
    context.set('mcpClient', client);
    await next();
  } catch (error) {
    if (error instanceof McpAuthenticationError) return mcpAuthErrorResponse(error);
    await logApplicationError(
      'mcp.agent_auth_rejected',
      error,
      context.env,
      context.get('requestId'),
    );
    return context.json({ error: 'mcp_auth_failed' }, 401);
  }
});

if (tenantProfile.capabilities.portal) {
  app.use('/api/my-work/summary', async (context, next) => {
    const origin = context.req.header('Origin');
    const allowedOrigin = tenantPortalOrigin(context.env.ENVIRONMENT);
    if (origin === allowedOrigin) {
      context.header('Access-Control-Allow-Credentials', 'true');
      context.header('Access-Control-Allow-Origin', allowedOrigin);
      context.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
      context.header('Access-Control-Allow-Headers', 'Content-Type');
      context.header('Vary', 'Origin');
    }
    if (context.req.method === 'OPTIONS') {
      return origin === allowedOrigin
        ? context.body(null, 204)
        : context.json({ error: 'origin_not_allowed' }, 403);
    }
    await next();
  });
}

app.onError(async (error, context) => {
  // A request body that is not valid JSON is the caller's mistake, not a server fault. Reads
  // (which carry no body) keep reporting stored-data parse failures as server errors.
  if (
    error instanceof SyntaxError &&
    /JSON/i.test(error.message) &&
    !['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)
  ) {
    return context.json({ error: 'invalid_json' }, 400);
  }
  await logUnhandledError(error, context.req.raw, context.env, context.get('requestId'));
  return context.json({ error: 'internal_error' }, 500);
});

app.get('/healthz', (context) =>
  context.json({
    environment: context.env.ENVIRONMENT,
    ok: true,
    release: context.env.RELEASE_SHA,
    service: tenantProfile.serviceName,
  }),
);

app.get('/readyz', async (context) => {
  try {
    if (await tenantRuntimeAdapters.verifyTenantConfiguration(context.env)) {
      for (const check of context.env.PLATFORM_READINESS_CHECKS ?? []) await check();
      // Names only the MCP settings that are wrong, never their values.
      const mcpProblems = tenantProfile.agent.enabled ? mcpConfigurationProblems(context.env) : [];
      if (mcpProblems.length > 0) {
        return context.json(
          { error: 'mcp_configuration_invalid', ok: false, settings: mcpProblems },
          503,
        );
      }
      return context.json({
        ok: true,
        service: tenantProfile.serviceName,
        tenant: tenantProfile.key,
      });
    }
  } catch (error) {
    await logApplicationError(
      'tenant.configuration_unavailable',
      error,
      context.env,
      context.get('requestId'),
    );
  }
  return context.json({ error: 'tenant_configuration_mismatch', ok: false }, 503);
});

app.all('/mcp', async (context) => {
  if (!tenantProfile.agent.enabled) return context.json({ error: 'not_found' }, 404);
  try {
    const client = await authenticateMcpRequest(context.req.raw, context.env);
    const callApi = createMcpApiCaller(
      (input, init) => app.request(input, init, context.env, context.executionCtx),
      context.req.raw,
    );
    const handler = createTasksMcpHandler({
      client,
      env: context.env,
      request: context.req.raw,
      callApi,
    });
    return handler.fetch(context.req.raw, {
      authInfo: {
        token: `validated-by-${tenantProfile.serviceName}`,
        clientId: client.clientId,
        scopes: [client.scope],
        ...(client.expiresAt !== undefined ? { expiresAt: client.expiresAt } : {}),
      },
    });
  } catch (error) {
    if (error instanceof McpAuthenticationError) return mcpAuthErrorResponse(error);
    await logApplicationError('mcp.request_failed', error, context.env, context.get('requestId'));
    return context.json({ error: 'mcp_request_failed' }, 500);
  }
});

app.get('/api/integrations/portal/design-requests/health', portalDesignHealth);
app.post('/api/integrations/portal/design-requests', ingestPortalDesignRequest);
app.get('/r/portal-design-request/:submissionId', redirectPortalDesignRequest);
app.post('/api/telemetry/client-error', recordClientError);
app.route('/api/task-service/v1', taskServiceApi);
if (tenantProfile.capabilities.portalSupport) {
  app.get('/api/integrations/portal/support-tickets/health', portalSupportHealth);
  app.post('/api/integrations/portal/support-tickets', ingestPortalSupportTicket);
}

app.get('/auth/login', async (context) => {
  if (usesEnvTrustedUpstream(context.env)) return context.json({ error: 'not_found' }, 404);
  if (!authIsConfigured(context.env)) {
    return context.json({ error: 'auth_not_configured' }, 503);
  }
  const state = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const returnTo = safeReturnTo(context.req.query('returnTo'));
  const oauthCookie = await signOAuthState(context.env, { state, verifier, returnTo });
  setCookie(context, OAUTH_COOKIE, oauthCookie, {
    httpOnly: true,
    maxAge: 600,
    path: '/',
    sameSite: 'Lax',
    secure: true,
  });
  const redirectUri = new URL(
    '/auth/callback',
    publicOrigin(context.env, context.req.url),
  ).toString();
  const hostedDomain = configuredHostedDomain(context.env);
  const parameters = new URLSearchParams({
    access_type: 'online',
    client_id: context.env.GOOGLE_CLIENT_ID ?? '',
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  });
  if (hostedDomain) parameters.set('hd', hostedDomain);
  return context.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${parameters}`);
});

app.get('/auth/callback', async (context) => {
  try {
    if (usesEnvTrustedUpstream(context.env)) throw new Error('Session sign-in is disabled.');
    if (!authIsConfigured(context.env)) throw new Error('Authentication is not configured.');
    const code = context.req.query('code');
    const receivedState = context.req.query('state');
    const stateCookie = getCookie(context, OAUTH_COOKIE);
    if (!code || !receivedState || !stateCookie) throw new Error('Missing OAuth callback state.');
    const oauth = await verifyOAuthState(context.env, stateCookie);
    if (!constantTimeEqual(oauth.state, receivedState)) throw new Error('OAuth state mismatch.');
    deleteCookie(context, OAUTH_COOKIE, { path: '/', secure: true });

    const redirectUri = new URL(
      '/auth/callback',
      publicOrigin(context.env, context.req.url),
    ).toString();
    const identity = await verifyGoogleIdentity(
      context.env,
      await exchangeCode(context.env, { code, verifier: oauth.verifier, redirectUri }),
    );
    const user = await admitGoogleSignIn(context.env, identity);
    const permissionRows = await effectivePermissionKeys(context.env, user.id);
    const token = await signSession(context.env, user, permissionRows);
    setCookie(context, SESSION_COOKIE, token, {
      httpOnly: true,
      maxAge: 43_200,
      path: '/',
      sameSite: 'Lax',
      secure: true,
    });
    issueCsrfCookie(context);
    return context.redirect(oauth.returnTo);
  } catch (error) {
    await logApplicationError(
      'oauth.callback_rejected',
      error,
      context.env,
      context.get('requestId'),
    );
    return context.redirect('/?auth=failed');
  }
});

app.post('/auth/logout', (context) => {
  // Without this a page on another site could sign a user out by posting a form here.
  const origin = context.req.header('Origin');
  if (origin !== undefined && origin !== expectedBrowserOrigin(context)) {
    return context.json({ error: 'csrf_rejected' }, 403);
  }
  deleteCookie(context, SESSION_COOKIE, { path: '/', secure: true });
  return context.redirect('/');
});

app.get('/api/bootstrap', async (context) => {
  if (tenantRuntimeAdapters.browserAuthentication === 'trusted-upstream') {
    const identity = await resolveTasksIdentity(context, 'tasks.view');
    const email = identity?.principal.email?.trim().toLowerCase();
    if (!identity || !email) return context.json({ error: 'unauthorized' }, 401);
    const nameParts = identity.principal.name.trim().split(/\s+/).filter(Boolean);
    const firstName = nameParts.shift() ?? email;
    const lastName = nameParts.join(' ');
    const numericReference = Number(identity.principal.reference);
    if (!getCookie(context, CSRF_COOKIE)) issueCsrfCookie(context);
    return context.json({
      authConfigured: true,
      features: resolveRuntimeFeatures(context.env.FEATURE_MODULES),
      permissions: [...identity.permissions],
      release: context.env.RELEASE_SHA,
      user: {
        id: Number.isSafeInteger(numericReference) && numericReference >= 0 ? numericReference : 0,
        email,
        first_name: firstName,
        last_name: lastName,
        photo_url: null,
        task_creation_mode: 'guided',
        notification_email_preferences: {
          assignments: false,
          comments: false,
          mentions: false,
          deadlines: false,
        },
        task_alert_preferences: defaultTaskAlertPreferences,
      },
      impersonation: null,
    });
  }
  const envTrusted = usesEnvTrustedUpstream(context.env);
  const token = getCookie(context, SESSION_COOKIE);
  if (envTrusted ? !context.get('taskIdentity') : !token || !authIsConfigured(context.env)) {
    return context.json({ error: 'unauthorized' }, 401);
  }
  try {
    const trusted = context.get('taskIdentity');
    const session =
      envTrusted && trusted ? trusted.session : await verifySession(context.env, token ?? '');
    if (
      !session.perms.includes('tasks.view') &&
      !session.perms.includes('tasks.personal') &&
      !(
        resolveRuntimeFeatures(context.env.FEATURE_MODULES).events &&
        session.perms.includes('events.view')
      )
    ) {
      return context.json({ error: 'forbidden' }, 403);
    }
    const user = await context.env.DB.prepare(
      `SELECT id, email, first_name, last_name, photo_url, status
       FROM users WHERE id = ?`,
    )
      .bind(Number(session.sub))
      .first();
    if (user?.status !== 'active') return context.json({ error: 'forbidden' }, 403);
    if (!(await impersonationStillAuthorized(context.env, session, Number(session.sub)))) {
      throw new Error('impersonation_not_authorized');
    }
    // The Worker deploy runs immediately before D1 migrations. Defaulting here
    // keeps bootstrap available during that short additive-migration window.
    let taskCreationMode: 'guided' | 'quick' = 'guided';
    let notificationEmailPreferences = {
      assignments: true,
      comments: true,
      mentions: true,
      deadlines: true,
    };
    let taskAlertPreferences = defaultTaskAlertPreferences;
    try {
      const preference = await context.env.DB.prepare(
        'SELECT task_creation_mode FROM user_preferences WHERE user_id = ?',
      )
        .bind(Number(session.sub))
        .first<{ task_creation_mode: 'guided' | 'quick' }>();
      taskCreationMode = preference?.task_creation_mode ?? 'guided';
    } catch {
      taskCreationMode = 'guided';
    }
    try {
      const preference = await context.env.DB.prepare(
        `SELECT assignment_email, comment_email, mention_email, deadline_email
         FROM user_notification_preferences WHERE user_id = ?`,
      )
        .bind(Number(session.sub))
        .first<{
          assignment_email: number;
          comment_email: number;
          mention_email: number;
          deadline_email: number;
        }>();
      if (preference) {
        notificationEmailPreferences = {
          assignments: Boolean(preference.assignment_email),
          comments: Boolean(preference.comment_email),
          mentions: Boolean(preference.mention_email),
          deadlines: Boolean(preference.deadline_email),
        };
      }
      taskAlertPreferences = await readTaskAlertPreferences(context.env, Number(session.sub));
      notificationEmailPreferences = {
        assignments: taskAlertPreferences.assignments.email,
        comments: taskAlertPreferences.comments.email,
        mentions: taskAlertPreferences.mentions.email,
        deadlines: taskAlertPreferences.deadlines.email,
      };
    } catch {
      // The notification migration can briefly lag a new Worker deployment.
    }
    const permissionRows = await effectivePermissionKeys(context.env, Number(session.sub));
    const actor = session.act
      ? await context.env.DB.prepare(
          `SELECT id, email, first_name, last_name, photo_url
           FROM users WHERE id = ? AND status = 'active'`,
        )
          .bind(Number(session.act.sub))
          .first()
      : null;
    if (!getCookie(context, CSRF_COOKIE)) issueCsrfCookie(context);
    const features: RuntimeFeatures = resolveRuntimeFeatures(context.env.FEATURE_MODULES);
    return context.json({
      authConfigured: true,
      features,
      permissions: permissionRows,
      release: context.env.RELEASE_SHA,
      user: user
        ? {
            ...user,
            task_creation_mode: taskCreationMode,
            notification_email_preferences: notificationEmailPreferences,
            task_alert_preferences: taskAlertPreferences,
          }
        : user,
      impersonation: actor ? { actor } : null,
    });
  } catch {
    deleteCookie(context, SESSION_COOKIE, { path: '/', secure: true });
    return context.json({ error: 'unauthorized' }, 401);
  }
});

if (tenantProfile.capabilities.portal) app.get('/api/my-work/summary', getMyWorkSummary);
app.patch('/api/account/preferences', updateAccountPreferences);
app.get('/api/task-alert-preferences', getTaskAlertPreferences);
app.patch('/api/task-alert-preferences', updateTaskAlertPreferences);
if (tenantProfile.capabilities.workflowAnalytics) {
  app.get('/api/analytics/workflows', getWorkflowAnalytics);
}

if (tenantProfile.capabilities.mobileApi) {
  app.get('/api/mobile/v1/tasks', listTasks);
  app.post('/api/mobile/v1/tasks', (context) =>
    withMobileIdempotency(context, () => createTask(context)),
  );
  app.get('/api/mobile/v1/tasks/:taskKey', getTask);
  app.patch('/api/mobile/v1/tasks/:taskKey', (context) =>
    withMobileIdempotency(context, () => updateTask(context)),
  );
  app.post('/api/mobile/v1/tasks/:taskKey/comments', (context) =>
    withMobileIdempotency(context, () => createComment(context)),
  );
  app.delete('/api/mobile/v1/tasks/:taskKey/comments/:commentId', deleteComment);
  app.get('/api/mobile/v1/task-projects', listProjects);
  app.get('/api/mobile/v1/task-projects/:projectKey/assignees', listProjectAssignees);
  app.get('/api/mobile/v1/task-alert-preferences', getTaskAlertPreferences);
  app.patch('/api/mobile/v1/task-alert-preferences', updateTaskAlertPreferences);
  app.all('/api/mobile/v1/*', (context) => context.json({ error: 'not_found' }, 404));
}

app.get('/api/agent/v1/tasks', listTasks);
app.post('/api/agent/v1/tasks', (context) =>
  withMobileIdempotency(context, () => createTask(context)),
);
app.get('/api/agent/v1/tasks/:taskKey', getTask);
app.patch('/api/agent/v1/tasks/:taskKey', (context) =>
  withMobileIdempotency(context, () => updateTask(context)),
);
app.post('/api/agent/v1/tasks/:taskKey/comments', (context) =>
  withMobileIdempotency(context, () => createComment(context)),
);
app.all('/api/agent/v1/*', (context) => context.json({ error: 'not_found' }, 404));

app.get('/api/tasks', listTasks);
app.post('/api/tasks', createTask);
app.get('/api/tasks/:taskKey', getTask);
app.patch('/api/tasks/:taskKey', updateTask);
app.post('/api/tasks/:taskKey/comments', createComment);
app.delete('/api/tasks/:taskKey/comments/:commentId', deleteComment);
app.get('/api/projects', listProjects);
app.post('/api/projects', requireRuntimeFeature('projects'), createProject);
app.patch('/api/projects/:projectKey', requireRuntimeFeature('projects'), updateProject);
app.get('/api/projects/:projectKey/members', listProjectMembers);
app.get('/api/projects/:projectKey/assignees', listProjectAssignees);
app.put(
  '/api/projects/:projectKey/members',
  requireRuntimeFeature('projects'),
  upsertProjectMember,
);
app.get('/api/admin', getAdminOverview);
app.post('/api/admin/users', inviteAdminUser);
app.patch('/api/admin/users/:userId', updateAdminUser);
app.post('/api/admin/users/:userId/impersonate', impersonateAdminUser);
app.post('/api/admin/impersonation/stop', stopAdminImpersonation);
// Roles, the paged user directory, bulk operations and the audit view (legacy API only; each
// handler answers 404 unless the profile enables user administration).
app.get('/api/admin/directory', listDirectory);
app.get('/api/admin/audit', listAuditEvents);
app.get('/api/admin/roles', listAdminRoles);
app.post('/api/admin/roles', createAdminRole);
app.patch('/api/admin/roles/:roleKey', updateAdminRole);
app.delete('/api/admin/roles/:roleKey', deleteAdminRole);
app.post('/api/admin/users/bulk', bulkAdminUsers);
app.post('/api/admin/users/bulk-invite', bulkInviteAdminUsers);
app.get('/api/admin/users/:userId', getAdminUserDetail);
app.put('/api/admin/users/:userId/roles', setAdminUserRoles);
if (tenantProfile.capabilities.events) {
  app.get('/api/event-options', listEventOptions);
  app.get('/api/event-work-items', listAssignedEventWorkItems);
  if (tenantProfile.capabilities.eventPlanning) {
    app.get('/api/event-templates', listEventTemplates);
    app.post('/api/events/intake-assist', assistEventIntake);
    app.post('/api/events/plan-preview', previewEventPlan);
    app.post('/api/events', createEvent);
  }
  app.get('/api/events', listEvents);
  app.get('/api/events/:eventKey', getEvent);
  app.patch('/api/events/:eventKey/facts', patchEventFacts);
  app.patch('/api/events/:eventKey/stage', patchEventStage);
  app.patch('/api/events/:eventKey/deliverables/:deliverableKey', patchDeliverable);
  app.post('/api/events/:eventKey/work-items', createWorkItem);
  app.post('/api/events/:eventKey/responsibilities', createResponsibility);
  app.patch('/api/events/:eventKey/responsibilities/:responsibilityKey', patchResponsibility);
  app.post('/api/events/:eventKey/responsibility-workflow', convertResponsibilityWorkflow);
  app.post('/api/events/:eventKey/deliverables/:deliverableKey/assets', createAssetVersion);
  app.post('/api/events/:eventKey/deliverables/:deliverableKey/assets/upload', uploadAssetVersion);
  app.get('/api/events/:eventKey/assets/:assetId/download', downloadAssetVersion);
  app.post('/api/events/:eventKey/assets/:assetId/finalize', finalizeAssetVersion);
  app.patch('/api/events/:eventKey/work-items/:workItemKey', patchWorkItem);
  app.post('/api/events/:eventKey/copy-versions', createCopyVersion);
  app.post('/api/events/:eventKey/approvals', createApproval);
  app.post('/api/events/:eventKey/comments', createEventComment);
}

app.all('/api/*', (context) =>
  context.json(
    {
      error: 'not_found',
    },
    404,
  ),
);

app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw));
