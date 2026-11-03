import { Link, useParams } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  ClipboardCheck,
  Clock3,
  ExternalLink,
  FileText,
  History,
  Languages,
  Link2,
  LoaderCircle,
  MapPin,
  MessageSquare,
  PackageCheck,
  Pencil,
  Plus,
  Save,
  Send,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { defaultRuntimeFeatures } from '../../../shared/runtime-features';
import { tenantProfile } from '../../../shared/tenant-profile';
import { tenantEventVocabulary } from '../../../shared/tenant-profile-support';
import {
  useBootstrap,
  useCreateAssetVersion,
  useCreateCopyVersion,
  useCreateEventApproval,
  useCreateEventComment,
  useCreateEventWorkItem,
  useEvent,
  useEventOptions,
  useFinalizeAssetVersion,
  usePatchDeliverable,
  usePatchEventFacts,
  usePatchEventStage,
  usePatchEventWorkItem,
  useUploadAssetVersion,
} from '../api/queries';
import {
  type DeliverableStatus,
  deliverableStatusLabels,
  type EventChannel,
  type EventDetail,
  type EventOperation,
  type EventStage,
  type EventWorkItemPhase,
  type EventWorkItemStatus,
  eventStageLabels,
} from '../api/types';
import { dueTiming } from '../events/due-timing';
import {
  OriginalRequest,
  ResponsibilitiesPanel,
  responsibilityLabels,
} from '../events/ResponsibilitiesPanel';
import { coordinationOptions, creativeOptions } from '../events/request-options';
import { MentionTextarea } from '../ui/MentionTextarea';

type DetailTab = 'overview' | 'copy' | 'assets' | 'activity';

const vocabulary = tenantEventVocabulary(tenantProfile);
const workStatusLabels: Record<EventWorkItemStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  blocked: 'Blocked',
  done: 'Done',
  not_needed: 'Not needed',
};

const phaseLabels: Record<string, string> = {
  intake: 'Intake',
  administration: 'Administration',
  copy: 'Copy',
  translation: 'Translation',
  design: 'Design',
  publishing: 'Publishing',
  operations: 'Event operations',
  post_event: 'Post-event',
};

const workItemPhases = Object.keys(phaseLabels) as EventWorkItemPhase[];

const copyPurposeLabels: Record<string, string> = {
  full_promo: 'Full promotional copy',
  slide: 'Concise slide / program copy',
  calendar: 'Calendar / registration copy',
  social: 'Social copy',
  handout: 'Handout copy',
  website: 'Website copy',
};

const eventStages = Object.keys(eventStageLabels) as EventStage[];

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function StageControl({ event }: { event: EventDetail }) {
  const patch = usePatchEventStage(event.key);
  const [stage, setStage] = useState<EventStage>(event.stage);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const changed = stage !== event.stage;

  async function save() {
    if (!reason.trim()) {
      setError('Add a short reason for the stage change.');
      return;
    }
    try {
      await patch.mutateAsync({ stage, expectedVersion: event.version, reason });
      setReason('');
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The stage could not be changed.');
    }
  }

  return (
    <div className="event-stage-control">
      <label>
        <CircleDashed />
        <span className="sr-only">Workflow stage</span>
        <select onChange={(e) => setStage(e.target.value as EventStage)} value={stage}>
          {eventStages.map((option) => (
            <option key={option} value={option}>
              {eventStageLabels[option]}
            </option>
          ))}
        </select>
      </label>
      {changed ? (
        <div className="event-stage-change">
          <input
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this stage changing?"
            value={reason}
          />
          <button disabled={patch.isPending} onClick={() => void save()} type="button">
            {patch.isPending ? <LoaderCircle className="is-spinning" /> : <Save />} Save stage
          </button>
        </div>
      ) : null}
      {error ? <small className="event-inline-error">{error}</small> : null}
    </div>
  );
}

function displayDate(value: string | null) {
  if (!value) return 'No date';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

function displayTime(value: string | null) {
  if (!value) return '';
  const time = value.slice(11, 16);
  const [hours = 0, minutes = 0] = time.split(':').map(Number);
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(2020, 1, 1, hours, minutes),
  );
}

