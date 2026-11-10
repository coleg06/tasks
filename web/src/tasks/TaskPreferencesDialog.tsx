import { useEffect, useState } from 'react';
import type { TenantProfile } from '../../../shared/tenant-profile';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useBootstrap, useEmailPreferences, useUpdateAccountPreferences } from '../api/queries';
import type {
  EmailDeliveryPreferences,
  TaskAlertPreferences,
  TaskCreationMode,
} from '../api/types';
import { Modal } from '../ui/Modal';

const choices: Array<{
  value: TaskCreationMode;
  label: string;
  description: string;
}> = [
  {
    value: 'guided',
    label: 'Guided creation',
    description: 'Open a side panel for the name, owner, due date, priority, and details.',
  },
  {
    value: 'quick',
    label: 'Quick add',
    description: 'Create from one line, with optional !priority, >date, and @assignee shortcuts.',
  },
];

const defaultEmail: EmailDeliveryPreferences = {
  hardLimit: 5,
  period: 'day',
  assignments: 'immediate',
  comments: 'immediate',
  mentions: 'immediate',
  deadlines: 'immediate',
};

const defaultNotifications: TaskAlertPreferences = {
  assignments: { email: true, inApp: false, push: false },
  comments: { email: true, inApp: false, push: false },
  mentions: { email: true, inApp: false, push: false },
  deadlines: { email: true, inApp: false, push: false },
};

const notificationChoices: Array<{
  key: keyof TaskAlertPreferences;
  label: string;
  description: string;
}> = [
  { key: 'assignments', label: 'Assignments', description: 'When work is assigned to you.' },
  { key: 'comments', label: 'Comments', description: 'New comments on work you own or created.' },
  { key: 'mentions', label: 'Mentions', description: 'When someone mentions you with @name.' },
  {
    key: 'deadlines',
    label: 'Deadlines',
    description: 'Three days, one day, and the day work is due.',
  },
];

const channels: Array<{
  key: keyof TaskAlertPreferences['assignments'];
  label: string;
  shortLabel: string;
}> = [
  { key: 'email', label: 'Email notifications', shortLabel: 'Email' },
  { key: 'inApp', label: 'Portal inbox alerts', shortLabel: 'Inbox' },
  { key: 'push', label: 'Portal push alerts', shortLabel: 'Push' },
];

export function notificationChannelsForCapabilities(capabilities: TenantProfile['capabilities']) {
  return channels.filter((channel) =>
    channel.key === 'email' ? capabilities.emailNotifications : capabilities.portalAlerts,
  );
}

export function notificationPreferencesForCapabilities(
  preferences: TaskAlertPreferences,
  capabilities: TenantProfile['capabilities'],
): TaskAlertPreferences {
  const available = new Set(
    notificationChannelsForCapabilities(capabilities).map((channel) => channel.key),
  );
  return Object.fromEntries(
    Object.entries(preferences).map(([event, values]) => [
      event,
      {
        email: available.has('email') ? values.email : false,
        inApp: available.has('inApp') ? values.inApp : false,
        push: available.has('push') ? values.push : false,
      },
    ]),
  ) as TaskAlertPreferences;
}

