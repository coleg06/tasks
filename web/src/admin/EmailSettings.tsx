import { useEffect, useState } from 'react';
import { useEmailSettings, useUpdateEmailSettings } from '../api/queries';

export function EmailSettings() {
  const settings = useEmailSettings(true);
  const update = useUpdateEmailSettings();
  const [cap, setCap] = useState(5);
  useEffect(() => {
    if (settings.data) setCap(settings.data.settings.perMinute);
  }, [settings.data]);
  return (
    <section className="admin-section">
      <h2>Email limits</h2>
      <p>
        The cap covers all workflow email in this deployment, including digests. Excess mail is
        permanently suppressed. Zero disables sending.
      </p>
      {settings.isPending ? (
        <p>Loading email settings…</p>
      ) : settings.error ? (
        <p role="alert">{settings.error.message}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            update.mutate(cap);
          }}
        >
          <label>
            Maximum emails per rolling minute{' '}
            <input
              type="number"
              min={0}
              max={1000}
              required
              value={cap}
              onChange={(event) => setCap(event.target.valueAsNumber)}
            />
          </label>
          <button
            className="button-primary"
            type="submit"
            disabled={
              !Number.isInteger(cap) ||
              cap < 0 ||
              cap > 1000 ||
              update.isPending ||
              cap === settings.data?.settings.perMinute
            }
          >
            Save email limit
          </button>
          {update.error ? (
            <p role="alert">{update.error.message}</p>
          ) : update.isSuccess ? (
            <p role="status">Email limit saved.</p>
          ) : null}
        </form>
      )}
    </section>
  );
}
