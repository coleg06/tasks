import { ChevronLeft, ChevronRight, FilterX } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAdminAudit } from '../api/queries';
import type { AuditEvent, AuditFilters } from '../api/types';
import { dateTime, errorText, useDebounced } from './shared';

const emptyFilters = { actor: '', target: '', action: '', from: '', to: '' };

function actionTitle(action: string) {
  return action.replaceAll('.', ' ').replaceAll('_', ' ');
}

/** One-line plain-language summary of a before/after change, when the shape is familiar. */
function summarize(event: AuditEvent) {
  const { before, after } = event.changes as {
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
  const roles = (value: Record<string, unknown> | null | undefined) =>
    Array.isArray(value?.roles) ? (value.roles as string[]) : null;
  const beforeRoles = roles(before);
  const afterRoles = roles(after);
  if (beforeRoles && afterRoles) {
    const added = afterRoles.filter((role) => !beforeRoles.includes(role));
    const removed = beforeRoles.filter((role) => !afterRoles.includes(role));
    return [
      added.length ? `Added ${added.join(', ')}` : '',
      removed.length ? `Removed ${removed.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (typeof before?.status === 'string' && typeof after?.status === 'string') {
    return `Status ${before.status} → ${after.status}`;
  }
  if (event.action.startsWith('role.')) {
    const permissions = (value: Record<string, unknown> | null | undefined) =>
      Array.isArray(value?.permissions) ? (value.permissions as string[]) : [];
    const was = permissions(before);
    const now = permissions(after);
    const added = now.filter((key) => !was.includes(key));
    const removed = was.filter((key) => !now.includes(key));
    return [
      added.length ? `Added ${added.join(', ')}` : '',
      removed.length ? `Removed ${removed.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  return '';
}

export function AuditTab() {
  const [draft, setDraft] = useState(emptyFilters);
  const [cursors, setCursors] = useState<string[]>([]);
  const debounced = useDebounced(draft, 300);
  const filters = useMemo<AuditFilters>(
    () => ({ ...debounced, cursor: cursors.at(-1) ?? '' }),
    [debounced, cursors],
  );
  const audit = useAdminAudit(filters);
  const [actions, setActions] = useState<string[]>([]);

  // The list of known actions arrives with the first page of each query.
  useEffect(() => {
    if (audit.data?.actions) setActions(audit.data.actions);
  }, [audit.data?.actions]);
  // A changed filter starts again from the newest events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when a filter changes
  useEffect(() => setCursors([]), [debounced]);

  const events = audit.data?.events ?? [];
  const filtered = Object.values(draft).some(Boolean);
  const families = [...new Set(actions.map((action) => action.split('.')[0] ?? action))];

  return (
    <section aria-label="Audit log" className="admin-audit">
      <div className="admin-section-heading">
        <div>
          <h2>Audit log</h2>
          <p>
            Every access change, with who made it, who it affected and what changed. Records cannot
            be edited or deleted.
          </p>
        </div>
      </div>
      <div className="admin-audit-filters">
        <label>
          <span>Who did it</span>
          <input
            onChange={(event) => setDraft({ ...draft, actor: event.target.value })}
            placeholder="Name or email"
            type="search"
            value={draft.actor}
          />
        </label>
        <label>
          <span>Affected</span>
          <input
            onChange={(event) => setDraft({ ...draft, target: event.target.value })}
            placeholder="Person, role:key or project"
            type="search"
            value={draft.target}
          />
        </label>
        <label>
          <span>Action</span>
          <select
            onChange={(event) => setDraft({ ...draft, action: event.target.value })}
            value={draft.action}
          >
            <option value="">Any action</option>
            {families.map((family) => (
              <optgroup key={family} label={`${family} (all)`}>
                <option value={family}>All {family} actions</option>
                {actions
                  .filter((action) => action.startsWith(`${family}.`))
                  .map((action) => (
                    <option key={action} value={action}>
                      {actionTitle(action)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          <span>From</span>
          <input
            max={draft.to || undefined}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
            type="date"
            value={draft.from}
          />
        </label>
        <label>
          <span>To</span>
          <input
            min={draft.from || undefined}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
            type="date"
            value={draft.to}
          />
        </label>
        {filtered ? (
          <button className="button-quiet" onClick={() => setDraft(emptyFilters)} type="button">
            <FilterX aria-hidden="true" /> Clear
          </button>
        ) : null}
      </div>

      {audit.isError ? (
        <p className="form-message is-error" role="alert">
          Unable to load the audit log. {errorText(audit.error, '')}
        </p>
      ) : null}

      {events.length ? (
        <div className="admin-events">
          {events.map((event) => {
            const summary = summarize(event);
            return (
              <article key={event.id}>
                <div className="admin-event-head">
                  <strong>{actionTitle(event.action)}</strong>
                  <span className="admin-muted">{event.entityKey}</span>
                  <span className="admin-muted">by {event.actor.name}</span>
                  <time className="admin-muted admin-event-time" dateTime={event.createdAt}>
                    {dateTime(event.createdAt)}
                  </time>
                </div>
                {summary ? <p className="admin-event-summary">{summary}</p> : null}
                {event.redacted ? (
                  <p className="admin-muted">
                    Details hidden: they may belong to a private project.
                  </p>
                ) : (
                  <details>
                    <summary>Before and after</summary>
                    <pre>{JSON.stringify(event.changes, null, 2)}</pre>
                  </details>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="admin-empty">
          {audit.isLoading
            ? 'Loading…'
            : filtered
              ? 'No records match those filters.'
              : 'New changes will appear here.'}
        </p>
      )}

      <div className="admin-pager">
        <span className="admin-muted">{events.length ? `Page ${cursors.length + 1}` : ''}</span>
        <div className="admin-pager-actions">
          <button
            className="button-quiet"
            disabled={cursors.length === 0 || audit.isFetching}
            onClick={() => setCursors((current) => current.slice(0, -1))}
            type="button"
          >
            <ChevronLeft aria-hidden="true" /> Newer
          </button>
          <button
            className="button-quiet"
            disabled={audit.data?.nextCursor == null || audit.isFetching}
            onClick={() => {
              const next = audit.data?.nextCursor;
              if (next != null) setCursors((current) => [...current, String(next)]);
            }}
            type="button"
          >
            Older <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