export function TaskPreferencesDialog({
  onOpenChange,
  open,
  showTaskCreation,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  showTaskCreation: boolean;
}) {
  const bootstrap = useBootstrap();
  const emailQuery = useEmailPreferences(open && tenantProfile.capabilities.emailNotifications);
  const savedEmail = emailQuery.data?.preferences ?? defaultEmail;
  const [email, setEmail] = useState<EmailDeliveryPreferences>(savedEmail);
  const platformCap = emailQuery.data?.settings.perMinute ?? 5;
  const emailUnavailable = tenantProfile.capabilities.emailNotifications && !emailQuery.data;
  const emailInvalid =
    !Number.isInteger(email.hardLimit) || email.hardLimit < 0 || email.hardLimit > 1000;
  const update = useUpdateAccountPreferences();
  const resetUpdate = update.reset;
  const savedMode = bootstrap.data?.user?.task_creation_mode ?? 'guided';
  const savedNotifications = bootstrap.data?.user?.task_alert_preferences ?? defaultNotifications;
  const enabledChannels = notificationChannelsForCapabilities(tenantProfile.capabilities);
  const [mode, setMode] = useState<TaskCreationMode>(savedMode);
  const [notifications, setNotifications] = useState<TaskAlertPreferences>(savedNotifications);

  useEffect(() => {
    if (open) {
      setMode(savedMode);
      setEmail(savedEmail);
      setNotifications(savedNotifications);
      resetUpdate();
    }
  }, [open, savedMode, savedNotifications, savedEmail, resetUpdate]);

  const nothingToConfigure = !showTaskCreation && enabledChannels.length === 0;
  const dirty =
    (showTaskCreation && mode !== savedMode) ||
    (tenantProfile.capabilities.emailNotifications &&
      JSON.stringify(email) !== JSON.stringify(savedEmail)) ||
    JSON.stringify(
      notificationPreferencesForCapabilities(notifications, tenantProfile.capabilities),
    ) !==
      JSON.stringify(
        notificationPreferencesForCapabilities(savedNotifications, tenantProfile.capabilities),
      );

  function save() {
    update.mutate(
      {
        taskCreationMode: mode,
        ...(tenantProfile.capabilities.emailNotifications ? { emailDelivery: email } : {}),
        notificationAlerts: notificationPreferencesForCapabilities(
          notifications,
          tenantProfile.capabilities,
        ),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  }

  const description = showTaskCreation
    ? enabledChannels.length
      ? 'Choose how you create tasks and where workflow alerts are delivered.'
      : 'Choose how you create tasks.'
    : enabledChannels.length
      ? 'Choose where workflow alerts are delivered.'
      : 'No task preferences are available for this service.';

  return (
    <Modal
      className="preferences-dialog"
      description={description}
      onOpenChange={onOpenChange}
      open={open}
      title="Preferences"
    >
      <form
        className="preferences-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty && !update.isPending && !emailUnavailable && !emailInvalid) save();
        }}
      >
        <div className="preferences-body">
          {showTaskCreation ? (
            <fieldset className="preferences-section">
              <legend>Creating tasks</legend>
              <div className="preferences-choices">
                {choices.map((choice) => (
                  <label className="preferences-choice" key={choice.value}>
                    <input
                      checked={mode === choice.value}
                      name="task-creation-mode"
                      onChange={() => setMode(choice.value)}
                      type="radio"
                      value={choice.value}
                    />
                    <span className="preferences-choice-text">
                      <strong>{choice.label}</strong>
                      <small>{choice.description}</small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}

          {tenantProfile.capabilities.emailNotifications ? (
            <section className="preferences-section" aria-labelledby="email-limits-heading">
              <h3 id="email-limits-heading">Email limits</h3>
              <p className="preferences-note">
                Your default is five emails per rolling day. This deployment allows at most{' '}
                {platformCap} emails per rolling minute across all recipients. Excess emails and
                summaries are permanently suppressed.
              </p>
              {emailQuery.error ? (
                <p className="form-error" role="alert">
                  Unable to load email preferences. Reopen Preferences to retry.
                </p>
              ) : emailUnavailable ? (
                <p>Loading email preferences…</p>
              ) : null}
              <label>
                My maximum emails (zero disables email)
                <input
                  type="number"
                  min={0}
                  max={1000}
                  required
                  value={email.hardLimit}
                  onChange={(event) =>
                    setEmail((current) => ({ ...current, hardLimit: event.target.valueAsNumber }))
                  }
                />
              </label>
              <label>
                Rolling limit period
                <select
                  value={email.period}
                  onChange={(event) =>
                    setEmail((current) => ({
                      ...current,
                      period: event.target.value as EmailDeliveryPreferences['period'],
                    }))
                  }
                >
                  <option value="hour">Hour</option>
                  <option value="day">Day</option>
                  <option value="week">Week</option>
                </select>
              </label>
              <p className="preferences-note">
                Hourly, daily, and weekly choices combine categories into one summary per selected
                UTC interval, with up to 25 accessible items. Daily summaries run at midnight UTC;
                weekly summaries run Monday at midnight UTC. Missed or blocked summaries are
                discarded.
              </p>
            </section>
          ) : null}
          {enabledChannels.length ? (
            <section aria-labelledby="preferences-alerts-heading" className="preferences-section">
              <h3 id="preferences-alerts-heading">Workflow alerts</h3>
              <table className="preferences-matrix">
                <thead>
                  <tr>
                    <th className="preferences-column" scope="col">
                      <span className="sr-only">Alert</span>
                    </th>
                    {enabledChannels.map((channel) => (
                      <th
                        className="preferences-column"
                        key={channel.key}
                        scope="col"
                        title={channel.label}
                      >
                        {channel.shortLabel}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {notificationChoices.map((choice) => (
                    <tr key={choice.key}>
                      <th className="preferences-row-label" scope="row">
                        <strong>{choice.label}</strong>
                        <small>{choice.description}</small>
                      </th>
                      {enabledChannels.map((channel) => (
                        <td className="preferences-cell" key={channel.key}>
                          {channel.key === 'email' ? (
                            <select
                              aria-label={`Email frequency for ${choice.label}`}
                              value={email[choice.key]}
                              onChange={(event) => {
                                const frequency = event.target
                                  .value as EmailDeliveryPreferences['assignments'];
                                setEmail((current) => ({ ...current, [choice.key]: frequency }));
                                setNotifications((current) => ({
                                  ...current,
                                  [choice.key]: {
                                    ...current[choice.key],
                                    email: frequency !== 'off',
                                  },
                                }));
                              }}
                            >
                              <option value="immediate">Immediate</option>
                              <option value="hourly">Hourly</option>
                              <option value="daily">Daily</option>
                              <option value="weekly">Weekly</option>
                              <option value="off">Off</option>
                            </select>
                          ) : (
                            <label className="preferences-toggle">
                              <input
                                aria-label={`${channel.shortLabel} for ${choice.label}`}
                                checked={notifications[choice.key][channel.key]}
                                onChange={(event) =>
                                  setNotifications((current) => ({
                                    ...current,
                                    [choice.key]: {
                                      ...current[choice.key],
                                      [channel.key]: event.target.checked,
                                    },
                                  }))
                                }
                                type="checkbox"
                              />
                              <span aria-hidden="true" className="preferences-toggle-label">
                                {channel.shortLabel}
                              </span>
                            </label>
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : showTaskCreation ? (
            <p className="preferences-note">Alert delivery is not enabled for this service.</p>
          ) : null}
        </div>

        <div className="preferences-footer">
          {update.error ? (
            <p className="form-error" role="alert">
              {update.error.message}
            </p>
          ) : (
            <p aria-live="polite" className="preferences-status">
              {dirty ? 'Unsaved changes' : ''}
            </p>
          )}
          <button className="button-quiet" onClick={() => onOpenChange(false)} type="button">
            {nothingToConfigure ? 'Close' : 'Cancel'}
          </button>
          {nothingToConfigure ? null : (
            <button
              className="button-primary"
              disabled={
                !dirty ||
                update.isPending ||
                emailUnavailable ||
                (tenantProfile.capabilities.emailNotifications && emailInvalid)
              }
              type="submit"
            >
              {update.isPending ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
