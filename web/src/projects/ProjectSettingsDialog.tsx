import { type FormEvent, useEffect, useState } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import { ApiError } from '../api/client';
import { usePatchProject, useProjectMembers, useUpdateProjectMember } from '../api/queries';
import type { Project } from '../api/types';
import { Modal } from '../ui/Modal';

export function ProjectSettingsDialog({
  onOpenChange,
  open,
  project,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  project: Project;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [visibility, setVisibility] = useState<'workspace' | 'private'>(project.visibility);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'editor' | 'owner'>('viewer');
  const members = useProjectMembers(open ? project.key : undefined);
  const update = usePatchProject(project.key);
  const updateMember = useUpdateProjectMember(project.key);

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setDescription(project.description);
    setVisibility(project.visibility);
  }, [open, project.description, project.name, project.visibility]);

  function saveDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    update.mutate({ name, description, visibility });
  }

  function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateMember.mutate({ email, role }, { onSuccess: () => setEmail('') });
  }

  return (
    <Modal
      className="project-settings-modal"
      description="Change the project’s identity and access without affecting its tasks."
      onOpenChange={onOpenChange}
      open={open}
      title="Project settings"
    >
      <section className="project-settings-section">
        <h3>Details</h3>
        <form className="stack-form" onSubmit={saveDetails}>
          <label htmlFor="project-settings-name">
            Project name
            <input
              id="project-settings-name"
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </label>
          <label htmlFor="project-settings-description">
            Description
            <textarea
              id="project-settings-description"
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What belongs in this project?"
              rows={3}
              value={description}
            />
          </label>
          <label htmlFor="project-settings-visibility">
            Project access
            <select
              id="project-settings-visibility"
              onChange={(event) => setVisibility(event.target.value as 'workspace' | 'private')}
              value={visibility}
            >
              <option value="workspace">All staff with Tasks access</option>
              <option value="private">Invited members only</option>
            </select>
          </label>
          <button className="button-primary" disabled={update.isPending} type="submit">
            {update.isPending ? 'Saving…' : 'Save project details'}
          </button>
          {update.isError ? (
            <p className="form-message is-error">
              {update.error instanceof ApiError
                ? update.error.message
                : 'Unable to update this project.'}
            </p>
          ) : null}
          {update.isSuccess ? <p className="form-message">Project details updated.</p> : null}
        </form>
      </section>

      <section className="project-settings-section">
        <h3>Members</h3>
        <p>Add staff or update an existing member’s project role.</p>
        <form className="stack-form" onSubmit={saveMember}>
          <label htmlFor="project-member-email">
            Staff email
            <input
              id="project-member-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder={`name@${tenantProfile.identity.hostedDomain || 'example.org'}`}
              required
              type="email"
              value={email}
            />
          </label>
          <label htmlFor="project-member-role">
            Role
            <select
              id="project-member-role"
              onChange={(event) => setRole(event.target.value as 'viewer' | 'editor' | 'owner')}
              value={role}
            >
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="owner">Owner</option>
            </select>
          </label>
          <button className="button-primary" disabled={updateMember.isPending} type="submit">
            {updateMember.isPending ? 'Updating…' : 'Add or update member'}
          </button>
          {updateMember.isError ? (
            <p className="form-message is-error">
              {updateMember.error instanceof ApiError
                ? updateMember.error.message
                : 'Unable to update project access.'}
            </p>
          ) : null}
          {updateMember.isSuccess ? <p className="form-message">Member access updated.</p> : null}
        </form>

        {members.data?.length ? (
          <div className="member-list">
            {members.data.map((member) => (
              <div key={member.email}>
                <span>
                  <strong>{member.name}</strong>
                  <small>{member.email}</small>
                </span>
                <span className="member-role">{member.role}</span>
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </Modal>
  );
}
