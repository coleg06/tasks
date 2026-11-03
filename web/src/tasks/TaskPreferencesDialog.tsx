import { useEffect, useState } from 'react';
import type { TenantProfile } from '../../../shared/tenant-profile';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useBootstrap, useUpdateAccountPreferences } from '../api/queries';
import type { TaskAlertPreferences, TaskCreationMode } from '../api/types';
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
      setNotifications(savedNotifications);
      resetUpdate();
    }
  }, [open, savedMode, savedNotifications, resetUpdate]);

  const nothingToConfigure = !showTaskCreation && enabledChannels.length === 0;
  const dirty =
    (showTaskCreation && mode !== savedMode) ||
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
          if (dirty && !update.isPending) save();
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
            <button className="button-primary" disabled={!dirty || update.isPending} type="submit">
              {update.isPending ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}
