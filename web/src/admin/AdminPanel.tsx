import { Eye, Pencil, RefreshCw, UserPlus, X } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { defaultRuntimeFeatures, type RuntimeFeatures } from '../../../shared/runtime-features';
import { tenantProfile } from '../../../shared/tenant-profile';
import {
  useAdmin,
  useImpersonateAdminUser,
  useInviteAdminUser,
  useUpdateAdminUser,
} from '../api/queries';
import type { AdminUser } from '../api/types';
import { Avatar } from '../ui/fields';
import { PropertyMenu } from '../ui/PropertyMenu';

function dateTime(value: string | null) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

const statusOptions = [
  { value: 'active' as const, label: 'Active' },
  { value: 'disabled' as const, label: 'Disabled' },
];

const roleOptions = [
  { value: 'none' as const, label: 'Personal only' },
  { value: 'member' as const, label: 'Shared task access' },
  { value: 'admin' as const, label: 'Task manager' },
];

const eventRoleOptions = [
  { value: 'participant' as const, label: 'Participant' },
  { value: 'manager' as const, label: 'Manager' },
];

const approvalOptions = [
  { value: 'no' as const, label: 'No' },
  { value: 'yes' as const, label: 'Reviewer' },
];

const platformRoleOptions = [
  { value: 'user' as const, label: 'Standard' },
  { value: 'admin' as const, label: 'Platform admin' },
];

const statLabels: Record<string, string> = {
  users: 'Users',
  projects: 'Projects',
  tasks: 'Tasks',
  comments: 'Comments',
};

function deliveryLabel(value: string) {
  if (value === 'accepted') return 'Accepted';
  if (value === 'failed') return 'Failed';
  if (value === 'pending') return 'Pending';
  if (value === 'skipped') return 'Skipped';
  return value.replaceAll('_', ' ');
}

