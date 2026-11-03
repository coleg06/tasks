import { Link } from '@tanstack/react-router';
import { BarChart3, Clock3, Image, ListChecks, Workflow } from 'lucide-react';
import { useState } from 'react';
import { defaultRuntimeFeatures } from '../../../shared/runtime-features';
import { useBootstrap, useWorkflowAnalytics } from '../api/queries';
import type { WorkflowDurationMetric } from '../api/types';
import { PropertyMenu } from '../ui/PropertyMenu';

const periods = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 180 days' },
  { value: '365', label: 'Last year' },
];

function duration(hours: number | null) {
  if (hours === null) return 'Collecting data';
  if (hours < 24) return `${Math.round(hours * 10) / 10} hours`;
  return `${Math.round((hours / 24) * 10) / 10} days`;
}

function Metric({
  icon: Icon,
  label,
  metric,
}: {
  icon: typeof Clock3;
  label: string;
  metric: WorkflowDurationMetric;
}) {
  return (
    <article className="analytics-metric">
      <Icon aria-hidden="true" />
      <span>{label}</span>
      <strong>{duration(metric.averageHours)}</strong>
      <small>
        Median {duration(metric.medianHours)} · {metric.sampleSize} completed
      </small>
    </article>
  );
}

export function AnalyticsPage() {
  const bootstrap = useBootstrap();
  const features = bootstrap.data?.features ?? defaultRuntimeFeatures;
  const allowed = Boolean(
    features.workflowAnalytics &&
      bootstrap.data?.permissions.some((permission) =>
        ['events.manage', 'tasks.manage'].includes(permission),
      ),
  );
  const [days, setDays] = useState(90);
  const query = useWorkflowAnalytics(days, allowed);
  const analytics = query.data;

  if (!allowed) {
    return (
      <div className="events-access">
        <BarChart3 />
        <h1>Analytics unavailable</h1>
        <p>Workflow analytics are available to event and task managers.</p>
      </div>
    );
  }
  return (
    <>
      {/* Same header shape as every other screen: title left, controls right,
          on one 48px line. */}
      <header className="tasks-topbar">
        <h1 className="tasks-page-title">Workflow analytics</h1>
        <div className="tasks-topbar-actions">
          <PropertyMenu
            ariaLabel="Reporting period"
            onSelect={(value) => setDays(Number(value))}
            options={periods}
            trigger={periods.find((period) => period.value === String(days))?.label ?? 'Period'}
            value={String(days)}
          />
        </div>
      </header>

      <div className="tasks-content analytics-scroll">
        <div className="analytics-body">
          <p className="analytics-intro">
            Elapsed time is measured from real status changes, so there are no timers for staff to
            start or stop.
          </p>
          {query.isLoading || !analytics ? (
            <section className="analytics-metrics" aria-busy="true">
              {['a', 'b', 'c', 'd'].map((id) => (
                <article className="analytics-metric is-skeleton" key={id} />
              ))}
            </section>
          ) : (
            <>
              <section className="analytics-metrics">
                <Metric
                  icon={Workflow}
                  label="Event request to ready"
                  metric={analytics.metrics.eventLeadTime}
                />
                <Metric
                  icon={ListChecks}
                  label="Event task turnaround"
                  metric={analytics.metrics.eventTaskLeadTime}
                />
                <Metric
                  icon={Clock3}
                  label="General task turnaround"
                  metric={analytics.metrics.standardTaskLeadTime}
                />
                <Metric
                  icon={Image}
                  label="Deliverable to approval"
                  metric={analytics.metrics.deliverableApprovalTime}
                />
              </section>
              <section className="analytics-grid">
                <article className="analytics-panel">
                  <header>
                    <div>
                      <span>Where time goes</span>
                      <strong>Task turnaround by phase</strong>
                    </div>
                  </header>
                  <div className="analytics-phase-list">
                    {analytics.phases.length ? (
                      analytics.phases.map((phase) => (
                        <div key={phase.phase}>
                          <span>{phase.phase.replaceAll('_', ' ')}</span>
                          <strong>{duration(phase.averageHours)}</strong>
                          <small>{phase.sampleSize} completed</small>
                        </div>
                      ))
                    ) : (
                      <p>Phase timing will appear as event tasks are completed.</p>
                    )}
                  </div>
                </article>
                <article className="analytics-panel">
                  <header>
                    <div>
                      <span>Creative iteration</span>
                      <strong>
                        {analytics.metrics.averageAssetVersions} versions per deliverable
                      </strong>
                    </div>
                  </header>
                  <div className="analytics-revision">
                    <strong>{analytics.metrics.revisionRate}%</strong>
                    <span>of deliverables required more than one uploaded revision.</span>
                  </div>
                </article>
              </section>
              <section className="analytics-panel">
                <header>
                  <div>
                    <span>Recently ready</span>
                    <strong>Completed event workflows</strong>
                  </div>
                </header>
                <div className="analytics-events">
                  {analytics.recentEvents.length ? (
                    analytics.recentEvents.map((event) => (
                      <Link
                        key={event.key}
                        search={{ view: 'open' }}
                        to="/events/$eventKey"
                        params={{ eventKey: event.key }}
                      >
                        <span>
                          <strong>{event.title}</strong>
                          <small>{event.reference}</small>
                        </span>
                        <span>{duration(event.elapsedHours)}</span>
                      </Link>
                    ))
                  ) : (
                    <p>Completed event workflows will appear here.</p>
                  )}
                </div>
              </section>
              <p className="analytics-note">
                Exact lifecycle tracking began{' '}
                {analytics.trackingStartedAt
                  ? new Date(analytics.trackingStartedAt).toLocaleDateString()
                  : 'with this release'}
                . Imported history remains identifiable and can be backfilled when source timestamps
                are available.
              </p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
