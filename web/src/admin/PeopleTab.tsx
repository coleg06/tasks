import { ChevronLeft, ChevronRight, Search, UserPlus, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useAdminDirectory, useAdminRoles, useBulkAdminUsers } from '../api/queries';
import type { BulkAction, DirectoryFilters, DirectoryUser } from '../api/types';
import { Avatar } from '../ui/fields';
import { InviteDialog } from './InviteDialog';
import { ActionMenu, errorText, RoleChips, shortDate, useDebounced } from './shared';
import { UserDetailPanel } from './UserDetailPanel';

const PAGE_SIZE = 50;

const bulkLabels: Record<BulkAction, string> = {
  add_roles: 'Add role',
  remove_roles: 'Remove role',
  set_roles: 'Set roles',
  disable: 'Disable',
  enable: 'Enable',
};

/** Searchable, filterable, server-paged directory of every person, with bulk actions. */
export function PeopleTab({
  currentEmail,
  currentIsPlatformAdmin,
}: {
  currentEmail: string;
  currentIsPlatformAdmin: boolean;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<DirectoryFilters['status']>('');
  const [role, setRole] = useState('');
  // Keyset pagination: the cursor of each page we have walked past, so "Previous" is exact.
  const [cursors, setCursors] = useState<string[]>([]);
  const [selected, setSelected] = useState<Map<number, DirectoryUser>>(new Map());
  const [openUserId, setOpenUserId] = useState<number | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search);

  const filters = useMemo<DirectoryFilters>(
    () => ({ q: debouncedSearch, status, role, cursor: cursors.at(-1) ?? '' }),
    [debouncedSearch, status, role, cursors],
  );
  const directory = useAdminDirectory(filters);
  const rolesQuery = useAdminRoles();
  const bulk = useBulkAdminUsers();
  const roles = rolesQuery.data?.roles ?? [];
  const roleMap = useMemo(() => new Map(roles.map((entry) => [entry.key, entry])), [roles]);
  const page = directory.data;
  const users = page?.users ?? [];

  // A new search or filter starts from the first page and drops the selection it no longer shows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when a filter changes
  useEffect(() => {
    setCursors([]);
    setSelected(new Map());
  }, [debouncedSearch, status, role]);

  const pageStart = cursors.length * PAGE_SIZE + 1;
  const allOnPageSelected = users.length > 0 && users.every((user) => selected.has(user.id));
  const selectedUsers = [...selected.values()];

  function toggle(user: DirectoryUser) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(user.id)) next.delete(user.id);
      else next.set(user.id, user);
      return next;
    });
  }

  function togglePage() {
    setSelected((current) => {
      const next = new Map(current);
      if (allOnPageSelected) for (const user of users) next.delete(user.id);
      else for (const user of users) next.set(user.id, user);
      return next;
    });
  }

  async function runBulk(action: BulkAction, roleKey?: string) {
    const ids = selectedUsers.map((user) => user.id);
    if (ids.length === 0) return;
    const roleLabel = roleKey ? (roleMap.get(roleKey)?.label ?? roleKey) : '';
    // People whose only role is the one being removed.
    const lastRoleCount = roleKey
      ? selectedUsers.filter(
          (user) => user.roles.length > 0 && user.roles.every((key) => key === roleKey),
        ).length
      : 0;
    const message =
      action === 'disable'
        ? `Disable ${ids.length} ${ids.length === 1 ? 'person' : 'people'}? They are signed out on their next request.`
        : action === 'add_roles'
          ? `Add the ${roleLabel} role to ${ids.length} ${ids.length === 1 ? 'person' : 'people'}? Roles then decide whether they can view, comment and keep personal tasks: their separate standard access is removed.`
          : action === 'remove_roles'
            ? `Remove the ${roleLabel} role from ${ids.length} ${ids.length === 1 ? 'person' : 'people'}?${
                lastRoleCount
                  ? ` ${lastRoleCount} of them will have no role left and keep only the individual grants they still have.`
                  : ''
              }`
            : `Enable ${ids.length} ${ids.length === 1 ? 'person' : 'people'}?`;
    if (!window.confirm(message)) return;
    setNotice(null);
    try {
      const result = await bulk.mutateAsync({
        action,
        userIds: ids,
        ...(roleKey ? { roles: [roleKey] } : {}),
      });
      setNotice(
        `${bulkLabels[action]}: ${result.changed} changed${result.unchanged ? `, ${result.unchanged} already up to date` : ''}.`,
      );
      setSelected(new Map());
    } catch {
      // The error is rendered from bulk.error below; nothing was written.
    }
  }

  const assignableRoles = roles.filter((entry) => entry.assignable);
  const roleOptions = (list: typeof roles) =>
    list.map((entry) => ({ value: entry.key, label: entry.label, hint: entry.description }));
  const statusFilterOptions = [
    { value: '', label: 'Any status' },
    { value: 'active', label: 'Active' },
    { value: 'disabled', label: 'Disabled' },
  ];
  const roleFilterOptions = [
    { value: '', label: 'Any role' },
    ...roles.map((entry) => ({ value: entry.key, label: entry.label })),
  ];
  const filtered = Boolean(debouncedSearch || status || role);
  // Name the trigger with its current value, as a native select would announce it.
  const statusLabel =
    statusFilterOptions.find((option) => option.value === status)?.label ?? 'Any status';
  const roleLabel = roleFilterOptions.find((option) => option.value === role)?.label ?? 'Any role';

  return (
    <section aria-label="People" className="admin-people">
      <div className="admin-toolbar">
        <label className="admin-search">
          <Search aria-hidden="true" />
          <input
            aria-label="Search people by name or email"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or email"
            type="search"
            value={search}
          />
        </label>
        <ActionMenu
          ariaLabel={`Filter by status: ${statusLabel}`}
          onSelect={(value) => setStatus(value as DirectoryFilters['status'])}
          options={statusFilterOptions}
          value={status}
        >
          Status: {statusLabel}
        </ActionMenu>
        <ActionMenu
          ariaLabel={`Filter by role: ${roleLabel}`}
          onSelect={setRole}
          options={roleFilterOptions}
          value={role}
        >
          Role: {roleLabel}
        </ActionMenu>
        <button className="button-primary" onClick={() => setInviteOpen(true)} type="button">
          <UserPlus aria-hidden="true" /> Invite people
        </button>
      </div>

      {selected.size > 0 ? (
        <div className="admin-bulkbar" role="toolbar" aria-label="Actions for selected people">
          <strong>{selected.size} selected</strong>
          <ActionMenu
            ariaLabel="Add a role to the selected people"
            disabled={bulk.isPending || assignableRoles.length === 0}
            onSelect={(value) => void runBulk('add_roles', value)}
            options={roleOptions(assignableRoles)}
          >
            Add role
          </ActionMenu>
          <ActionMenu
            ariaLabel="Remove a role from the selected people"
            disabled={bulk.isPending || assignableRoles.length === 0}
            onSelect={(value) => void runBulk('remove_roles', value)}
            options={roleOptions(assignableRoles)}
          >
            Remove role
          </ActionMenu>
          <button
            className="button-quiet"
            disabled={bulk.isPending}
            onClick={() => void runBulk('disable')}
            type="button"
          >
            Disable
          </button>
          <button
            className="button-quiet"
            disabled={bulk.isPending}
            onClick={() => void runBulk('enable')}
            type="button"
          >
            Enable
          </button>
          <button
            aria-label="Clear selection"
            className="icon-button admin-bulkbar-clear"
            onClick={() => setSelected(new Map())}
            type="button"
          >
            <X />
          </button>
        </div>
      ) : null}
      {bulk.isError ? (
        <p className="form-message is-error" role="alert">
          {errorText(bulk.error)} Nothing was changed.
        </p>
      ) : null}
      {notice ? (
        <p className="form-message is-success" role="status">
          {notice}
        </p>
      ) : null}

      {directory.isError ? (
        <p className="form-message is-error" role="alert">
          Unable to load people. {errorText(directory.error, '')}
        </p>
      ) : null}

      <div className="admin-table admin-table-people">
        <div className="admin-table-header">
          <span>
            <input
              aria-label="Select everyone on this page"
              checked={allOnPageSelected}
              disabled={users.length === 0}
              onChange={togglePage}
              type="checkbox"
            />
          </span>
          <span>Person</span>
          <span>Roles</span>
          <span>Status</span>
          <span>Last sign-in</span>
        </div>
        {users.map((user) => {
          const isSelf = user.email.toLowerCase() === currentEmail.toLowerCase();
          return (
            <div
              className={`admin-table-row${selected.has(user.id) ? ' is-selected' : ''}`}
              key={user.id}
            >
              <span>
                <input
                  aria-label={`Select ${user.email}`}
                  checked={selected.has(user.id)}
                  disabled={isSelf || user.principalType === 'agent'}
                  onChange={() => toggle(user)}
                  type="checkbox"
                />
              </span>
              <button
                className="admin-identity admin-row-open"
                onClick={() => setOpenUserId(user.id)}
                type="button"
              >
                <Avatar email={user.email} name={user.name} photoUrl={user.photoUrl} />
                <span>
                  <strong>
                    {user.name}
                    {isSelf ? <em className="admin-you"> you</em> : null}
                  </strong>
                  <small>
                    {user.email} ·{' '}
                    {user.principalType === 'agent'
                      ? 'Automation'
                      : user.hasSignedIn
                        ? `${tenantProfile.identity.providerLabel} connected`
                        : 'Invited'}
                  </small>
                </span>
              </button>
              <span className="admin-roles-cell">
                {user.isPlatformAdmin && !user.roles.includes('admin') ? (
                  <span className="badge is-accent role-chip">Platform admin</span>
                ) : null}
                {user.isPlatformAdmin && user.roles.length === 0 ? null : (
                  <RoleChips
                    keys={user.roles}
                    limit={user.isPlatformAdmin && !user.roles.includes('admin') ? 1 : 2}
                    roles={roleMap}
                  />
                )}
              </span>
              <span>
                <span className={user.status === 'active' ? 'badge is-on' : 'badge'}>
                  {user.status === 'active' ? 'Active' : 'Disabled'}
                </span>
              </span>
              <span className="admin-muted">{shortDate(user.lastSeenAt)}</span>
            </div>
          );
        })}
        {directory.isLoading ? <p className="admin-empty">Loading people…</p> : null}
        {!directory.isLoading && users.length === 0 ? (
          <p className="admin-empty">
            {filtered ? 'No one matches those filters.' : 'No one has been added yet.'}
          </p>
        ) : null}
      </div>

      <div className="admin-pager">
        <span className="admin-muted" aria-live="polite">
          {page && users.length
            ? `${pageStart.toLocaleString()}–${(pageStart + users.length - 1).toLocaleString()} of ${page.total.toLocaleString()}`
            : page
              ? '0 people'
              : ''}
        </span>
        <div className="admin-pager-actions">
          <button
            aria-label="Previous page"
            className="button-quiet"
            disabled={cursors.length === 0 || directory.isFetching}
            onClick={() => setCursors((current) => current.slice(0, -1))}
            type="button"
          >
            <ChevronLeft aria-hidden="true" /> Previous
          </button>
          <button
            aria-label="Next page"
            className="button-quiet"
            disabled={!page?.nextCursor || directory.isFetching}
            onClick={() =>
              page?.nextCursor && setCursors((current) => [...current, page.nextCursor as string])
            }
            type="button"
          >
            Next <ChevronRight aria-hidden="true" />
          </button>
        </div>
      </div>

      <InviteDialog
        canAssignPlatformAdmin={currentIsPlatformAdmin}
        onOpenChange={setInviteOpen}
        open={inviteOpen}
        roles={roles}
      />
      <UserDetailPanel
        currentEmail={currentEmail}
        currentIsPlatformAdmin={currentIsPlatformAdmin}
        onClose={() => setOpenUserId(null)}
        roles={roles}
        userId={openUserId}
      />
    </section>
  );
}
