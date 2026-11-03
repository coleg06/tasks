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
    description: 'Open a side panel for the task name, owner, due date, priority, and details.',
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
}> = [
  { key: 'email', label: 'Email notifications' },
  { key: 'inApp', label: 'Portal inbox alerts' },
  { key: 'push', label: 'Portal push alerts' },
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
  const savedMode = bootstrap.data?.user?.task_creation_mode ?? 'guided';
  const savedNotifications = bootstrap.data?.user?.task_alert_preferences ?? defaultNotifications;
  const enabledChannels = notificationChannelsForCapabilities(tenantProfile.capabilities);
  const [mode, setMode] = useState<TaskCreationMode>(savedMode);
  const [notifications, setNotifications] = useState<TaskAlertPreferences>(savedNotifications);

  useEffect(() => {
    if (open) {
      setMode(savedMode);
      setNotifications(savedNotifications);
    }
  }, [open, savedMode, savedNotifications]);

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
    <Modal description={description} onOpenChange={onOpenChange} open={open} title="Preferences">
      {showTaskCreation ? (
        <fieldset className="preference-options">
          <legend>Task creation</legend>
          {choices.map((choice) => (
            <label className={mode === choice.value ? 'is-selected' : ''} key={choice.value}>
              <input
                checked={mode === choice.value}
                name="task-creation-mode"
                onChange={() => setMode(choice.value)}
                type="radio"
                value={choice.value}
              />
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {enabledChannels.map((channel) => (
        <fieldset className="preference-options notification-preferences" key={channel.key}>
          <legend>{channel.label}</legend>
          {notificationChoices.map((choice) => (
            <label
              className={notifications[choice.key][channel.key] ? 'is-selected' : ''}
              key={choice.key}
            >
              <input
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
              <span>
                <strong>{choice.label}</strong>
                <small>{choice.description}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
      {!enabledChannels.length ? (
        <p className="admin-muted">Notification delivery is not enabled for this service.</p>
      ) : null}
      {update.error ? (
        <p className="form-error" role="alert">
          {update.error.message}
        </p>
      ) : null}
      <div className="modal-actions">
        <button className="button-quiet" onClick={() => onOpenChange(false)} type="button">
          Cancel
        </button>
        <button className="button-primary" disabled={update.isPending} onClick={save} type="button">
          {update.isPending ? 'Saving…' : 'Save preference'}
        </button>
      </div>
    </Modal>
  );
}
