import * as Dialog from '@radix-ui/react-dialog';
import { Eye, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import {
  useAdminUserDetail,
  useBulkAdminUsers,
  useImpersonateAdminUser,
  useSetAdminUserRoles,
  useUpdateAdminUserProfile,
} from '../api/queries';
import type { AdminRole, AdminUserDetail, PermissionSource } from '../api/types';
import { Avatar } from '../ui/fields';
import { dateTime, errorText, shortDate } from './shared';

function sourceLabel(source: PermissionSource) {
  if (source.type === 'direct') return 'Granted directly';
  if (source.type === 'role') return `Role: ${source.label}`;
  return 'Platform admin';
}

function Detail({
  detail,
  roles,
  currentEmail,
  currentIsPlatformAdmin,
}: {
  detail: AdminUserDetail;
  roles: AdminRole[];
  currentEmail: string;
  currentIsPlatformAdmin: boolean;
}) {
  const { user } = detail;
  const isSelf = user.email.toLowerCase() === currentEmail.toLowerCase();
  const isAgent = user.principalType === 'agent';
  const setRoles = useSetAdminUserRoles();
  const bulk = useBulkAdminUsers();
  const profile = useUpdateAdminUserProfile();
  const impersonate = useImpersonateAdminUser();
  const heldKeys = detail.roles.map((role) => role.key);
  const [draft, setDraft] = useState<string[]>(heldKeys);
  const [email, setEmail] = useState(user.email);
  const [firstName, setFirstName] = useState(user.firstName);
  const [lastName, setLastName] = useState(user.lastName);
  const heldSignature = heldKeys.join('|');

  // Re-seed the editors when the server data changes (after a save, or another admin's edit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the saved values
  useEffect(() => {
    setDraft(heldKeys);
    setEmail(user.email);
    setFirstName(user.firstName);
    setLastName(user.lastName);
  }, [heldSignature, user.email, user.firstName, user.lastName]);

  // Managers cannot modify platform administrators; the server enforces it, the UI explains it.
  const locked = (detail.isPlatformAdmin && !currentIsPlatformAdmin) || isAgent;
  const dirty = draft.slice().sort().join('|') !== heldKeys.slice().sort().join('|');
  const byKey = new Map(roles.map((role) => [role.key, role]));

  async function saveRoles() {
    try {
      await setRoles.mutateAsync({ userId: user.id, roles: draft });
    } catch {
      // Rendered below.
    }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    try {
      await profile.mutateAsync({ userId: user.id, email, firstName, lastName });
    } catch {
      // Rendered below.
    }
  }

  async function toggleStatus() {
    const disabling = user.status === 'active';
    if (
      disabling &&
      !window.confirm(`Disable ${user.name}? They are signed out on their next request.`)
    ) {
      return;
    }
    try {
      await bulk.mutateAsync({ action: disabling ? 'disable' : 'enable', userIds: [user.id] });
    } catch {
      // Rendered below.
    }
  }

  const grouped = new Map<string, AdminUserDetail['effectivePermissions']>();
  for (const permission of detail.effectivePermissions) {
    const area = permission.key.split('.')[0] ?? 'other';
    grouped.set(area, [...(grouped.get(area) ?? []), permission]);
  }
  const areaLabels: Record<string, string> = {
    tasks: 'Tasks',
    events: 'Events',
    platform: 'Platform',
  };

  return (
    <div className="admin-drawer-body">
      <header className="admin-drawer-identity">
        <Avatar email={user.email} name={user.name} photoUrl={user.photoUrl} />
        <div>
          <Dialog.Title>{user.name}</Dialog.Title>
          <Dialog.Description>{user.email}</Dialog.Description>
          <div className="admin-drawer-badges">
            <span className={user.status === 'active' ? 'badge is-on' : 'badge'}>
              {user.status === 'active' ? 'Active' : 'Disabled'}
            </span>
            {detail.isPlatformAdmin ? (
              <span className="badge is-accent">Platform admin</span>
            ) : null}
            {isAgent ? <span className="badge">Automation</span> : null}
          </div>
        </div>
        <Dialog.Close aria-label="Close" className="icon-button" type="button">
          <X />
        </Dialog.Close>
      </header>

      <div className="admin-drawer-actions">
        <button
          className="button-quiet"
          disabled={isSelf || user.status !== 'active' || impersonate.isPending || locked}
          onClick={() => {
            if (
              window.confirm(
                `View Tasks as ${user.name}? A banner will let you return to your account.`,
              )
            ) {
              impersonate.mutate(user.id);
            }
          }}
          type="button"
        >
          <Eye aria-hidden="true" /> View as this person
        </button>
        <button
          className="button-quiet"
          disabled={isSelf || locked || bulk.isPending}
          onClick={() => void toggleStatus()}
          type="button"
        >
          {user.status === 'active' ? 'Disable' : 'Enable'}
        </button>
      </div>
      {bulk.isError ? (
        <p className="form-message is-error" role="alert">
          {errorText(bulk.error)}
        </p>
      ) : null}
      {locked && !isAgent ? (
        <p className="admin-note">
          This person is a platform administrator. Only another platform administrator can change
          their access.
        </p>
      ) : null}

      <section className="admin-drawer-section">
        <h3>Roles</h3>
        <p className="admin-muted">
          A role is a named set of permissions. Changes take effect on their next request. Once a
          person has a role, their roles alone decide whether they can view and comment on tasks,
          keep personal tasks and use events: Viewer is read-only, and removing Member takes that
          access away. Assigning a role removes the separate standard access they had before.
        </p>
        <div className="admin-role-picker-grid">
          {roles.map((role) => {
            const blocked = locked || !role.assignable;
            return (
              <label className={blocked ? 'is-disabled' : undefined} key={role.key}>
                <input
                  checked={draft.includes(role.key)}
                  disabled={blocked}
                  onChange={(event) =>
                    setDraft(
                      event.target.checked
                        ? [...draft, role.key]
                        : draft.filter((key) => key !== role.key),
                    )
                  }
                  type="checkbox"
                />
                <span>
                  <strong>{role.label}</strong>
                  <small>
                    {!role.assignable
                      ? 'You cannot change a role that gives access you do not hold.'
                      : role.description}
                  </small>
                </span>
              </label>
            );
          })}
        </div>
        {dirty && draft.length === 0 && heldKeys.length > 0 ? (
          <p className="form-message" role="status">
            This removes the person's last role. They keep only the individual grants they still
            have, and the standard access (view, comment, personal tasks, events) may return the
            next time they sign in.
          </p>
        ) : null}
        {setRoles.isError ? (
          <p className="form-message is-error" role="alert">
            {errorText(setRoles.error)}
          </p>
        ) : null}
        <div className="admin-drawer-save">
          <button
            className="button-primary"
            disabled={!dirty || locked || setRoles.isPending}
            onClick={() => void saveRoles()}
            type="button"
          >
            {setRoles.isPending ? 'Saving…' : 'Save roles'}
          </button>
          {dirty ? (
            <button className="button-quiet" onClick={() => setDraft(heldKeys)} type="button">
              Reset
            </button>
          ) : null}
        </div>
      </section>

      <section className="admin-drawer-section">
        <h3>Effective access</h3>
        <p className="admin-muted">
          Everything this person can do, and where each permission comes from.
        </p>
        {detail.effectivePermissions.length === 0 ? (
          <p className="admin-muted">No permissions.</p>
        ) : (
          [...grouped.entries()].map(([area, permissions]) => (
            <div className="admin-perm-group" key={area}>
              <h4>{areaLabels[area] ?? area}</h4>
              <ul>
                {permissions.map((permission) => (
                  <li key={permission.key}>
                    <span>{permission.label}</span>
                    <span className="admin-perm-sources">
                      {permission.sources.map((source) => (
                        <span
                          className={`badge${source.type === 'direct' ? '' : source.type === 'role' ? ' is-info' : ' is-accent'}`}
                          key={sourceLabel(source)}
                        >
                          {sourceLabel(source)}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        {detail.directPermissions.length ? (
          <p className="admin-muted">
            {detail.directPermissions.length} direct{' '}
            {detail.directPermissions.length === 1 ? 'grant' : 'grants'} (set before roles existed
            or through the legacy controls) stay in effect alongside roles.
          </p>
        ) : null}
        {detail.roles.length ? (
          <ul className="admin-grant-history">
            {detail.roles.map((role) => (
              <li key={role.key}>
                <strong>{byKey.get(role.key)?.label ?? role.label}</strong> since{' '}
                {shortDate(role.grantedAt)}
                {role.grantedBy?.name ? ` · granted by ${role.grantedBy.name}` : ''}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {tenantProfile.tasks.projectAdministration ? (
        <section className="admin-drawer-section">
          <h3>Project memberships</h3>
          {detail.projects.length ? (
            <ul className="admin-grant-history">
              {detail.projects.map((project) => (
                <li key={project.key}>
                  <strong>{project.name}</strong> · {project.key} ·{' '}
                  <span className="admin-capitalize">{project.role}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="admin-muted">Not a member of any shared project.</p>
          )}
        </section>
      ) : null}

      <section className="admin-drawer-section">
        <h3>Details</h3>
        <dl className="admin-facts">
          <div>
            <dt>Last sign-in</dt>
            <dd>{dateTime(user.lastSeenAt, 'Has not signed in yet')}</dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd>{dateTime(user.createdAt)}</dd>
          </div>
        </dl>
        <form className="admin-user-form" onSubmit={(event) => void saveProfile(event)}>
          <label>
            <span>First name</span>
            <input
              disabled={locked}
              onChange={(event) => setFirstName(event.target.value)}
              value={firstName}
            />
          </label>
          <label>
            <span>Last name</span>
            <input
              disabled={locked}
              onChange={(event) => setLastName(event.target.value)}
              value={lastName}
            />
          </label>
          <label className="is-wide">
            <span>Email</span>
            <input
              disabled={user.hasSignedIn || locked}
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
            {user.hasSignedIn ? (
              <small>{tenantProfile.identity.providerLabel}-linked emails cannot be renamed.</small>
            ) : null}
          </label>
          {profile.isError ? (
            <p className="form-message is-error" role="alert">
              {errorText(profile.error)}
            </p>
          ) : null}
          <div className="is-wide">
            <button
              className="button-primary"
              disabled={
                locked ||
                profile.isPending ||
                (email === user.email && firstName === user.firstName && lastName === user.lastName)
              }
              type="submit"
            >
              {profile.isPending ? 'Saving…' : 'Save details'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

/** Side panel with everything about one person: roles, effective access and details. */
export function UserDetailPanel({
  userId,
  roles,
  onClose,
  currentEmail,
  currentIsPlatformAdmin,
}: {
  userId: number | null;
  roles: AdminRole[];
  onClose: () => void;
  currentEmail: string;
  currentIsPlatformAdmin: boolean;
}) {
  const detail = useAdminUserDetail(userId);
  return (
    <Dialog.Root onOpenChange={(open) => (open ? undefined : onClose())} open={userId !== null}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content aria-describedby={undefined} className="admin-drawer">
          {detail.data ? (
            <Detail
              currentEmail={currentEmail}
              currentIsPlatformAdmin={currentIsPlatformAdmin}
              detail={detail.data}
              roles={roles}
            />
          ) : (
            <div className="admin-drawer-body">
              <Dialog.Title className="admin-drawer-loading">
                {detail.isError ? 'Unable to load this person' : 'Loading…'}
              </Dialog.Title>
              <Dialog.Close aria-label="Close" className="icon-button" type="button">
                <X />
              </Dialog.Close>
              {detail.isError ? (
                <p className="form-message is-error">{errorText(detail.error)}</p>
              ) : null}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
