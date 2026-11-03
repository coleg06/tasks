import { Link } from '@tanstack/react-router';
import { CalendarDays, ChevronRight, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import { defaultRuntimeFeatures } from '../../../shared/runtime-features';
import { useBootstrap, useEvents } from '../api/queries';
import { type EventStage, eventStageLabels } from '../api/types';

function dateLabel(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

export function EventsPage() {
  const bootstrap = useBootstrap();
  const features = bootstrap.data?.features ?? defaultRuntimeFeatures;
  const canView = features.events && (bootstrap.data?.permissions.includes('events.view') ?? false);
  const canCreate =
    features.eventPlanning && (bootstrap.data?.permissions.includes('events.create') ?? false);
  const [query, setQuery] = useState('');
  const [stage, setStage] = useState('');
  const events = useEvents(
    { ...(query ? { q: query } : {}), ...(stage ? { stage } : {}) },
    canView,
  );
  const rows = events.data ?? [];

  if (!canView) {
    return (
      <div className="events-access">
        <CalendarDays aria-hidden="true" />
        <h1>Events are not enabled for this account</h1>
        <p>An administrator can add event access without changing your task-list permissions.</p>
      </div>
    );
  }

  return (
    <div className="events-page">
      <header className="tasks-topbar">
        <h1 className="tasks-page-title">Events &amp; promotion</h1>
        <div className="tasks-topbar-actions">
          {canCreate ? (
            <Link
              className="button-primary events-new-button"
              search={{ view: 'open' }}
              to="/events/new"
            >
              <Plus aria-hidden="true" /> Plan an event
            </Link>
          ) : null}
        </div>
      </header>

      <div className="events-content">
        <section className="events-list-card">
          <header>
            <div>
              <h2>Event plans</h2>
              <span>
                {rows.length} {rows.length === 1 ? 'event' : 'events'}
              </span>
            </div>
            <div className="events-list-filters">
              <label className="events-search">
                <Search aria-hidden="true" />
                <span className="sr-only">Search events</span>
                <input
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search events"
                  type="search"
                  value={query}
                />
              </label>
              <select
                aria-label="Filter by stage"
                onChange={(event) => setStage(event.target.value)}
                value={stage}
              >
                <option value="">All stages</option>
                {(Object.keys(eventStageLabels) as EventStage[]).map((key) => (
                  <option key={key} value={key}>
                    {eventStageLabels[key]}
                  </option>
                ))}
              </select>
            </div>
          </header>

          {events.isLoading ? (
            <div className="events-loading">Loading event plans…</div>
          ) : rows.length === 0 ? (
            <div className="events-empty">
              <CalendarDays aria-hidden="true" />
              <strong>
                {query || stage ? 'No events match those filters' : 'No event plans yet'}
              </strong>
              <p>
                {query || stage
                  ? 'Clear a filter or try another search.'
                  : 'The guided intake creates a complete communication plan without touching the IT task list.'}
              </p>
              {canCreate && !query && !stage ? (
                <Link search={{ view: 'open' }} to="/events/new">
                  Plan the first event
                </Link>
              ) : null}
            </div>
          ) : (
            <div className="events-table-wrap">
              <table className="events-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date</th>
                    <th>Stage</th>
                    <th>Readiness</th>
                    <th>Owner</th>
                    <th>
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((event) => (
                    <tr key={event.key}>
                      <td>
                        <Link
                          params={{ eventKey: event.key }}
                          search={{ view: 'open' }}
                          to="/events/$eventKey"
                        >
                          <strong>{event.title}</strong>
                          <span>
                            {event.reference} · {event.ministry}
                          </span>
                        </Link>
                      </td>
                      <td>
                        <strong>{dateLabel(event.startAt)}</strong>
                        <span>{event.location}</span>
                      </td>
                      <td>
                        <span className="events-stage-pill">{eventStageLabels[event.stage]}</span>
                      </td>
                      <td>
                        <div className="events-readiness-cell">
                          <div>
                            <span style={{ width: `${event.progress}%` }} />
                          </div>
                          <span className={`readiness-${event.readiness}`}>
                            {event.readiness === 'ready' ? 'Ready' : `${event.blockers} open`}
                          </span>
                        </div>
                      </td>
                      <td>{event.owner?.name ?? 'Unassigned'}</td>
                      <td>
                        <Link
                          aria-label={`Open ${event.title}`}
                          params={{ eventKey: event.key }}
                          search={{ view: 'open' }}
                          to="/events/$eventKey"
                        >
                          <ChevronRight aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
