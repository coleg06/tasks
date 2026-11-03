import { Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  useAdminRoles,
  useCreateAdminRole,
  useDeleteAdminRole,
  useUpdateAdminRole,
} from '../api/queries';
import type { AdminPermissionArea, AdminRole } from '../api/types';
import { Modal } from '../ui/Modal';
import { errorText } from './shared';

const PLATFORM_ADMIN = 'platform.admin';

/** Permissions grouped by area with their plain-language labels. */
export function PermissionPicker({
  catalog,
  selected,
  onChange,
  readOnly = false,
}: {
  catalog: AdminPermissionArea[];
  selected: string[];
  onChange?: (next: string[]) => void;
  readOnly?: boolean;
}) {
  const grantsAll = selected.includes(PLATFORM_ADMIN);
  const every = catalog.flatMap((area) => area.permissions.map((permission) => permission.key));

  function toggle(key: string, checked: boolean) {
    if (!onChange) return;
    if (key === PLATFORM_ADMIN) {
      // Platform admin confers everything, so show everything as selected.
      onChange(checked ? every : selected.filter((entry) => entry !== key));
      return;
    }
    onChange(checked ? [...selected, key] : selected.filter((entry) => entry !== key));
  }

  return (
    <div className="permission-picker">
      {catalog.map((area) => (
        <fieldset key={area.area}>
          <legend>{area.label}</legend>
          {area.permissions.map((permission) => {
            const checked = grantsAll || selected.includes(permission.key);
            return (
              <label
                className={
                  readOnly || (grantsAll && permission.key !== PLATFORM_ADMIN)
                    ? 'is-disabled'
                    : undefined
                }
                key={permission.key}
              >
                <input
                  checked={checked}
                  disabled={readOnly || (grantsAll && permission.key !== PLATFORM_ADMIN)}
                  onChange={(event) => toggle(permission.key, event.target.checked)}
                  type="checkbox"
                />
                <span>
                  <strong>{permission.label}</strong>
                  <small>{permission.description}</small>
                </span>
              </label>
            );
          })}
        </fieldset>
      ))}
      {grantsAll ? (
        <p className="admin-note">
          Platform administrator includes every permission, now and in the future.
        </p>
      ) : null}
    </div>
  );
}

function RoleEditor({
  role,
  catalog,
  onClose,
}: {
  role: AdminRole | null;
  catalog: AdminPermissionArea[];
  onClose: () => void;
}) {
  const create = useCreateAdminRole();
  const update = useUpdateAdminRole();
  const [label, setLabel] = useState(role?.label ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const readOnly = Boolean(role?.builtin);
  const mutation = role ? update : create;

  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      if (role) await update.mutateAsync({ key: role.key, label, description, permissions });
      else await create.mutateAsync({ label, description, permissions });
      onClose();
    } catch {
      // Rendered below.
    }
  }

  return (
    <form className="admin-role-form" onSubmit={(event) => void submit(event)}>
      <label>
        <span>Name</span>
        <input
          disabled={readOnly}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          required
          value={label}
        />
      </label>
      <label>
        <span>Description</span>
        <input
          disabled={readOnly}
          maxLength={300}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Who is this for?"
          value={description}
        />
      </label>
      {readOnly ? (
        <p className="admin-note">
          <Lock aria-hidden="true" /> Built-in roles are fixed. Create a custom role to adjust
          permissions.
        </p>
      ) : null}
      <PermissionPicker
        catalog={catalog}
        onChange={setPermissions}
        readOnly={readOnly}
        selected={role?.grantsAll && readOnly ? [PLATFORM_ADMIN] : permissions}
      />
      {mutation.isError ? (
        <p className="form-message is-error" role="alert">
          {errorText(mutation.error)}
        </p>
      ) : null}
      <div className="modal-actions">
        <button className="button-quiet" onClick={onClose} type="button">
          {readOnly ? 'Close' : 'Cancel'}
        </button>
        {readOnly ? null : (
          <button
            className="button-primary"
            disabled={mutation.isPending || !label.trim() || permissions.length === 0}
            type="submit"
          >
            {mutation.isPending ? 'Saving…' : role ? 'Save role' : 'Create role'}
          </button>
        )}
      </div>
    </form>
  );
}

