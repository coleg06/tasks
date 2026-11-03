import { useState } from 'react';
import { useEventResponsibilityMutation } from '../api/queries';
import type { EventDetail, EventResponsibility } from '../api/types';
import './responsibilities.css';

export const responsibilityLabels: Record<string, string> = {
  communications: 'Communications',
  facilities: 'Facilities',
  production: 'Production / Technology',
  registration: 'Registration',
  finance: 'Finance',
  hospitality: 'Hospitality',
  transportation: 'Transportation',
  volunteers: 'Volunteers',
  safety_childcare: 'Safety / Childcare',
  other: 'Other',
};
const statusLabels: Record<EventResponsibility['status'], string> = {
  awaiting_acknowledgment: 'Awaiting acknowledgment',
  acknowledged: 'Acknowledged',
  blocked: 'Blocked',
  ready: 'Ready',
  not_needed: 'Not needed',
};

function ResponsibilityEditor({
  event,
  row,
  staff,
}: {
  event: EventDetail;
  row: EventResponsibility;
  staff: Array<{ id: number; email: string; name: string }>;
}) {
  const mutation = useEventResponsibilityMutation(event.key);
  const [owner, setOwner] = useState(row.owner_email ?? '');
  const [status, setStatus] = useState(row.status);
  const [notes, setNotes] = useState(row.notes);
  const [error, setError] = useState('');
  async function save() {
    try {
      await mutation.mutateAsync({
        action: 'patch',
        key: row.responsibility_key,
        patch: {
          expectedVersion: row.version,
          expectedFactsVersion: event.factsVersion,
          status,
          notes,
          ...(event.canEdit ? { ownerEmail: owner || null } : {}),
        },
      });
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save responsibility.');
    }
  }
  return (
    <article className="event-responsibility-row">
      <h3>{responsibilityLabels[row.area] ?? row.area}</h3>
      {event.canEdit ? (
        <label>
          Accountable owner
          <select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Choose an owner</option>
            {staff.map((person) => (
              <option key={person.id} value={person.email}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p>Accountable owner: {row.owner_name ?? 'Unassigned'}</p>
      )}
      <label>
        Readiness
        <select
          disabled={!row.canManage}
          value={status}
          onChange={(e) => setStatus(e.target.value as EventResponsibility['status'])}
        >
          {Object.entries(statusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Plan, blockers, or reason this area is not needed
        <textarea
          disabled={!row.canManage}
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <small>
        {row.reviewed_facts_version === event.factsVersion
          ? `Reviewed event facts v${event.factsVersion}`
          : 'Current event facts need review'}
      </small>
      {row.canManage ? (
        <button
          className="button-quiet"
          disabled={mutation.isPending}
          type="button"
          onClick={() => void save()}
        >
          Save responsibility
        </button>
      ) : null}
      {error ? (
        <p role="alert" className="event-inline-error">
          {error}
        </p>
      ) : null}
    </article>
  );
}

export function ResponsibilitiesPanel({
  event,
  staff,
}: {
  event: EventDetail;
  staff: Array<{ id: number; email: string; name: string }>;
}) {
  const mutation = useEventResponsibilityMutation(event.key);
  const [area, setArea] = useState('');
  const [error, setError] = useState('');
  const unused = Object.keys(responsibilityLabels).filter(
    (key) => !event.responsibilities.some((r) => r.area === key),
  );
  async function act(action: 'create' | 'convert') {
    try {
      await mutation.mutateAsync(action === 'convert' ? { action } : { action, area });
      setArea('');
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update workflow.');
    }
  }
  return (
    <section
      className="event-responsibilities event-workflow-card"
      aria-label="Accountable responsibilities"
    >
      <header>
        <div>
          <span>Accountable responsibilities</span>
          <strong>One owner for each area</strong>
        </div>
      </header>
      {event.workflowMode === 'legacy' ? (
        <div>
          <p>
            This event uses the previous generated checklist. Switching preserves every task,
            assignment, file, dependency, and approval. After switching, link any work you still
            require to a responsibility; unlinked legacy tasks stay visible and stop affecting
            readiness.
          </p>
          {event.canEdit ? (
            <button
              className="button-quiet"
              disabled={mutation.isPending}
              onClick={() => void act('convert')}
              type="button"
            >
              Switch to accountable responsibilities
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <p>
            Owners review the event details, record blockers, and create only the tasks their area
            needs. Mark an area ready when its required work is complete. Changes to event facts
            require a new review.
          </p>
          <div className="event-responsibility-grid">
            {event.responsibilities.map((row) => (
              <ResponsibilityEditor
                event={event}
                row={row}
                staff={staff}
                key={`${row.responsibility_key}:${row.version}:${event.factsVersion}`}
              />
            ))}
          </div>
          {event.canEdit && unused.length ? (
            <div className="event-responsibility-add">
              <label>
                Additional responsibility
                <select value={area} onChange={(e) => setArea(e.target.value)}>
                  <option value="">Choose an area</option>
                  {unused.map((key) => (
                    <option key={key} value={key}>
                      {responsibilityLabels[key]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button-quiet"
                disabled={!area || mutation.isPending}
                type="button"
                onClick={() => void act('create')}
              >
                Add responsibility
              </button>
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="event-inline-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function snapshotValue(value: unknown): React.ReactNode {
  if (value === null || value === '') return 'None provided';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.length ? value.map(String).join(', ') : 'None requested';
  if (typeof value === 'object')
    return (
      <dl>
        {Object.entries(value as Record<string, unknown>).map(([key, entry]) => (
          <div key={key}>
            <dt>
              {key.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())}
            </dt>
            <dd>{snapshotValue(entry)}</dd>
          </div>
        ))}
      </dl>
    );
  return String(value);
}

export function OriginalRequest({ event }: { event: EventDetail }) {
  return (
    <details className="event-original-request event-workflow-card">
      <summary>Original request · read only</summary>
      <p>
        {event.originalRequestKind === 'earliest_saved_facts'
          ? 'This legacy event has no preserved submission. These are its earliest saved facts.'
          : 'Preserved when the event was first received. Current event details and later changes are shown separately.'}
      </p>
      {event.originalRequest ? (
        snapshotValue(event.originalRequest)
      ) : (
        <p>No original request is available.</p>
      )}
    </details>
  );
}
