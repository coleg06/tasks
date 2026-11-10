import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { RuntimeFeatures } from '../../../shared/runtime-features';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useAdmin, useAdminRoles } from '../api/queries';
import { AuditTab } from './AuditTab';
import { EmailSettings } from './EmailSettings';
import { PeopleTab } from './PeopleTab';
import { RolesTab } from './RolesTab';
import { dateTime } from './shared';

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

/** Workspace totals, notification delivery, operational logs, projects and recent activity. */
function OverviewTab() {
  const admin = useAdmin();
  const [logQuery, setLogQuery] = useState('');
  const [logLevel, setLogLevel] = useState<'all' | 'warning' | 'error'>('all');
  const data = admin.data;

  if (admin.isLoading) return <p className="admin-empty">Loading administration…</p>;
  if (admin.isError || !data) {
    return <p className="form-message is-error">Unable to load administration data.</p>;
  }
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
    <div className="admin-overview">
      <div className="admin-bar">
        <p>Workspace health, projects and recent activity.</p>
        <div className="admin-bar-actions">
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
                {event.redacted ? (
                  <p className="admin-muted">
                    Details hidden: they may belong to a private project.
                  </p>
                ) : (
                  <details>
                    <summary>Changes</summary>
                    <pre>{JSON.stringify(event.changes, null, 2)}</pre>
                  </details>
                )}
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

type AdminTab = 'people' | 'roles' | 'audit' | 'overview';

const tabs: Array<{ id: AdminTab; label: string }> = [
  { id: 'people', label: 'People' },
  { id: 'roles', label: 'Roles' },
  { id: 'audit', label: 'Audit log' },
  { id: 'overview', label: 'Overview' },
];

function tabFromHash(): AdminTab {
  const id = window.location.hash.replace('#', '');
  return tabs.some((tab) => tab.id === id) ? (id as AdminTab) : 'people';
}

export function AdminPanel({
  currentEmail,
}: {
  currentEmail: string;
  /** Accepted for callers that pass the runtime features; the sections read what they need. */
  features?: RuntimeFeatures;
}) {
  const [tab, setTab] = useState<AdminTab>(tabFromHash);
  const roles = useAdminRoles();
  const currentIsPlatformAdmin = roles.data?.canManageRoles ?? false;

  useEffect(() => {
    const onHashChange = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  function choose(next: AdminTab) {
    setTab(next);
    window.history.replaceState(null, '', `#${next}`);
  }

  return (
    <div className="admin-page">
      <div aria-label="Administration sections" className="admin-tabs" role="tablist">
        {tabs.map((entry) => (
          <button
            aria-controls={`admin-panel-${entry.id}`}
            aria-selected={tab === entry.id}
            id={`admin-tab-${entry.id}`}
            key={entry.id}
            onClick={() => choose(entry.id)}
            role="tab"
            type="button"
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        aria-labelledby={`admin-tab-${tab}`}
        className="admin-tabpanel"
        id={`admin-panel-${tab}`}
        role="tabpanel"
      >
        {tab === 'people' ? (
          <PeopleTab currentEmail={currentEmail} currentIsPlatformAdmin={currentIsPlatformAdmin} />
        ) : null}
        {tab === 'roles' ? <RolesTab /> : null}
        {tab === 'audit' ? <AuditTab /> : null}
        {tab === 'overview' ? (
          <>
            <OverviewTab />
            {currentIsPlatformAdmin && tenantProfile.capabilities.emailNotifications ? (
              <EmailSettings />
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