function DeleteRole({
  role,
  roles,
  onClose,
}: {
  role: AdminRole;
  roles: AdminRole[];
  onClose: () => void;
}) {
  const remove = useDeleteAdminRole();
  const choices = roles.filter((entry) => entry.key !== role.key && entry.assignable);
  const [replacement, setReplacement] = useState('');

  async function confirm() {
    try {
      await remove.mutateAsync({ key: role.key, ...(replacement ? { replacement } : {}) });
      onClose();
    } catch {
      // Rendered below.
    }
  }

  return (
    <div className="admin-role-form">
      {role.userCount > 0 ? (
        <>
          <p>
            {role.userCount} {role.userCount === 1 ? 'person has' : 'people have'} this role. Choose
            the role they should get instead.
          </p>
          <label>
            <span>Replacement role</span>
            <select onChange={(event) => setReplacement(event.target.value)} value={replacement}>
              <option value="">Choose a role…</option>
              {choices.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <p>No one has this role. It will be deleted.</p>
      )}
      {remove.isError ? (
        <p className="form-message is-error" role="alert">
          {errorText(remove.error)}
        </p>
      ) : null}
      <div className="modal-actions">
        <button className="button-quiet" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="button-primary is-danger"
          disabled={remove.isPending || (role.userCount > 0 && !replacement)}
          onClick={() => void confirm()}
          type="button"
        >
          <Trash2 aria-hidden="true" /> {remove.isPending ? 'Deleting…' : 'Delete role'}
        </button>
      </div>
    </div>
  );
}

export function RolesTab() {
  const rolesQuery = useAdminRoles();
  const [editing, setEditing] = useState<AdminRole | 'new' | null>(null);
  const [deleting, setDeleting] = useState<AdminRole | null>(null);
  const data = rolesQuery.data;

  if (rolesQuery.isLoading) return <p className="admin-empty">Loading roles…</p>;
  if (rolesQuery.isError || !data) {
    return <p className="form-message is-error">Unable to load roles.</p>;
  }

  return (
    <section aria-label="Roles" className="admin-roles">
      <div className="admin-section-heading">
        <div>
          <h2>Roles</h2>
          <p>
            A role is a named set of permissions. Give people roles instead of ticking boxes one by
            one; a person can hold several, and direct grants made earlier keep working.
          </p>
        </div>
        {data.canManageRoles ? (
          <button className="button-primary" onClick={() => setEditing('new')} type="button">
            <Plus aria-hidden="true" /> Create role
          </button>
        ) : null}
      </div>
      {!data.canManageRoles ? (
        <p className="admin-note">Only platform administrators can create or change roles.</p>
      ) : null}

      <div className="admin-role-list">
        {data.roles.map((role) => (
          <article className="admin-role-card" key={role.key}>
            <header>
              <div>
                <h3>
                  {role.label}
                  {role.builtin ? (
                    <span className="badge">
                      <Lock aria-hidden="true" /> Built in
                    </span>
                  ) : (
                    <span className="badge is-info">Custom</span>
                  )}
                </h3>
                <p>{role.description || 'No description.'}</p>
              </div>
              <div className="admin-role-actions">
                <button
                  aria-label={role.builtin ? `View ${role.label}` : `Edit ${role.label}`}
                  className="icon-button"
                  onClick={() => setEditing(role)}
                  title={role.builtin ? 'View permissions' : 'Edit role'}
                  type="button"
                >
                  <Pencil />
                </button>
                {!role.builtin && data.canManageRoles ? (
                  <button
                    aria-label={`Delete ${role.label}`}
                    className="icon-button"
                    onClick={() => setDeleting(role)}
                    title="Delete role"
                    type="button"
                  >
                    <Trash2 />
                  </button>
                ) : null}
              </div>
            </header>
            <div className="admin-role-perms">
              {role.grantsAll ? (
                <span className="badge is-accent">Every permission</span>
              ) : (
                role.permissions.map((key) => {
                  const label = data.catalog
                    .flatMap((area) => area.permissions)
                    .find((permission) => permission.key === key)?.label;
                  return (
                    <span className="badge" key={key}>
                      {label ?? key}
                    </span>
                  );
                })
              )}
            </div>
            <footer>
              {role.userCount.toLocaleString()} {role.userCount === 1 ? 'person' : 'people'}
            </footer>
          </article>
        ))}
      </div>

      <Modal
        className="admin-dialog"
        description={
          editing !== 'new' && editing?.builtin
            ? 'Built-in roles cannot be changed.'
            : 'Choose what people with this role can do.'
        }
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
        open={editing !== null}
        title={editing === 'new' ? 'Create role' : (editing?.label ?? 'Role')}
      >
        {editing !== null ? (
          <RoleEditor
            catalog={data.catalog}
            key={editing === 'new' ? 'new' : editing.key}
            onClose={() => setEditing(null)}
            role={editing === 'new' ? null : editing}
          />
        ) : null}
      </Modal>
      <Modal
        description="This cannot be undone."
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        open={deleting !== null}
        title={deleting ? `Delete ${deleting.label}?` : 'Delete role'}
      >
        {deleting ? (
          <DeleteRole onClose={() => setDeleting(null)} role={deleting} roles={data.roles} />
        ) : null}
      </Modal>
    </section>
  );
}
