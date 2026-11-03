import { type FormEvent, useState } from 'react';
import { tenantProfile } from '../../../shared/tenant-profile';
import { useCreateProject } from '../api/queries';
import { useUpdateSearch } from '../router';
import { Modal } from '../ui/Modal';

export function CreateProjectDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('workspace');
  const createProject = useCreateProject();
  const updateSearch = useUpdateSearch();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createProject.mutate(
      { name, visibility },
      {
        onSuccess: (project) => {
          setName('');
          onOpenChange(false);
          updateSearch({ project: project.key, task: undefined });
        },
      },
    );
  }

  return (
    <Modal onOpenChange={onOpenChange} open={open} title="New project">
      <form className="stack-form" onSubmit={submit}>
        <label htmlFor="project-name">
          Name
          <input
            // biome-ignore lint/a11y/noAutofocus: the user deliberately opened this surface, so focusing its field is expected rather than a jump.
            autoFocus
            id="project-name"
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
            required
            value={name}
          />
        </label>
        <label htmlFor="project-visibility">
          Access
          <select
            id="project-visibility"
            onChange={(event) => setVisibility(event.target.value as 'workspace' | 'private')}
            value={visibility}
          >
            <option value="workspace">
              Everyone in {tenantProfile.organizationName} {tenantProfile.productName}
            </option>
            <option value="private">Invited members only</option>
          </select>
        </label>
        <button className="button-primary" disabled={createProject.isPending} type="submit">
          {createProject.isPending ? 'Creating…' : 'Create project'}
        </button>
        {createProject.isError ? (
          <p className="form-message is-error">Unable to create project.</p>
        ) : null}
      </form>
    </Modal>
  );
}
