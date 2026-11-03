import { CheckCircle2, CircleAlert, UserPlus } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useBulkInviteAdminUsers, useInviteAdminUser } from '../api/queries';
import type { AdminRole, InviteRow, InviteRowStatus } from '../api/types';
import { Modal } from '../ui/Modal';
import { parseInviteList } from './parseInvites';
import { errorText } from './shared';

const rowMessages: Record<InviteRowStatus, string> = {
  ok: 'Ready to invite',
  invalid_email: tenantProfile.identity.hostedDomain
    ? `Not a valid @${tenantProfile.identity.hostedDomain} address`
    : 'Not a valid email address',
  duplicate: 'Listed more than once',
  exists: 'Already has an account',
};

function RolePicker({
  roles,
  selected,
  onChange,
  canAssignPlatformAdmin,
}: {
  roles: AdminRole[];
  selected: string[];
  onChange: (next: string[]) => void;
  canAssignPlatformAdmin: boolean;
}) {
  return (
    <fieldset className="admin-role-picker">
      <legend>Roles</legend>
      <p className="admin-muted">
        With no role, a person gets the standard access: view and comment on tasks, personal tasks
        and events. With a role, the roles alone decide that access (Viewer is read-only). You can
        change roles later.
      </p>
      <div className="admin-role-picker-grid">
        {roles.map((role) => {
          const blocked = !role.assignable || (role.grantsAll && !canAssignPlatformAdmin);
          return (
            <label className={blocked ? 'is-disabled' : undefined} key={role.key}>
              <input
                checked={selected.includes(role.key)}
                disabled={blocked}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, role.key]
                      : selected.filter((key) => key !== role.key),
                  )
                }
                type="checkbox"
              />
              <span>
                <strong>{role.label}</strong>
                <small>
                  {blocked ? 'You cannot give out access you do not hold.' : role.description}
                </small>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function InviteDialog({
  open,
  onOpenChange,
  roles,
  canAssignPlatformAdmin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: AdminRole[];
  canAssignPlatformAdmin: boolean;
}) {
  const [mode, setMode] = useState<'one' | 'many'>('one');
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [list, setList] = useState('');
  const [selectedRoles, setSelectedRoles] = useState<string[]>([]);
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const invite = useInviteAdminUser();
  const bulkInvite = useBulkInviteAdminUsers();
  const resetInvite = invite.reset;
  const resetBulkInvite = bulkInvite.reset;

  // Start clean every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setMode('one');
    setEmail('');
    setFirstName('');
    setLastName('');
    setList('');
    setSelectedRoles([]);
    setRows(null);
    resetInvite();
    resetBulkInvite();
  }, [open, resetInvite, resetBulkInvite]);

  const entries = useMemo(() => parseInviteList(list), [list]);
  const validRows = rows?.filter((row) => row.status === 'ok') ?? [];
  const inviteUrl = invite.data
    ? `${window.location.origin}${invite.data.signInPath}`
    : `${window.location.origin}/auth/login?returnTo=%2F`;
  const workspaceName = `${tenantProfile.organizationName} ${tenantProfile.productName}`;
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(workspaceName)}&body=${encodeURIComponent(`You can sign in to ${workspaceName} with your ${tenantProfile.organizationName} ${tenantProfile.identity.providerLabel} account:\n\n${inviteUrl}`)}`;

  async function submitOne(event: FormEvent) {
    event.preventDefault();
    try {
      await invite.mutateAsync({
        email,
        firstName,
        lastName,
        hasTaskAccess: false,
        isManager: false,
        isEventManager: false,
        canApproveEvents: false,
        isPlatformAdmin: false,
        roles: selectedRoles,
      });
    } catch {
      // Rendered from invite.error.
    }
  }

  async function review() {
    setRows(null);
    try {
      const result = await bulkInvite.mutateAsync({
        entries,
        roles: selectedRoles,
        dryRun: true,
      });
      setRows(result.rows ?? []);
    } catch {
      // Rendered from bulkInvite.error.
    }
  }

  async function createAll() {
    try {
      await bulkInvite.mutateAsync({
        entries: validRows.map(({ email: address, firstName: first, lastName: last }) => ({
          email: address,
          firstName: first,
          lastName: last,
        })),
        roles: selectedRoles,
        dryRun: false,
      });
    } catch {
      // Rendered from bulkInvite.error.
    }
  }

  const created = mode === 'many' && bulkInvite.data?.created !== undefined;

  return (
    <Modal
      className="admin-dialog"
      description="Pre-authorize their account and choose what they can do. They sign in the usual way."
      onOpenChange={onOpenChange}
      open={open}
      title="Invite people"
    >
      <div className="admin-segmented" role="tablist" aria-label="Invite one person or several">
        <button
          aria-selected={mode === 'one'}
          onClick={() => setMode('one')}
          role="tab"
          type="button"
        >
          One person
        </button>
        <button
          aria-selected={mode === 'many'}
          onClick={() => setMode('many')}
          role="tab"
          type="button"
        >
          Paste a list
        </button>
      </div>

      {mode === 'one' ? (
        invite.isSuccess ? (
          <div className="admin-invite-success">
            <CheckCircle2 aria-hidden="true" />
            <div>
              <strong>{email} is ready to sign in.</strong>
              <span>
                Their {tenantProfile.identity.providerLabel} name and picture refresh on first
                sign-in.
              </span>
            </div>
            <a className="button-primary" href={mailto}>
              Open email invitation
            </a>
          </div>
        ) : (
          <form className="admin-user-form" onSubmit={(event) => void submitOne(event)}>
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
                onChange={(event) => setEmail(event.target.value)}
                placeholder={`name@${tenantProfile.identity.hostedDomain || 'example.org'}`}
                required
                type="email"
                value={email}
              />
            </label>
            <div className="is-wide">
              <RolePicker
                canAssignPlatformAdmin={canAssignPlatformAdmin}
                onChange={setSelectedRoles}
                roles={roles}
                selected={selectedRoles}
              />
            </div>
            {invite.isError ? (
              <p className="form-message is-error" role="alert">
                {errorText(invite.error)}
              </p>
            ) : null}
            <div className="modal-actions is-wide">
              <button className="button-quiet" onClick={() => onOpenChange(false)} type="button">
                Cancel
              </button>
              <button className="button-primary" disabled={invite.isPending} type="submit">
                <UserPlus aria-hidden="true" /> {invite.isPending ? 'Inviting…' : 'Send invitation'}
              </button>
            </div>
          </form>
        )
      ) : created ? (
        <div className="admin-invite-success">
          <CheckCircle2 aria-hidden="true" />
          <div>
            <strong>
              {bulkInvite.data?.created}{' '}
              {bulkInvite.data?.created === 1 ? 'person is' : 'people are'} ready to sign in.
            </strong>
            <span>Share the sign-in link with them; roles are already applied.</span>
          </div>
          <button className="button-primary" onClick={() => onOpenChange(false)} type="button">
            Done
          </button>
        </div>
      ) : (
        <div className="admin-bulk-invite">
          <label className="admin-bulk-list">
            <span>One person per line</span>
            <textarea
              onChange={(event) => {
                setList(event.target.value);
                setRows(null);
              }}
              placeholder={
                'pat@example.org\nSam Example <sam@example.org>\nlee@example.org, Lee, Example'
              }
              rows={6}
              value={list}
            />
            <small>
              {entries.length
                ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} found (up to 200 at a time).`
                : 'Paste addresses, or “Name <address>” lines. Commas and semicolons separate addresses.'}
            </small>
          </label>
          <RolePicker
            canAssignPlatformAdmin={canAssignPlatformAdmin}
            onChange={(next) => {
              setSelectedRoles(next);
              setRows(null);
            }}
            roles={roles}
            selected={selectedRoles}
          />
          {rows ? (
            <ul className="admin-invite-preview" aria-label="Invitation preview">
              {rows.map((row) => (
                <li className={`admin-invite-row is-${row.status}`} key={row.index}>
                  {row.status === 'ok' ? (
                    <CheckCircle2 aria-hidden="true" />
                  ) : (
                    <CircleAlert aria-hidden="true" />
                  )}
                  <span className="admin-invite-row-email">{row.email || '(blank)'}</span>
                  <span className="admin-muted">
                    {[row.firstName, row.lastName].filter(Boolean).join(' ')}
                  </span>
                  <span className={row.status === 'ok' ? 'badge is-on' : 'badge is-error'}>
                    {rowMessages[row.status]}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {bulkInvite.isError ? (
            <p className="form-message is-error" role="alert">
              {errorText(bulkInvite.error)}
            </p>
          ) : null}
          <div className="modal-actions">
            <button className="button-quiet" onClick={() => onOpenChange(false)} type="button">
              Cancel
            </button>
            {rows ? (
              <button
                className="button-primary"
                disabled={validRows.length === 0 || bulkInvite.isPending}
                onClick={() => void createAll()}
                type="button"
              >
                <UserPlus aria-hidden="true" />
                {bulkInvite.isPending
                  ? 'Inviting…'
                  : `Invite ${validRows.length} ${validRows.length === 1 ? 'person' : 'people'}${
                      validRows.length < rows.length ? ' (skip the rest)' : ''
                    }`}
              </button>
            ) : (
              <button
                className="button-primary"
                disabled={entries.length === 0 || entries.length > 200 || bulkInvite.isPending}
                onClick={() => void review()}
                type="button"
              >
                {bulkInvite.isPending ? 'Checking…' : 'Review list'}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