function WorkItemEditor({
  eventKey,
  event,
  item,
  staff,
  onClose,
}: {
  eventKey: string;
  event: EventDetail;
  item?: EventDetail['workItems'][number];
  staff: Array<{ id: number; email: string; name: string }>;
  onClose: () => void;
}) {
  const patch = usePatchEventWorkItem(eventKey);
  const create = useCreateEventWorkItem(eventKey);
  const manageable = event.responsibilities.filter(
    (r) =>
      r.canManage &&
      (r.status !== 'not_needed' || r.responsibility_key === item?.responsibility_key),
  );
  const [responsibilityKey, setResponsibilityKey] = useState(
    item?.responsibility_key ?? (!item ? manageable[0]?.responsibility_key : '') ?? '',
  );
  const [title, setTitle] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [dueDate, setDueDate] = useState(item?.due_at?.slice(0, 10) ?? '');
  const [phase, setPhase] = useState<EventWorkItemPhase>(item?.phase ?? 'administration');
  const [status, setStatus] = useState<EventWorkItemStatus>(item?.status ?? 'not_started');
  const [ownerEmail, setOwnerEmail] = useState(item?.owner_email ?? '');
  const [critical, setCritical] = useState(Boolean(item?.critical));
  const [error, setError] = useState('');
  const pending = patch.isPending || create.isPending;

  async function save() {
    if (!title.trim()) {
      setError('Add a task title.');
      return;
    }
    try {
      const values = {
        title,
        description,
        dueDate: dueDate || null,
        phase,
        status,
        ownerEmail: ownerEmail || null,
        critical,
        responsibilityKey: responsibilityKey || null,
      };
      if (item) {
        await patch.mutateAsync({ key: item.work_item_key, ...values });
      } else {
        await create.mutateAsync(values);
      }
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The task could not be saved.');
    }
  }

  return (
    <section
      className="event-work-item-editor"
      aria-label={item ? `Edit ${item.title}` : 'Add event task'}
    >
      <header>
        <div>
          <span>Event task</span>
          <strong>{item ? 'Edit task details' : 'Add a custom task'}</strong>
        </div>
        <button
          aria-label="Close task editor"
          className="icon-button"
          onClick={onClose}
          type="button"
        >
          <X />
        </button>
      </header>
      <div className="event-work-item-form">
        <label className="is-wide">
          <span>Responsibility</span>
          <select value={responsibilityKey} onChange={(e) => setResponsibilityKey(e.target.value)}>
            {!item?.responsibility_key ? (
              <option value="">
                {event.workflowMode === 'legacy'
                  ? 'Unlinked'
                  : item
                    ? 'Legacy work (outside readiness)'
                    : 'Choose a responsibility'}
              </option>
            ) : null}
            {manageable.map((r) => (
              <option key={r.responsibility_key} value={r.responsibility_key}>
                {responsibilityLabels[r.area] ?? r.area}
              </option>
            ))}
          </select>
        </label>
        <label className="is-wide">
          <span>Title</span>
          <input maxLength={240} onChange={(event) => setTitle(event.target.value)} value={title} />
        </label>
        <label className="is-wide">
          <span>Description</span>
          <textarea
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
            rows={3}
            value={description}
          />
        </label>
        <label>
          <span>Assigned to</span>
          <select onChange={(event) => setOwnerEmail(event.target.value)} value={ownerEmail}>
            <option value="">Unassigned</option>
            {staff.map((person) => (
              <option key={person.id} value={person.email}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Due date</span>
          <input onChange={(event) => setDueDate(event.target.value)} type="date" value={dueDate} />
        </label>
        <label>
          <span>Phase</span>
          <select
            onChange={(event) => setPhase(event.target.value as EventWorkItemPhase)}
            value={phase}
          >
            {workItemPhases.map((option) => (
              <option key={option} value={option}>
                {phaseLabels[option]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select
            onChange={(event) => setStatus(event.target.value as EventWorkItemStatus)}
            value={status}
          >
            {(Object.keys(workStatusLabels) as EventWorkItemStatus[]).map((option) => (
              <option key={option} value={option}>
                {workStatusLabels[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="event-work-critical">
          <input
            checked={critical}
            onChange={(event) => setCritical(event.target.checked)}
            type="checkbox"
          />
          <span>Required for event readiness</span>
        </label>
      </div>
      <footer className="event-editor-actions">
        <button className="button-quiet" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="button-primary"
          disabled={pending}
          onClick={() => void save()}
          type="button"
        >
          {pending ? <LoaderCircle className="is-spinning" /> : item ? <Save /> : <Plus />}{' '}
          {item ? 'Save task' : 'Add task'}
        </button>
      </footer>
      {error ? <p className="event-form-error">{error}</p> : null}
    </section>
  );
}

function FactsEditor({ event, onClose }: { event: EventDetail; onClose: () => void }) {
  const patch = usePatchEventFacts(event.key);
  const options = useEventOptions(true);
  const [title, setTitle] = useState(event.facts.title);
  const [purpose, setPurpose] = useState(event.facts.purpose);
  const [audience, setAudience] = useState(event.facts.audience);
  const [communicationBrief, setCommunicationBrief] = useState(event.facts.communicationBrief);
  const [ministry, setMinistry] = useState(event.facts.ministry);
  const [requestApprovalConfirmed, setRequestApprovalConfirmed] = useState(
    event.facts.requestApprovalConfirmed,
  );
  const [ownerEmail, setOwnerEmail] = useState(event.facts.ownerEmail);
  const [startDate, setStartDate] = useState(event.facts.startDate);
  const [endDate, setEndDate] = useState(event.facts.endDate ?? '');
  const [startTime, setStartTime] = useState(event.facts.startTime);
  const [endTime, setEndTime] = useState(event.facts.endTime ?? '');
  const [location, setLocation] = useState(event.facts.location);
  const [registrationUrl, setRegistrationUrl] = useState(event.facts.registration.url ?? '');
  const [channels, setChannels] = useState<EventChannel[]>(event.facts.channels);
  const [operations, setOperations] = useState<EventOperation[]>(event.facts.operations);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  async function save() {
    if (!reason.trim()) {
      setError('Explain why the canonical facts changed.');
      return;
    }
    try {
      await patch.mutateAsync({
        title,
        requestApprovalConfirmed,
        purpose,
        audience,
        communicationBrief,
        ministry,
        ownerEmail,
        startDate,
        endDate: endDate || null,
        startTime,
        endTime: endTime || null,
        location,
        registration: { ...event.facts.registration, url: registrationUrl || null },
        channels,
        operations,
        changeReason: reason,
        expectedVersion: event.version,
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The event facts could not be updated.');
    }
  }

  return (
    <div className="event-facts-editor">
      <div className="event-form-grid">
        <label className="is-wide">
          <span>Title</span>
          <input onChange={(e) => setTitle(e.target.value)} value={title} />
        </label>
        <label>
          <span>{vocabulary.ministryLabel}</span>
          <input
            list="event-fact-ministries"
            onChange={(e) => setMinistry(e.target.value)}
            value={ministry}
          />
          <datalist id="event-fact-ministries">
            {(options.data?.ministries ?? []).map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </label>
        <label>
          <span>Event owner</span>
          <select onChange={(e) => setOwnerEmail(e.target.value || null)} value={ownerEmail ?? ''}>
            <option value="">Current editor</option>
            {(options.data?.staff ?? []).map((staff) => (
              <option key={staff.id} value={staff.email}>
                {staff.name} · {staff.email}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Location</span>
          <input onChange={(e) => setLocation(e.target.value)} value={location} />
        </label>
        <label className="is-wide">
          <span>Purpose</span>
          <textarea onChange={(e) => setPurpose(e.target.value)} rows={3} value={purpose} />
        </label>
        <label className="is-wide">
          <span>Who is it for?</span>
          <input onChange={(e) => setAudience(e.target.value)} value={audience} />
        </label>
        <label className="is-wide">
          <span>What should people know?</span>
          <textarea
            onChange={(e) => setCommunicationBrief(e.target.value)}
            rows={4}
            value={communicationBrief}
          />
        </label>
        <label>
          <span>Date</span>
          <input onChange={(e) => setStartDate(e.target.value)} type="date" value={startDate} />
        </label>
        <label>
          <span>End date (if multi-day)</span>
          <input
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            type="date"
            value={endDate}
          />
        </label>
        <label>
          <span>Starts</span>
          <input onChange={(e) => setStartTime(e.target.value)} type="time" value={startTime} />
        </label>
        <label>
          <span>Ends</span>
          <input onChange={(e) => setEndTime(e.target.value)} type="time" value={endTime} />
        </label>
        <label>
          <span>Registration URL</span>
          <input
            onChange={(e) => setRegistrationUrl(e.target.value)}
            type="url"
            value={registrationUrl}
          />
        </label>
        <fieldset className="event-channel-grid event-request-options is-wide">
          <legend>Creative things</legend>
          {creativeOptions.map((option) => (
            <label
              className={channels.includes(option.channel) ? 'is-selected' : ''}
              key={option.channel}
            >
              <input
                checked={channels.includes(option.channel)}
                onChange={() => setChannels(toggleValue(channels, option.channel))}
                type="checkbox"
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <Check aria-hidden="true" />
            </label>
          ))}
        </fieldset>
        <fieldset className="event-channel-grid event-request-options is-wide">
          <legend>Facilities and coordination</legend>
          {coordinationOptions.map((option) => (
            <label
              className={operations.includes(option.operation) ? 'is-selected' : ''}
              key={option.operation}
            >
              <input
                checked={operations.includes(option.operation)}
                onChange={() => setOperations(toggleValue(operations, option.operation))}
                type="checkbox"
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <Check aria-hidden="true" />
            </label>
          ))}
        </fieldset>
        <label className="is-wide">
          <span>Why are you changing this?</span>
          <input
            onChange={(e) => setReason(e.target.value)}
            placeholder="Add a short explanation"
            value={reason}
          />
        </label>
        <label className="event-checkbox-field is-wide">
          <input
            checked={requestApprovalConfirmed}
            onChange={(event) => setRequestApprovalConfirmed(event.target.checked)}
            type="checkbox"
          />
          <span>This event has been approved</span>
        </label>
      </div>
      <p className="event-change-warning">
        <AlertTriangle /> Material changes invalidate affected approvals and reopen published
        deliverables for review.
      </p>
      {error ? <div className="event-form-error">{error}</div> : null}
      <div className="event-editor-actions">
        <button className="button-quiet" onClick={onClose} type="button">
          Cancel
        </button>
        <button
          className="button-primary"
          disabled={patch.isPending}
          onClick={() => void save()}
          type="button"
        >
          {patch.isPending ? <LoaderCircle className="is-spinning" /> : <Save />} Save changes
        </button>
      </div>
    </div>
  );
}

function CopyVariantCard({
  event,
  variant,
}: {
  event: EventDetail;
  variant: EventDetail['copyVariants'][number];
}) {
  const createVersion = useCreateCopyVersion(event.key);
  const approve = useCreateEventApproval(event.key);
  const [body, setBody] = useState(variant.body ?? '');
  const [error, setError] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const changed = body.trim() !== (variant.body ?? '').trim();

  useLayoutEffect(() => {
    if (!editor.current) return;
    editor.current.style.height = 'auto';
    editor.current.style.height = `${editor.current.scrollHeight}px`;
  });

  async function save() {
    try {
      await createVersion.mutateAsync({
        purpose: variant.purpose,
        language: variant.language,
        body,
        authorType: 'human',
        ...(variant.language === 'es' ? { sourceCopyVersionId: null } : {}),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Copy could not be saved.');
    }
  }

  async function decide(decision: 'approved' | 'changes_requested') {
    if (!variant.version_id || !variant.version) return;
    try {
      await approve.mutateAsync({
        subjectType: 'copy',
        subjectId: variant.version_id,
        subjectVersion: variant.version,
        scope: variant.language === 'es' ? 'translation' : 'english_copy',
        decision,
        comment:
          decision === 'approved'
            ? 'Approved in the event workspace.'
            : 'Changes requested in the event workspace.',
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The review decision could not be saved.',
      );
    }
  }

  return (
    <article className="event-copy-card">
      <header>
        <div>
          <span>{variant.language === 'es' ? <Languages /> : <FileText />}</span>
          <div>
            <strong>{copyPurposeLabels[variant.purpose] ?? variant.purpose}</strong>
            <small>
              {variant.language === 'es'
                ? `${vocabulary.secondLanguageName} · human proof required`
                : 'English source'}{' '}
              · version {variant.current_version || '—'}
            </small>
          </div>
        </div>
        {variant.approved_version_id ? (
          <span className="event-approved-pill">
            <ShieldCheck /> Approved
          </span>
        ) : (
          <span className="event-draft-pill">Draft</span>
        )}
      </header>
      <textarea
        className="event-copy-editor"
        onChange={(e) => setBody(e.target.value)}
        placeholder="Draft copy from the approved event facts…"
        ref={editor}
        rows={6}
        value={body}
      />
      <footer>
        <span>
          {variant.fact_version
            ? `Based on event details version ${variant.fact_version}`
            : 'No draft yet'}
          {variant.author_name ? ` · ${variant.author_name}` : ''}
        </span>
        <div>
          {event.canApprove && variant.version_id ? (
            <>
              <button
                className="button-quiet"
                disabled={approve.isPending}
                onClick={() => void decide('changes_requested')}
                type="button"
              >
                Request changes
              </button>
              <button
                className="button-quiet"
                disabled={approve.isPending}
                onClick={() => void decide('approved')}
                type="button"
              >
                <Check /> Approve version
              </button>
            </>
          ) : null}
          <button
            className="button-primary"
            disabled={!body.trim() || !changed || createVersion.isPending}
            onClick={() => void save()}
            type="button"
          >
            {createVersion.isPending ? <LoaderCircle className="is-spinning" /> : <Save />} Save new
            version
          </button>
        </div>
      </footer>
      {error ? <div className="event-form-error">{error}</div> : null}
    </article>
  );
}

function AssetCard({
  event,
  deliverable,
}: {
  event: EventDetail;
  deliverable: EventDetail['deliverables'][number];
}) {
  const createAsset = useCreateAssetVersion(event.key);
  const uploadAsset = useUploadAssetVersion(event.key);
  const finalizeAsset = useFinalizeAssetVersion(event.key);
  const approve = useCreateEventApproval(event.key);
  const versions = event.assetVersions.filter(
    (version) => version.deliverable_id === deliverable.id,
  );
  const latest = versions[0];
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');

  async function addVersion() {
    try {
      await createAsset.mutateAsync({
        deliverableKey: deliverable.deliverable_key,
        input: { url, label, storageProvider: 'link', providerFileId: null },
      });
      setUrl('');
      setLabel('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The asset link could not be added.');
    }
  }

  async function uploadVersion() {
    if (!file) return;
    try {
      await uploadAsset.mutateAsync({
        deliverableKey: deliverable.deliverable_key,
        file,
        label,
      });
      setFile(null);
      setLabel('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The file could not be uploaded.');
    }
  }

  async function markFinal() {
    if (!latest) return;
    try {
      await finalizeAsset.mutateAsync(latest.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The final revision could not be saved.');
    }
  }

  async function decide(decision: 'approved' | 'changes_requested') {
    if (!latest) return;
    try {
      await approve.mutateAsync({
        subjectType: 'asset',
        subjectId: latest.id,
        subjectVersion: latest.version,
        scope: 'design',
        decision,
        comment:
          decision === 'approved'
            ? 'Approved in the event workspace.'
            : 'Changes requested in the event workspace.',
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The review decision could not be saved.',
      );
    }
  }

  return (
    <article className="event-asset-card">
      <header>
        <div>
          <span>
            <PackageCheck />
          </span>
          <div>
            <strong>{deliverable.title}</strong>
            <small>
              {deliverable.asset_type.replaceAll('_', ' ')} · {deliverable.campus} ·{' '}
              {deliverable.language.toUpperCase()}
            </small>
          </div>
        </div>
        <span className={`event-deliverable-status status-${deliverable.status}`}>
          {deliverableStatusLabels[deliverable.status]}
        </span>
      </header>
      {latest ? (
        <div className="event-asset-versions">
          {versions.slice(0, 5).map((version) => (
            <div className="event-latest-asset" key={version.id}>
              <div>
                <Link2 />
                <span>
                  <strong>
                    {version.label || version.original_filename || `Version ${version.version}`}
                  </strong>
                  <small>
                    Version {version.version} · {version.creator_name ?? 'Staff'}
                    {version.size_bytes
                      ? ` · ${(version.size_bytes / 1024 / 1024).toFixed(1)} MB`
                      : ''}
                  </small>
                  {version.is_final ? (
                    <small className="event-final-badge">
                      Final ·{' '}
                      {version.drive_delivery_status === 'delivered'
                        ? 'sent to Drive'
                        : version.drive_delivery_status.replaceAll('_', ' ')}
                    </small>
                  ) : null}
                </span>
              </div>
              <a href={version.drive_web_view_link ?? version.url} rel="noreferrer" target="_blank">
                Open file <ExternalLink />
              </a>
            </div>
          ))}
        </div>
      ) : (
        <div className="event-no-asset">No file or Drive link has been attached.</div>
      )}
      {event.canEdit ? (
        <div className="event-asset-form">
          <input
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Version label (optional)"
            value={label}
          />
          <label className="event-file-picker">
            <span>{file ? file.name : 'Choose PNG, JPEG, WebP, or PDF'}</span>
            <input
              accept="image/png,image/jpeg,image/webp,application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              type="file"
            />
          </label>
          <button
            className="button-primary"
            disabled={!file || uploadAsset.isPending}
            onClick={() => void uploadVersion()}
            type="button"
          >
            <Upload /> {uploadAsset.isPending ? 'Uploading…' : 'Upload revision'}
          </button>
          <span className="event-asset-or">or attach an existing link</span>
          <input
            onChange={(e) => setUrl(e.target.value)}
            placeholder="Google Drive or file URL"
            type="url"
            value={url}
          />
          <button
            className="button-quiet"
            disabled={!url || createAsset.isPending}
            onClick={() => void addVersion()}
            type="button"
          >
            <Upload /> Add version
          </button>
        </div>
      ) : null}
      {event.canApprove && latest ? (
        <footer>
          <button
            className="button-quiet"
            disabled={approve.isPending}
            onClick={() => void decide('changes_requested')}
            type="button"
          >
            Request changes
          </button>
          <button
            className="button-primary"
            disabled={approve.isPending}
            onClick={() => void decide('approved')}
            type="button"
          >
            <ShieldCheck /> Approve exact version
          </button>
          {deliverable.approved_asset_version_id === latest.id ? (
            <button
              className="button-primary"
              disabled={finalizeAsset.isPending || Boolean(latest.is_final)}
              onClick={() => void markFinal()}
              type="button"
            >
              <CheckCircle2 /> {latest.is_final ? 'Final revision' : 'Mark final & deliver'}
            </button>
          ) : null}
        </footer>
      ) : null}
      {error ? <div className="event-form-error">{error}</div> : null}
    </article>
  );
}

export function EventDetailPage() {
  const { eventKey } = useParams({ from: '/events/$eventKey' });
  const bootstrap = useBootstrap();
  const features = bootstrap.data?.features ?? defaultRuntimeFeatures;
  const eventQuery = useEvent(eventKey, features.events);
  const event = eventQuery.data;
  const eventOptions = useEventOptions(Boolean(event));
  const patchWorkItem = usePatchEventWorkItem(eventKey);
  const patchDeliverable = usePatchDeliverable(eventKey);
  const createComment = useCreateEventComment(eventKey);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [editingFacts, setEditingFacts] = useState(false);
  const [editingWorkItemKey, setEditingWorkItemKey] = useState<string | null>(null);
  const [creatingWorkItem, setCreatingWorkItem] = useState(false);
  const [comment, setComment] = useState('');

  const phases = useMemo(() => {
    const grouped = new Map<string, EventDetail['workItems']>();
    for (const item of event?.workItems ?? []) {
      grouped.set(item.phase, [...(grouped.get(item.phase) ?? []), item]);
    }
    return [...grouped.entries()];
  }, [event?.workItems]);

  if (!features.events) {
    return (
      <div className="events-access">
        <AlertTriangle />
        <h1>Events are disabled</h1>
        <p>This deployment has the events module turned off.</p>
        <Link search={{ view: 'open' }} to="/">
          Back to tasks
        </Link>
      </div>
    );
  }

  if (eventQuery.isLoading)
    return <div className="event-detail-loading">Loading event workspace…</div>;
  if (!event)
    return (
      <div className="events-access">
        <AlertTriangle />
        <h1>Event unavailable</h1>
        <p>This event does not exist or you do not have access.</p>
        <Link search={{ view: 'open' }} to="/events">
          Back to events
        </Link>
      </div>
    );

  const openReadinessItems = event.workItems.filter(
    (item) => item.critical && !item.legacy && !['done', 'not_needed'].includes(item.status),
  );
  const nextItems = [...openReadinessItems]
    .sort((left, right) =>
      (left.due_at ?? '9999-12-31').localeCompare(right.due_at ?? '9999-12-31'),
    )
    .slice(0, 4);
  const overdueRequirements = openReadinessItems.filter(
    (item) => dueTiming(item.due_at) === 'Overdue',
  ).length;
  const dueSoonRequirements = openReadinessItems.filter((item) => {
    const timing = dueTiming(item.due_at);
    return timing === 'Due today' || timing.startsWith('Due in ');
  }).length;
  const readinessTone =
    event.readiness === 'ready'
      ? 'ready'
      : overdueRequirements
        ? 'blocked'
        : dueSoonRequirements
          ? 'at_risk'
          : 'scheduled';
  const readinessLabel =
    event.readiness === 'ready'
      ? 'Ready'
      : overdueRequirements
        ? `${overdueRequirements} overdue`
        : dueSoonRequirements
          ? `${dueSoonRequirements} due soon`
          : `${event.blockerCount} readiness blockers`;
  const editingWorkItem = event.workItems.find((item) => item.work_item_key === editingWorkItemKey);
  const currentEmail = bootstrap.data?.user?.email.toLowerCase();

  return (
    <div className="event-detail-page">
      <header className="event-detail-header">
        <div className="event-detail-title-row">
          <Link
            aria-label="Back to events"
            className="icon-button"
            search={{ view: 'open' }}
            to="/events"
          >
            <ArrowLeft />
          </Link>
          <div className="event-detail-title">
            <span>
              {event.reference} · {event.ministry}
            </span>
            <h1>{event.title}</h1>
            <div className="event-detail-meta">
              <span>
                <CalendarDays /> {displayDate(event.startAt)}
              </span>
              <span>
                <Clock3 /> {displayTime(event.startAt)}
                {event.endAt ? `–${displayTime(event.endAt)}` : ''}
              </span>
              <span>
                <MapPin /> {event.location}
              </span>
              {event.canEdit ? (
                <StageControl event={event} />
              ) : (
                <span>
                  <CircleDashed /> {eventStageLabels[event.stage]}
                </span>
              )}
            </div>
          </div>
          <span className={`event-readiness-badge readiness-${readinessTone}`}>
            {event.readiness === 'ready' ? (
              <CheckCircle2 />
            ) : overdueRequirements ? (
              <AlertTriangle />
            ) : (
              <Clock3 />
            )}
            {readinessLabel}
          </span>
        </div>
      </header>

      <nav className="event-detail-tabs" aria-label="Event workspace sections">
        {(
          [
            ['overview', 'Overview'],
            ['copy', 'Copy & translation'],
            ['assets', 'Assets & approval'],
            ['activity', 'Conversation & history'],
          ] as Array<[DetailTab, string]>
        ).map(([key, label]) => (
          <button
            className={tab === key ? 'is-active' : ''}
            key={key}
            onClick={() => setTab(key)}
            type="button"
          >
            {key === 'overview' ? (
              <ClipboardCheck />
            ) : key === 'copy' ? (
              <FileText />
            ) : key === 'assets' ? (
              <PackageCheck />
            ) : (
              <History />
            )}
            {label}
          </button>
        ))}
      </nav>

      <main className="event-detail-content">
        {tab === 'overview' ? (
          <>
            <section className="event-readiness-panel">
              <div className="event-readiness-score">
                <div style={{ '--progress': `${event.progress * 3.6}deg` } as React.CSSProperties}>
                  <span>{event.progress}%</span>
                </div>
                <div>
                  <span>Event readiness</span>
                  <strong>
                    {event.readiness === 'ready'
                      ? 'All readiness requirements are complete'
                      : `${event.blockerCount} readiness requirements remain`}
                  </strong>
                  <p>
                    Required work may be scheduled well in advance. Its due date—not this readiness
                    count—shows whether it needs attention now.
                  </p>
                </div>
              </div>
              <div className="event-next-actions">
                <span>Next readiness requirements</span>
                {nextItems.length ? (
                  nextItems.map((item) => (
                    <div key={item.work_item_key}>
                      <div>
                        <strong>{item.title}</strong>
                        <small>
                          {item.owner_name ?? 'Unassigned'} · {dueTiming(item.due_at)} · due{' '}
                          {displayDate(item.due_at)}
                        </small>
                      </div>
                      <span>{workStatusLabels[item.status]}</span>
                    </div>
                  ))
                ) : (
                  <p>
                    <CheckCircle2 /> No readiness requirements remain.
                  </p>
                )}
              </div>
            </section>

            <section className="event-overview-grid">
              <article className="event-facts-card">
                <header>
                  <div>
                    <span>Event details</span>
                    <strong>Version {event.factsVersion}</strong>
                  </div>
                  {event.canEdit ? (
                    <button
                      className="button-quiet"
                      onClick={() => setEditingFacts((value) => !value)}
                      type="button"
                    >
                      <Pencil /> {editingFacts ? 'Close editor' : 'Edit facts'}
                    </button>
                  ) : null}
                </header>
                {editingFacts ? (
                  <FactsEditor event={event} onClose={() => setEditingFacts(false)} />
                ) : (
                  <div className="event-facts-grid">
                    <div>
                      <span>Purpose</span>
                      <p>{event.facts.purpose}</p>
                    </div>
                    <div>
                      <span>Audience</span>
                      <p>{event.facts.audience}</p>
                    </div>
                    {event.facts.communicationBrief ? (
                      <div className="is-wide">
                        <span>Communication brief</span>
                        <p>{event.facts.communicationBrief}</p>
                      </div>
                    ) : null}
                    {event.facts.priorEvent?.heldBefore ? (
                      <div>
                        <span>Previous event</span>
                        <p>
                          {event.facts.priorEvent.previousName || 'Name not entered'} ·{' '}
                          {event.facts.priorEvent.sameAsPrevious
                            ? 'substantially the same'
                            : 'details changed'}
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <span>Internal routing</span>
                      <p>{event.facts.campuses.join(', ')}</p>
                    </div>
                    <div>
                      <span>{vocabulary.ministryLabel} approval</span>
                      <p>
                        {event.facts.requestApprovalConfirmed
                          ? 'Confirmed by requester'
                          : 'Confirmation missing'}
                      </p>
                    </div>
                    <div>
                      <span>Registration</span>
                      <p>
                        {event.facts.registration.required ? (
                          event.facts.registration.url ? (
                            <a href={event.facts.registration.url} rel="noreferrer" target="_blank">
                              Open response path <ExternalLink />
                            </a>
                          ) : (
                            <em>Required · URL missing</em>
                          )
                        ) : (
                          'Not required'
                        )}
                      </p>
                    </div>
                    {event.facts.registration.required ? (
                      <>
                        <div>
                          <span>Cost</span>
                          <p>
                            {event.facts.registration.cost === null
                              ? 'Not entered'
                              : new Intl.NumberFormat('en-US', {
                                  style: 'currency',
                                  currency: 'USD',
                                }).format(event.facts.registration.cost)}
                            {event.facts.registration.accountCode
                              ? ` · COA ${event.facts.registration.accountCode}`
                              : ''}
                          </p>
                        </div>
                        {event.facts.registration.formFields?.length ? (
                          <div>
                            <span>Sign-up fields</span>
                            <p>{event.facts.registration.formFields.join(', ')}</p>
                          </div>
                        ) : null}
                        {event.facts.registration.additionalQuestions ? (
                          <div className="is-wide">
                            <span>Additional sign-up questions</span>
                            <p>{event.facts.registration.additionalQuestions}</p>
                          </div>
                        ) : null}
                        {event.facts.registration.scholarshipAvailable ? (
                          <div className="is-wide">
                            <span>Scholarship / fundraising</span>
                            <p>
                              {event.facts.registration.scholarshipDetails ||
                                'Available; process not entered'}
                            </p>
                          </div>
                        ) : null}
                      </>
                    ) : null}
                    {event.facts.creativeBrief &&
                    (event.facts.creativeBrief.designDirection ||
                      event.facts.creativeBrief.productionDetails ||
                      event.facts.creativeBrief.otherDeliverables ||
                      event.facts.creativeBrief.quantity !== null) ? (
                      <div className="is-wide">
                        <span>Creative / production brief</span>
                        <p>
                          {[
                            event.facts.creativeBrief.designDirection,
                            event.facts.creativeBrief.productionDetails,
                            event.facts.creativeBrief.quantity !== null
                              ? `Quantity: ${event.facts.creativeBrief.quantity}`
                              : '',
                            event.facts.creativeBrief.otherDeliverables,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </div>
                    ) : null}
                    {event.facts.resourceRequests &&
                    ([
                      ...(event.facts.resourceRequests.rooms ?? []),
                      ...(event.facts.resourceRequests.transportation ?? []),
                      ...(event.facts.resourceRequests.technology ?? []),
                      ...(event.facts.resourceRequests.building ?? []),
                    ].length ||
                      event.facts.resourceRequests.notes) ? (
                      <div className="is-wide">
                        <span>Requested rooms and resources</span>
                        <p>
                          {[
                            ...(event.facts.resourceRequests.rooms ?? []),
                            ...(event.facts.resourceRequests.transportation ?? []),
                            ...(event.facts.resourceRequests.technology ?? []),
                            ...(event.facts.resourceRequests.building ?? []),
                            event.facts.resourceRequests.notes,
                          ]
                            .filter(Boolean)
                            .join(', ')}
                        </p>
                      </div>
                    ) : null}
                    <div>
                      <span>Languages</span>
                      <p>
                        {event.facts.languages
                          .map((language) =>
                            language === 'es' ? vocabulary.secondLanguageName : 'English',
                          )
                          .join(', ')}
                      </p>
                    </div>
                    <div>
                      <span>Promotion begins</span>
                      <p>{displayDate(event.facts.promotionStartDate)}</p>
                    </div>
                    {event.source ? (
                      <div className="is-wide">
                        <span>Imported source</span>
                        <p>
                          {event.source.system} · {event.source.id}
                          {event.source.url ? (
                            <a href={event.source.url} rel="noreferrer" target="_blank">
                              Open original <ExternalLink />
                            </a>
                          ) : null}
                        </p>
                      </div>
                    ) : null}
                  </div>
                )}
              </article>

              <article className="event-channel-card">
                <header>
                  <span>Selected outcomes</span>
                  <strong>{event.channels.length} routed queues</strong>
                </header>
                <div>
                  {event.channels.map((channel) => (
                    <span key={`${channel.channel}-${channel.campus}-${channel.language}`}>
                      <Check /> {channel.channel} · {channel.campus} ·{' '}
                      {channel.language.toUpperCase()}
                    </span>
                  ))}
                </div>
              </article>
            </section>

            <OriginalRequest event={event} />
            <ResponsibilitiesPanel event={event} staff={eventOptions.data?.staff ?? []} />
            <section className="event-workflow-card">
              <header>
                <div>
                  <span>Event tasks</span>
                  <strong>{event.workItems.length} coordinated tasks</strong>
                </div>
                <div className="event-workflow-header-actions">
                  <p>
                    Tasks are grouped by workflow phase. In each row, the first dropdown is the
                    assignee and the second is status.
                  </p>
                  {(event.workflowMode === 'legacy' && event.canEdit) ||
                  event.responsibilities.some((r) => r.canManage && r.status !== 'not_needed') ? (
                    <button
                      className="button-quiet"
                      onClick={() => {
                        setEditingWorkItemKey(null);
                        setCreatingWorkItem(true);
                      }}
                      type="button"
                    >
                      <Plus /> Add task
                    </button>
                  ) : null}
                </div>
              </header>
              {creatingWorkItem ? (
                <WorkItemEditor
                  event={event}
                  eventKey={eventKey}
                  key="new-event-task"
                  onClose={() => setCreatingWorkItem(false)}
                  staff={eventOptions.data?.staff ?? []}
                />
              ) : null}
              {editingWorkItem ? (
                <WorkItemEditor
                  event={event}
                  eventKey={eventKey}
                  item={editingWorkItem}
                  key={editingWorkItem.work_item_key}
                  onClose={() => setEditingWorkItemKey(null)}
                  staff={eventOptions.data?.staff ?? []}
                />
              ) : null}
              <div className="event-phase-columns">
                {phases.map(([phase, items]) => (
                  <section key={phase}>
                    <h3>
                      {phaseLabels[phase] ?? phase}
                      <span>
                        {items.filter((item) => item.status === 'done').length}/{items.length}
                      </span>
                    </h3>
                    {items.map((item) => {
                      const canUpdateStatus =
                        item.canManage || item.owner_email?.toLowerCase() === currentEmail;
                      return (
                        <div
                          className={
                            item.status === 'done'
                              ? 'is-done'
                              : item.dependency_blockers
                                ? 'is-blocked'
                                : ''
                          }
                          key={item.work_item_key}
                        >
                          <button
                            aria-label={item.status === 'done' ? 'Mark not started' : 'Mark done'}
                            disabled={
                              !canUpdateStatus ||
                              patchWorkItem.isPending ||
                              Boolean(item.dependency_blockers && item.status !== 'done')
                            }
                            onClick={() =>
                              void patchWorkItem.mutateAsync({
                                key: item.work_item_key,
                                status: item.status === 'done' ? 'not_started' : 'done',
                              })
                            }
                            type="button"
                          >
                            {item.status === 'done' ? <Check /> : null}
                          </button>
                          <span>
                            <strong>{item.title}</strong>
                            <small>
                              {item.dependency_blockers
                                ? `${item.dependency_blockers} dependencies incomplete · `
                                : ''}
                              {item.legacy ? 'Legacy work · outside readiness · ' : ''}
                              {item.responsibility_key
                                ? `${responsibilityLabels[event.responsibilities.find((r) => r.responsibility_key === item.responsibility_key)?.area ?? ''] ?? 'Responsibility'} · `
                                : ''}
                              due {displayDate(item.due_at)}
                            </small>
                          </span>
                          {item.canManage ? (
                            <label className="event-work-owner">
                              <span className="sr-only">Owner</span>
                              <select
                                aria-label={`Owner for ${item.title}`}
                                disabled={patchWorkItem.isPending}
                                onChange={(e) =>
                                  void patchWorkItem.mutateAsync({
                                    key: item.work_item_key,
                                    ownerEmail: e.target.value || null,
                                  })
                                }
                                value={item.owner_email ?? ''}
                              >
                                <option value="">Unassigned</option>
                                {(eventOptions.data?.staff ?? []).map((staff) => (
                                  <option key={staff.id} value={staff.email}>
                                    {staff.name}
                                  </option>
                                ))}
                              </select>
                            </label>
                          ) : (
                            <small>{item.owner_name ?? 'Unassigned'}</small>
                          )}
                          {canUpdateStatus ? (
                            <label>
                              <span className="sr-only">Status</span>
                              <select
                                onChange={(e) =>
                                  void patchWorkItem.mutateAsync({
                                    key: item.work_item_key,
                                    status: e.target.value as EventWorkItemStatus,
                                  })
                                }
                                value={item.status}
                              >
                                {(Object.keys(workStatusLabels) as EventWorkItemStatus[]).map(
                                  (status) => (
                                    <option key={status} value={status}>
                                      {workStatusLabels[status]}
                                    </option>
                                  ),
                                )}
                              </select>
                              <ChevronDown />
                            </label>
                          ) : null}
                          {item.canManage ? (
                            <button
                              aria-label={`Edit ${item.title}`}
                              className="icon-button event-work-edit"
                              onClick={() => {
                                setCreatingWorkItem(false);
                                setEditingWorkItemKey(item.work_item_key);
                              }}
                              title="Edit task"
                              type="button"
                            >
                              <Pencil />
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </section>
                ))}
              </div>
            </section>

            <section className="event-deliverables-card">
              <header>
                <div>
                  <span>Communication deliverables</span>
                  <strong>{event.deliverables.length} outputs</strong>
                </div>
              </header>
              <div className="events-table-wrap">
                <table className="events-table">
                  <thead>
                    <tr>
                      <th>Deliverable</th>
                      <th>Channel</th>
                      <th>Due</th>
                      <th>Status</th>
                      <th>Owner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {event.deliverables.map((deliverable) => (
                      <tr key={deliverable.deliverable_key}>
                        <td>
                          <strong>{deliverable.title}</strong>
                          <span>
                            {deliverable.campus} · {deliverable.language.toUpperCase()} · details v
                            {deliverable.fact_version}
                          </span>
                        </td>
                        <td>{deliverable.channel}</td>
                        <td>{displayDate(deliverable.due_at)}</td>
                        <td>
                          {event.canEdit ? (
                            <select
                              className={`event-status-select status-${deliverable.status}`}
                              disabled={patchDeliverable.isPending}
                              onChange={(e) =>
                                void patchDeliverable.mutateAsync({
                                  key: deliverable.deliverable_key,
                                  status: e.target.value as DeliverableStatus,
                                })
                              }
                              value={deliverable.status}
                            >
                              {(Object.keys(deliverableStatusLabels) as DeliverableStatus[]).map(
                                (status) => (
                                  <option key={status} value={status}>
                                    {deliverableStatusLabels[status]}
                                  </option>
                                ),
                              )}
                            </select>
                          ) : (
                            deliverableStatusLabels[deliverable.status]
                          )}
                        </td>
                        <td>{deliverable.owner_name ?? 'Unassigned'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}

        {tab === 'copy' ? (
          <section className="event-copy-workspace">
            <header>
              <div>
                <span className="events-eyebrow">Versioned copy</span>
                <h2>Write once, adapt by channel</h2>
                <p>
                  Every draft records which event details it used. {vocabulary.secondLanguageName}{' '}
                  can be drafted here but requires separate approval.
                </p>
              </div>
              <span className="event-ai-boundary">
                <ShieldCheck /> AI suggestions will be advisory and reviewable
              </span>
            </header>
            <div className="event-copy-grid">
              {event.copyVariants.map((variant) => (
                <CopyVariantCard event={event} key={variant.id} variant={variant} />
              ))}
            </div>
          </section>
        ) : null}

        {tab === 'assets' ? (
          <section className="event-assets-workspace">
            <header>
              <div>
                <span className="events-eyebrow">Human-created design</span>
                <h2>Assets and exact-version approval</h2>
                <p>
                  Design stays in Keynote, Adobe, Canva, or the designer's chosen tool. Tasks
                  records the file version and decision.
                </p>
              </div>
            </header>
            <div className="event-assets-grid">
              {event.deliverables
                .filter((deliverable) => !deliverable.asset_type.endsWith('_copy'))
                .map((deliverable) => (
                  <AssetCard deliverable={deliverable} event={event} key={deliverable.id} />
                ))}
            </div>
          </section>
        ) : null}

        {tab === 'activity' ? (
          <section className="event-activity-layout">
            <article className="event-comments-card">
              <header>
                <MessageSquare />
                <div>
                  <strong>Conversation</strong>
                  <span>
                    Decisions belong beside the event, while formal approval stays structured.
                  </span>
                </div>
              </header>
              <div className="event-comments-list">
                {event.comments.length ? (
                  event.comments.map((item) => (
                    <div key={item.id}>
                      <span>{item.author_name.slice(0, 1).toUpperCase()}</span>
                      <p>
                        <strong>{item.author_name}</strong>
                        <small>{new Date(item.created_at).toLocaleString()}</small>
                        {item.body}
                        {item.source_system ? <em>Imported from {item.source_system}</em> : null}
                      </p>
                    </div>
                  ))
                ) : (
                  <p>No conversation yet.</p>
                )}
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!comment.trim()) return;
                  void createComment.mutateAsync(comment).then(() => setComment(''));
                }}
              >
                <MentionTextarea
                  maxLength={10000}
                  onChange={setComment}
                  people={eventOptions.data?.staff ?? []}
                  rows={3}
                  value={comment}
                />
                <button
                  className="button-primary"
                  disabled={!comment.trim() || createComment.isPending}
                  type="submit"
                >
                  <Send /> Comment
                </button>
              </form>
            </article>
            <article className="event-history-card">
              <header>
                <History />
                <div>
                  <strong>Immutable history</strong>
                  <span>
                    Facts, versions, status changes, imports, and approvals remain attributable.
                  </span>
                </div>
              </header>
              <div>
                {event.activity.map((item) => (
                  <div key={item.id}>
                    <span />
                    <p>
                      <strong>{item.action.replaceAll('.', ' ')}</strong>
                      <small>
                        {item.actor_name} · {new Date(item.created_at).toLocaleString()}
                      </small>
                    </p>
                  </div>
                ))}
              </div>
            </article>
          </section>
        ) : null}
      </main>
    </div>
  );
}