function InviteUserForm({
  canAssignPlatformAdmin,
  eventsEnabled,
  onClose,
}: {
  canAssignPlatformAdmin: boolean;
  eventsEnabled: boolean;
  onClose: () => void;
}) {
  const invite = useInviteAdminUser();
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [hasTaskAccess, setHasTaskAccess] = useState(false);
  const [isManager, setIsManager] = useState(false);
  const [isEventManager, setIsEventManager] = useState(false);
  const [canApproveEvents, setCanApproveEvents] = useState(false);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await invite.mutateAsync({
        email,
        firstName,
        lastName,
        hasTaskAccess,
        isManager,
        isEventManager,
        canApproveEvents,
        isPlatformAdmin,
      });
    } catch {
      // The mutation error is rendered below the form.
    }
  }

  const inviteUrl = invite.data
    ? `${window.location.origin}${invite.data.signInPath}`
    : `${window.location.origin}/auth/login?returnTo=${eventsEnabled ? '%2Fevents' : '%2F'}`;
  const workspaceName = eventsEnabled
    ? `${tenantProfile.organizationName} Events & Promotion`
    : `${tenantProfile.organizationName} ${tenantProfile.productName}`;
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(workspaceName)}&body=${encodeURIComponent(`You can sign in to ${workspaceName} with your ${tenantProfile.organizationName} ${tenantProfile.identity.providerLabel} account:\n\n${inviteUrl}`)}`;

  return (
    <section className="admin-user-editor" aria-label="Invite a staff member">
      <header>
        <div>
          <h2>Invite a staff member</h2>
          <p>
            Pre-authorize their {tenantProfile.organizationName}{' '}
            {tenantProfile.identity.providerLabel} account and choose initial access.
          </p>
        </div>
        <button
          aria-label="Close invitation form"
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <X />
        </button>
      </header>
      {invite.isSuccess ? (
        <div className="admin-invite-success">
          <strong>{email} is ready to sign in.</strong>
          <span>
            Their {tenantProfile.identity.providerLabel} name and profile picture will refresh on
            first sign-in.
          </span>
          <a className="button-primary" href={mailto}>
            Open email invitation
          </a>
        </div>
      ) : (
        <form className="admin-user-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>First name</span>
            <input onChange={(event) => setFirstName(event.target.value)} value={firstName} />
          </label>
          <label>
            <span>Last name</span>
            <input onChange={(event) => setLastName(event.target.value)} value={lastName} />
          </label>
          <label className="is-wide">
            <span>{tenantProfile.organizationName} email</span>
            <input
              onChange={(event) => setEmail(event.target.value)}
              placeholder={`name@${tenantProfile.identity.hostedDomain || 'example.org'}`}
              required
              type="email"
              value={email}
            />
          </label>
          <fieldset className="admin-access-grid">
            <legend>Initial access</legend>
            {canAssignPlatformAdmin ? (
              <label>
                <input
                  checked={isPlatformAdmin}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setIsPlatformAdmin(checked);
                    if (checked) {
                      setHasTaskAccess(true);
                      setIsManager(true);
                      if (eventsEnabled) {
                        setIsEventManager(true);
                        setCanApproveEvents(true);
                      }
                    }
                  }}
                  type="checkbox"
                />
                Platform administrator
              </label>
            ) : null}
            <label>
              <input
                checked={hasTaskAccess}
                onChange={(event) => setHasTaskAccess(event.target.checked)}
                type="checkbox"
              />
              Shared task project access
            </label>
            <label>
              <input
                checked={isManager}
                onChange={(event) => {
                  setIsManager(event.target.checked);
                  if (event.target.checked) setHasTaskAccess(true);
                }}
                type="checkbox"
              />
              Task manager
            </label>
            {eventsEnabled ? (
              <>
                <label>
                  <input
                    checked={isEventManager}
                    onChange={(event) => setIsEventManager(event.target.checked)}
                    type="checkbox"
                  />
                  Event manager
                </label>
                <label>
                  <input
                    checked={canApproveEvents}
                    onChange={(event) => setCanApproveEvents(event.target.checked)}
                    type="checkbox"
                  />
                  Event reviewer
                </label>
              </>
            ) : null}
          </fieldset>
          {invite.isError ? <p className="form-message is-error">{invite.error.message}</p> : null}
          <button className="button-primary" disabled={invite.isPending} type="submit">
            <UserPlus /> {invite.isPending ? 'Inviting…' : 'Create invitation'}
          </button>
        </form>
      )}
    </section>
  );
}

function EditUserForm({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const update = useUpdateAdminUser();
  const [email, setEmail] = useState(user.email);
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      await update.mutateAsync({
        userId: user.id,
        email,
        firstName,
        lastName,
        status: user.status,
        hasTaskAccess: user.permissions.includes('tasks.view'),
        isManager: user.permissions.includes('tasks.manage'),
        isEventManager: user.permissions.includes('events.manage'),
        canApproveEvents: user.permissions.includes('events.approve'),
        isPlatformAdmin: user.permissions.includes('platform.admin'),
      });
      onClose();
    } catch {
      // The mutation error is rendered below the form.
    }
  }

  return (
    <section className="admin-user-editor" aria-label={`Edit ${user.email}`}>
      <header>
        <div>
          <h2>Edit user details</h2>
          <p>
            {tenantProfile.identity.providerLabel} refreshes the name and profile picture whenever
            this person signs in.
          </p>
        </div>
        <button
          aria-label="Close user editor"
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <X />
        </button>
      </header>
      <form className="admin-user-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>First name</span>
          <input onChange={(event) => setFirstName(event.target.value)} value={firstName} />
        </label>
        <label>
          <span>Last name</span>
          <input onChange={(event) => setLastName(event.target.value)} value={lastName} />
        </label>
        <label className="is-wide">
          <span>Email</span>
          <input
            disabled={user.hasSignedIn}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
          {user.hasSignedIn ? (
            <small>{tenantProfile.identity.providerLabel}-linked emails cannot be renamed.</small>
          ) : null}
        </label>
        {update.isError ? <p className="form-message is-error">{update.error.message}</p> : null}
        <button className="button-primary" disabled={update.isPending} type="submit">
          {update.isPending ? 'Saving…' : 'Save details'}
        </button>
      </form>
    </section>
  );
}

export function AdminPanel({
  currentEmail,
  features = defaultRuntimeFeatures,
}: {
  currentEmail: string;
  features?: RuntimeFeatures;
}) {
  const admin = useAdmin();
  const updateUser = useUpdateAdminUser();
  const impersonate = useImpersonateAdminUser();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [logQuery, setLogQuery] = useState('');
  const [logLevel, setLogLevel] = useState<'all' | 'warning' | 'error'>('all');
  const data = admin.data;

  if (admin.isLoading) return <p className="admin-empty">Loading administration…</p>;
  if (admin.isError || !data) {
    return <p className="form-message is-error">Unable to load administration data.</p>;
  }
  const currentIsPlatformAdmin =
    data.users
      .find((user) => user.email.toLowerCase() === currentEmail.toLowerCase())
      ?.permissions.includes('platform.admin') ?? false;
  const notificationHealth = data.notificationHealth;
  const needsNotificationAttention =
    (tenantProfile.capabilities.emailNotifications
      ? notificationHealth.email.unresolvedFailed + notificationHealth.email.stalledPending
      : 0) +
    (tenantProfile.capabilities.portalAlerts
      ? notificationHealth.portalAlerts.readyToRetry +
        notificationHealth.portalAlerts.stalledProcessing +
        notificationHealth.portalAlerts.deadLetter
      : 0);
  const normalizedLogQuery = logQuery.trim().toLowerCase();
  const visibleOperationalEvents = data.operationalHealth.recentEvents.filter((event) => {
    if (logLevel !== 'all' && event.severity !== logLevel) return false;
    if (!normalizedLogQuery) return true;
    return [
      event.event,
      event.source,
      event.message,
      event.requestId,
      event.path,
      event.actor?.name,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalizedLogQuery));
  });

  return (
    <div className="admin-page">
      <div className="admin-bar">
        <p>Access, projects, and immutable activity records.</p>
        <div className="admin-bar-actions">
          <button className="button-primary" onClick={() => setInviteOpen(true)} type="button">
            <UserPlus aria-hidden="true" /> Invite user
          </button>
          <button
            className="button-quiet"
            disabled={admin.isFetching}
            onClick={() => void admin.refetch()}
            type="button"
          >
            <RefreshCw aria-hidden="true" />
            {admin.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {inviteOpen ? (
        <InviteUserForm
          canAssignPlatformAdmin={currentIsPlatformAdmin}
          eventsEnabled={features.events}
          onClose={() => setInviteOpen(false)}
        />
      ) : null}
      {editingUser ? (
        <EditUserForm
          key={editingUser.id}
          onClose={() => setEditingUser(null)}
          user={editingUser}
        />
      ) : null}

      {updateUser.isError ? (
        <p className="form-message is-error">Unable to update that user.</p>
      ) : null}

      <section aria-label="Workspace totals" className="admin-stats">
        {Object.entries(data.stats).map(([key, value]) => (
          <div key={key}>
            <strong>{value}</strong>
            <span>{statLabels[key] ?? key}</span>
          </div>
        ))}
      </section>

      {tenantProfile.capabilities.emailNotifications || tenantProfile.capabilities.portalAlerts ? (
        <section className="admin-section notification-health">
          <div className="admin-section-heading">
            <div>
              <h2>Notification delivery</h2>
              <p>
                Enabled notification channels and delivery health for this environment. Delivery
                records are idempotent and do not contain message bodies.
              </p>
            </div>
            <span className={needsNotificationAttention ? 'badge is-error' : 'badge is-on'}>
              {needsNotificationAttention
                ? `${needsNotificationAttention} need attention`
                : 'Healthy'}
            </span>
          </div>

          <div className="notification-health-grid">
            {tenantProfile.capabilities.emailNotifications ? (
              <>
                <article>
                  <span>Email accepted</span>
                  <strong>{notificationHealth.email.accepted24h}</strong>
                  <small>Last 24 hours</small>
                </article>
                <article>
                  <span>Email failures</span>
                  <strong>{notificationHealth.email.failed24h}</strong>
                  <small>
                    {notificationHealth.email.unresolvedFailed} unresolved ·{' '}
                    {notificationHealth.email.stalledPending} stalled
                  </small>
                </article>
              </>
            ) : null}
            {tenantProfile.capabilities.portalAlerts ? (
              <article>
                <span>Portal alerts</span>
                <strong>{notificationHealth.portalAlerts.delivered24h}</strong>
                <small>Delivered in the last 24 hours</small>
              </article>
            ) : null}
            <article>
              <span>Environment policy</span>
              <strong className="notification-policy-value">
                {notificationHealth.environment === 'production' ? 'Production' : 'Development'}
              </strong>
              <small>
                {tenantProfile.capabilities.emailNotifications
                  ? `Email ${notificationHealth.emailConfigured ? 'enabled' : 'safely disabled'}`
                  : null}
                {tenantProfile.capabilities.emailNotifications &&
                tenantProfile.capabilities.portalAlerts
                  ? ' · '
                  : null}
                {tenantProfile.capabilities.portalAlerts
                  ? `Portal ${notificationHealth.portalAlertsConfigured ? 'enabled' : 'disabled'}`
                  : null}
              </small>
            </article>
          </div>

          {tenantProfile.capabilities.emailNotifications ? <h3>Recent email deliveries</h3> : null}
          {tenantProfile.capabilities.emailNotifications &&
          notificationHealth.recentEmailDeliveries.length ? (
            <div className="admin-table notification-delivery-table">
              <div className="admin-table-header">
                <span>Recipient</span>
                <span>Notification</span>
                <span>Target</span>
                <span>Status</span>
                <span>Updated</span>
              </div>
              {notificationHealth.recentEmailDeliveries.map((delivery) => (
                <div className="admin-table-row" key={delivery.id}>
                  <span className="admin-identity">
                    <span>
                      <strong>{delivery.recipient.name}</strong>
                      <small>{delivery.recipient.email}</small>
                    </span>
                  </span>
                  <span className="admin-capitalize">{delivery.kind.replaceAll('_', ' ')}</span>
                  <span className="admin-identity">
                    <span>
                      <strong>{delivery.entityKey}</strong>
                      <small>{delivery.entityType.replaceAll('_', ' ')}</small>
                    </span>
                  </span>
                  <span>
                    <span
                      className={
                        delivery.status === 'accepted'
                          ? 'badge is-on'
                          : delivery.status === 'failed'
                            ? 'badge is-error'
                            : 'badge'
                      }
                      title={delivery.errorCode ?? undefined}
                    >
                      {deliveryLabel(delivery.status)}
                    </span>
                  </span>
                  <time className="admin-muted" dateTime={delivery.updatedAt}>
                    {dateTime(delivery.updatedAt)}
                  </time>
                </div>
              ))}
            </div>
          ) : tenantProfile.capabilities.emailNotifications ? (
            <p className="admin-empty">
              No application email has been recorded in this environment.
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="admin-section operational-health">
        <div className="admin-section-heading">
          <div>
            <h2>Operational logs</h2>
            <p>
              Application, browser, integration, and background failures. Logs include request IDs
              for correlation but never request bodies, cookies, access tokens, or credentials.
            </p>
          </div>
          <span
            className={
              data.operationalHealth.errors24h || data.operationalHealth.warnings24h
                ? 'badge is-error'
                : 'badge is-on'
            }
          >
            {data.operationalHealth.errors24h + data.operationalHealth.warnings24h
              ? `${data.operationalHealth.errors24h} errors · ${data.operationalHealth.warnings24h} warnings`
              : 'No failures in 24h'}
          </span>
        </div>

        <div className="operational-log-filters">
          <input
            aria-label="Search operational logs"
            onChange={(event) => setLogQuery(event.target.value)}
            placeholder="Search event, message, route, or request ID"
            type="search"
            value={logQuery}
          />
          <select
            aria-label="Filter operational logs by severity"
            onChange={(event) => setLogLevel(event.target.value as typeof logLevel)}
            value={logLevel}
          >
            <option value="all">All severities</option>
            <option value="error">Errors</option>
            <option value="warning">Warnings</option>
          </select>
        </div>

        {visibleOperationalEvents.length ? (
          <div className="admin-events operational-events">
            {visibleOperationalEvents.map((event) => (
              <article key={event.id}>
                <div className="admin-event-head">
                  <span className={event.severity === 'error' ? 'badge is-error' : 'badge'}>
                    {event.severity}
                  </span>
                  <strong>{event.event.replaceAll('.', ' ')}</strong>
                  <span className="admin-muted">{event.source}</span>
                  {event.statusCode ? (
                    <span className="admin-muted">HTTP {event.statusCode}</span>
                  ) : null}
                  <time className="admin-muted admin-event-time" dateTime={event.createdAt}>
                    {dateTime(event.createdAt)}
                  </time>
                </div>
                <p>{event.message}</p>
                <div className="operational-event-context">
                  {event.method || event.path ? (
                    <code>{[event.method, event.path].filter(Boolean).join(' ')}</code>
                  ) : null}
                  {event.requestId ? <code>Request {event.requestId}</code> : null}
                  {event.actor ? <span>{event.actor.name}</span> : null}
                </div>
                {Object.keys(event.details).length ? (
                  <details>
                    <summary>Diagnostic details</summary>
                    <pre>{JSON.stringify(event.details, null, 2)}</pre>
                  </details>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <p className="admin-empty">
            {data.operationalHealth.recentEvents.length
              ? 'No operational logs match those filters.'
              : 'No operational failures have been recorded in this environment.'}
          </p>
        )}
      </section>

      <section className="admin-section">
        <h2>Users</h2>
        <div className={`admin-table admin-table-users${features.events ? '' : ' without-events'}`}>
          <div className="admin-table-header">
            <span>User</span>
            <span>Last active</span>
            <span>Status</span>
            <span>Platform role</span>
            <span>Task role</span>
            {features.events ? <span>Event role</span> : null}
            {features.events ? <span>Approvals</span> : null}
            <span>Actions</span>
          </div>
          {data.users.map((user) => {
            // Nobody may lock themselves out of the workspace they administer.
            const isSelf = user.email.toLowerCase() === currentEmail.toLowerCase();
            const isManager = user.permissions.includes('tasks.manage');
            const hasTaskAccess = user.permissions.includes('tasks.view');
            const isEventManager = user.permissions.includes('events.manage');
            const canApproveEvents = user.permissions.includes('events.approve');
            const isPlatformAdmin = user.permissions.includes('platform.admin');
            const pending = updateUser.isPending && updateUser.variables?.userId === user.id;
            return (
              <div className="admin-table-row" key={user.id}>
                <span className="admin-identity">
                  <Avatar email={user.email} name={user.name} photoUrl={user.photoUrl} />
                  <span>
                    <strong>{user.name}</strong>
                    <small>
                      {user.email} ·{' '}
                      {user.hasSignedIn
                        ? `${tenantProfile.identity.providerLabel} connected`
                        : 'Invited'}
                    </small>
                  </span>
                </span>
                <span className="admin-muted">{dateTime(user.lastSeenAt)}</span>
                <span>
                  <PropertyMenu
                    ariaLabel={`Status for ${user.email}`}
                    disabled={isSelf || pending}
                    onSelect={(status) =>
                      updateUser.mutate({
                        userId: user.id,
                        status,
                        hasTaskAccess,
                        isManager,
                        isEventManager,
                        canApproveEvents,
                        isPlatformAdmin,
                      })
                    }
                    options={statusOptions}
                    trigger={
                      <span className={user.status === 'active' ? 'badge is-on' : 'badge'}>
                        {user.status === 'active' ? 'Active' : 'Disabled'}
                      </span>
                    }
                    value={user.status}
                  />
                </span>
                <span>
                  <PropertyMenu
                    ariaLabel={`Platform role for ${user.email}`}
                    disabled={!currentIsPlatformAdmin || isSelf || pending}
                    onSelect={(role) =>
                      updateUser.mutate({
                        userId: user.id,
                        status: user.status,
                        hasTaskAccess: role === 'admin' || hasTaskAccess,
                        isManager: role === 'admin' || isManager,
                        isEventManager: role === 'admin' || isEventManager,
                        canApproveEvents: role === 'admin' || canApproveEvents,
                        isPlatformAdmin: role === 'admin',
                      })
                    }
                    options={platformRoleOptions}
                    trigger={
                      <span className={isPlatformAdmin ? 'badge is-accent' : 'badge'}>
                        {isPlatformAdmin ? 'Platform admin' : 'Standard'}
                      </span>
                    }
                    value={isPlatformAdmin ? 'admin' : 'user'}
                  />
                </span>
                <span>
                  <PropertyMenu
                    ariaLabel={`Role for ${user.email}`}
                    disabled={isSelf || pending}
                    onSelect={(role) =>
                      updateUser.mutate({
                        userId: user.id,
                        status: user.status,
                        hasTaskAccess: role !== 'none',
                        isManager: role === 'admin',
                        isEventManager,
                        canApproveEvents,
                        isPlatformAdmin,
                      })
                    }
                    options={roleOptions}
                    trigger={
                      <span className={isManager ? 'badge is-accent' : 'badge'}>
                        {isManager
                          ? 'Task manager'
                          : hasTaskAccess
                            ? 'Shared access'
                            : 'Personal only'}
                      </span>
                    }
                    value={isManager ? 'admin' : hasTaskAccess ? 'member' : 'none'}
                  />
                </span>
                {features.events ? (
                  <span>
                    <PropertyMenu
                      ariaLabel={`Event role for ${user.email}`}
                      disabled={pending}
                      onSelect={(role) =>
                        updateUser.mutate({
                          userId: user.id,
                          status: user.status,
                          hasTaskAccess,
                          isManager,
                          isEventManager: role === 'manager',
                          canApproveEvents,
                          isPlatformAdmin,
                        })
                      }
                      options={eventRoleOptions}
                      trigger={
                        <span className={isEventManager ? 'badge is-accent' : 'badge'}>
                          {isEventManager ? 'Manager' : 'Participant'}
                        </span>
                      }
                      value={isEventManager ? 'manager' : 'participant'}
                    />
                  </span>
                ) : null}
                {features.events ? (
                  <span>
                    <PropertyMenu
                      ariaLabel={`Event approval role for ${user.email}`}
                      disabled={pending}
                      onSelect={(approval) =>
                        updateUser.mutate({
                          userId: user.id,
                          status: user.status,
                          hasTaskAccess,
                          isManager,
                          isEventManager,
                          canApproveEvents: approval === 'yes',
                          isPlatformAdmin,
                        })
                      }
                      options={approvalOptions}
                      trigger={
                        <span className={canApproveEvents ? 'badge is-on' : 'badge'}>
                          {canApproveEvents ? 'Reviewer' : 'No'}
                        </span>
                      }
                      value={canApproveEvents ? 'yes' : 'no'}
                    />
                  </span>
                ) : null}
                <span className="admin-user-actions">
                  <button
                    aria-label={`Edit ${user.email}`}
                    className="icon-button"
                    onClick={() => setEditingUser(user)}
                    title="Edit details"
                    type="button"
                  >
                    <Pencil />
                  </button>
                  <button
                    aria-label={`View as ${user.email}`}
                    className="icon-button"
                    disabled={isSelf || user.status !== 'active' || impersonate.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `View Tasks as ${user.name}? A banner will let you return to your account.`,
                        )
                      ) {
                        impersonate.mutate(user.id);
                      }
                    }}
                    title="Impersonate user"
                    type="button"
                  >
                    <Eye />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="admin-section">
        <h2>Projects</h2>
        <div className="admin-table admin-table-projects">
          <div className="admin-table-header">
            <span>Project</span>
            <span>Access</span>
            <span>Tasks</span>
            <span>Members</span>
          </div>
          {data.projects.map((project) => (
            <div className="admin-table-row" key={project.key}>
              <span className="admin-identity">
                <span>
                  <strong>{project.name}</strong>
                  <small>
                    {project.workspaceName} · {project.key}
                  </small>
                </span>
              </span>
              <span className="admin-muted admin-capitalize">{project.visibility}</span>
              <span className="admin-number">{project.taskCount}</span>
              <span className="admin-number">{project.memberCount}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="admin-section">
        <h2>Activity log</h2>
        {data.events.length ? (
          <div className="admin-events">
            {data.events.map((event) => (
              <article key={event.id}>
                <div className="admin-event-head">
                  <strong>{event.action.replaceAll('.', ' ')}</strong>
                  <span className="admin-muted">
                    {event.entityType} · {event.entityKey}
                  </span>
                  <span className="admin-muted">{event.actor.name}</span>
                  <time className="admin-muted admin-event-time" dateTime={event.createdAt}>
                    {dateTime(event.createdAt)}
                  </time>
                </div>
                <details>
                  <summary>Changes</summary>
                  <pre>{JSON.stringify(event.changes, null, 2)}</pre>
                </details>
              </article>
            ))}
          </div>
        ) : (
          <p className="admin-empty">New changes will appear here.</p>
        )}
      </section>
    </div>
  );
}
