import { Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, CalendarDays, Check, Clock3, LoaderCircle, MapPin } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { defaultRuntimeFeatures } from '../../../shared/runtime-features';
import { tenantProfile } from '../../../shared/tenant-profile';
import { tenantEventVocabulary } from '../../../shared/tenant-profile-support';
import { useBootstrap, useCreateEvent, useEventOptions } from '../api/queries';
import type { EventIntake } from '../api/types';
import { destinationsForMinistry } from '../events/ministry-destinations';
import { coordinationOptions, creativeOptions } from '../events/request-options';

const vocabulary = tenantEventVocabulary(tenantProfile);
const registrationFieldOptions = vocabulary.registrationFields;
const roomOptions = vocabulary.rooms;
const technologyOptions = vocabulary.technology;
const transportationOptions = vocabulary.transportation;
const buildingOptions = vocabulary.buildingResources;

function futureDate(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function toggleValue<T extends string>(values: T[], value: T) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function NewEventPage() {
  const navigate = useNavigate();
  const bootstrap = useBootstrap();
  const features = bootstrap.data?.features ?? defaultRuntimeFeatures;
  const enabled = features.eventPlanning;
  const options = useEventOptions(enabled && Boolean(bootstrap.data?.user));
  const create = useCreateEvent();
  const [error, setError] = useState('');
  const [revealedStage, setRevealedStage] = useState(1);
  const pageRef = useRef<HTMLDivElement>(null);
  const stageRefs = useRef<Array<HTMLElement | null>>([]);
  const alignmentTimerRef = useRef<number | undefined>(undefined);
  const [input, setInput] = useState<EventIntake>({
    templateKey: 'standard',
    requestApprovalConfirmed: false,
    title: '',
    purpose: '',
    ministry: '',
    communicationPriority: null,
    ownerEmail: bootstrap.data?.user?.email ?? null,
    campuses: [vocabulary.defaultDestination],
    audience: '',
    startDate: futureDate(60),
    endDate: null,
    startTime: '18:00',
    endTime: null,
    timezone: vocabulary.defaultTimezone,
    location: vocabulary.defaultLocation,
    registration: {
      required: false,
      url: null,
      openDate: null,
      closeDate: null,
      cost: null,
      capacity: null,
      accountCode: '',
      scholarshipAvailable: false,
      scholarshipDetails: '',
      formFields: [],
      additionalQuestions: '',
    },
    channels: [],
    languages: ['en'],
    operations: [],
    recurrence: { kind: 'none', notes: '' },
    priorEvent: { heldBefore: false, sameAsPrevious: null, previousName: '' },
    communicationBrief: '',
    creativeBrief: {
      designDirection: '',
      productionDetails: '',
      quantity: null,
      otherDeliverables: '',
    },
    resourceRequests: {
      rooms: [],
      transportation: [],
      technology: [],
      building: [],
      notes: '',
    },
    notes: '',
  });

  useEffect(() => {
    const email = bootstrap.data?.user?.email;
    if (email) {
      setInput((current) => (current.ownerEmail ? current : { ...current, ownerEmail: email }));
    }
  }, [bootstrap.data?.user?.email]);

  useEffect(() => {
    if (revealedStage >= 4) return;

    const page = pageRef.current;
    const nextStageNumber = revealedStage + 1;
    const nextStage = stageRefs.current[nextStageNumber];
    if (!page || !nextStage) return;

    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      setRevealedStage(4);
      return;
    }

    if (typeof IntersectionObserver === 'undefined') {
      setRevealedStage(4);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;

        observer.disconnect();
        setRevealedStage((current) => Math.max(current, nextStageNumber));

        alignmentTimerRef.current = window.setTimeout(() => {
          const pageRect = page.getBoundingClientRect();
          const stageRect = nextStage.getBoundingClientRect();
          page.scrollTo({
            top: Math.max(0, page.scrollTop + stageRect.top - pageRect.top - 16),
            behavior: 'smooth',
          });
        }, 80);
      },
      {
        root: page,
        rootMargin: '0px 0px -12% 0px',
        threshold: 0.5,
      },
    );

    observer.observe(nextStage);
    return () => {
      observer.disconnect();
    };
  }, [revealedStage]);

  useEffect(
    () => () => {
      if (alignmentTimerRef.current !== undefined) {
        window.clearTimeout(alignmentTimerRef.current);
      }
    },
    [],
  );

  function scrollToFormStart() {
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    pageRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function validate() {
    if (!input.title.trim() || !input.purpose.trim() || !input.ministry.trim()) {
      return `Add the event name, what it is, and the coordinating ${vocabulary.ministryLabel.toLowerCase()}.`;
    }
    if (!input.audience.trim()) return 'Identify who this event is for.';
    if (!input.startDate || !input.startTime || !input.location.trim()) {
      return 'Add the event date, start time, and location.';
    }
    return '';
  }

  async function submit() {
    const message = validate();
    if (message) {
      setError(message);
      scrollToFormStart();
      return;
    }
    setError('');
    try {
      const result = await create.mutateAsync(input);
      await navigate({
        to: '/events/$eventKey',
        params: { eventKey: result.event.key },
        search: { view: 'open' },
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'The event request could not be created.',
      );
      scrollToFormStart();
    }
  }

  if (!enabled) {
    return (
      <div className="events-access">
        <CalendarDays aria-hidden="true" />
        <h1>Event planning is disabled</h1>
        <p>This deployment has the event-planning module turned off.</p>
      </div>
    );
  }

  const hasCreativeRequest = input.channels.some((channel) => channel !== 'calendar');

  return (
    <div className="event-intake-page event-request-page" ref={pageRef}>
      <header className="events-topbar event-intake-topbar">
        <div className="event-intake-heading">
          <Link
            aria-label="Back to events"
            className="icon-button"
            search={{ view: 'open' }}
            to="/events"
          >
            <ArrowLeft />
          </Link>
          <div>
            <span className="events-eyebrow">Events</span>
            <h1>Event Request Form</h1>
          </div>
        </div>
      </header>

      <main className="event-request-form">
        {error ? (
          <div className="event-form-error" role="alert">
            {error}
          </div>
        ) : null}

        <section className="event-request-approval">
          <label>
            <input
              checked={input.requestApprovalConfirmed}
              onChange={(event) =>
                setInput({ ...input, requestApprovalConfirmed: event.target.checked })
              }
              type="checkbox"
            />
            <span>
              <strong>This event has been approved</strong>
              <small>
                Check this once the appropriate {vocabulary.ministryLabel.toLowerCase()} leader has
                approved the event. Leave it unchecked while approval is pending.
              </small>
            </span>
            <Check aria-hidden="true" />
          </label>
        </section>

        <section className="event-request-section event-request-stage is-initial is-revealed">
          <header>
            <span>1</span>
            <div>
              <h2>What is this event?</h2>
            </div>
          </header>

          <div className="event-form-grid">
            <label className="is-wide">
              <span>Event name</span>
              <input
                maxLength={240}
                onChange={(event) => setInput({ ...input, title: event.target.value })}
                placeholder="Spring community picnic"
                value={input.title}
              />
            </label>
            <label>
              <span>Coordinating {vocabulary.ministryLabel.toLowerCase()}</span>
              <input
                list="coordinating-ministries"
                maxLength={120}
                onChange={(event) =>
                  setInput({
                    ...input,
                    ministry: event.target.value,
                    campuses: destinationsForMinistry(event.target.value, input.campuses),
                  })
                }
                placeholder={`Choose or type a ${vocabulary.ministryLabel.toLowerCase()}`}
                value={input.ministry}
              />
              <datalist id="coordinating-ministries">
                {(options.data?.ministries ?? []).map((ministry) => (
                  <option key={ministry} value={ministry} />
                ))}
              </datalist>
            </label>
            <label>
              <span>Event owner</span>
              <select
                onChange={(event) => setInput({ ...input, ownerEmail: event.target.value || null })}
                value={input.ownerEmail ?? ''}
              >
                <option value="">Current requester</option>
                {(options.data?.staff ?? []).map((staff) => (
                  <option key={staff.id} value={staff.email}>
                    {staff.name} · {staff.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="is-wide">
              <span>What is it?</span>
              <textarea
                maxLength={2000}
                onChange={(event) => setInput({ ...input, purpose: event.target.value })}
                placeholder="Describe the event and why it is happening."
                rows={3}
                value={input.purpose}
              />
            </label>
            <label className="is-wide">
              <span>Who is it for?</span>
              <input
                maxLength={500}
                onChange={(event) => setInput({ ...input, audience: event.target.value })}
                placeholder="Who should attend or respond?"
                value={input.audience}
              />
            </label>
            <label className="is-wide">
              <span>What should people know?</span>
              <textarea
                maxLength={5000}
                onChange={(event) => setInput({ ...input, communicationBrief: event.target.value })}
                placeholder="Important details, the invitation, and anything that must be communicated. Finished promotional copy is not required."
                rows={4}
                value={input.communicationBrief}
              />
            </label>
          </div>

          <div className="event-form-grid event-date-grid">
            <label>
              <span>
                <CalendarDays /> Date
              </span>
              <input
                onChange={(event) => setInput({ ...input, startDate: event.target.value })}
                type="date"
                value={input.startDate}
              />
            </label>
            <label>
              <span>End date (if multi-day)</span>
              <input
                min={input.startDate}
                onChange={(event) => setInput({ ...input, endDate: event.target.value || null })}
                type="date"
                value={input.endDate ?? ''}
              />
            </label>
            <label>
              <span>
                <Clock3 /> Starts
              </span>
              <input
                onChange={(event) => setInput({ ...input, startTime: event.target.value })}
                type="time"
                value={input.startTime}
              />
            </label>
            <label>
              <span>
                <Clock3 /> Ends
              </span>
              <input
                onChange={(event) => setInput({ ...input, endTime: event.target.value || null })}
                type="time"
                value={input.endTime ?? ''}
              />
            </label>
            <label className="is-wide">
              <span>
                <MapPin /> Location
              </span>
              <input
                onChange={(event) => setInput({ ...input, location: event.target.value })}
                placeholder="Room name or full off-site address"
                value={input.location}
              />
            </label>
          </div>

          <div className="event-form-grid">
            <label>
              <span>Has {tenantProfile.organizationName} done this before?</span>
              <select
                onChange={(event) => {
                  const heldBefore = event.target.value !== 'new';
                  setInput({
                    ...input,
                    priorEvent: {
                      ...input.priorEvent,
                      heldBefore,
                      sameAsPrevious:
                        event.target.value === 'same'
                          ? true
                          : event.target.value === 'changed'
                            ? false
                            : null,
                    },
                  });
                }}
                value={
                  !input.priorEvent.heldBefore
                    ? 'new'
                    : input.priorEvent.sameAsPrevious
                      ? 'same'
                      : 'changed'
                }
              >
                <option value="new">No — this is new</option>
                <option value="same">Yes — substantially the same</option>
                <option value="changed">Yes — but details changed</option>
              </select>
            </label>
            {input.priorEvent.heldBefore ? (
              <label>
                <span>Previous event name</span>
                <input
                  maxLength={240}
                  onChange={(event) =>
                    setInput({
                      ...input,
                      priorEvent: { ...input.priorEvent, previousName: event.target.value },
                    })
                  }
                  value={input.priorEvent.previousName}
                />
              </label>
            ) : null}
            <label>
              <span>Recurrence</span>
              <select
                onChange={(event) =>
                  setInput({
                    ...input,
                    recurrence: {
                      ...input.recurrence,
                      kind: event.target.value as EventIntake['recurrence']['kind'],
                    },
                  })
                }
                value={input.recurrence.kind}
              >
                <option value="none">One-time event</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </label>
          </div>

          <div className="event-toggle-card">
            <div>
              <strong>Do people need to register or respond?</strong>
              <p>This can be a form, group, RSVP, ticket, or another response path.</p>
            </div>
            <label className="switch">
              <input
                aria-label="Registration required"
                checked={input.registration.required}
                onChange={(event) =>
                  setInput({
                    ...input,
                    registration: { ...input.registration, required: event.target.checked },
                  })
                }
                type="checkbox"
              />
              <span />
            </label>
          </div>

          {input.registration.required ? (
            <div className="event-form-grid">
              <label className="is-wide">
                <span>Registration URL</span>
                <input
                  onChange={(event) =>
                    setInput({
                      ...input,
                      registration: { ...input.registration, url: event.target.value || null },
                    })
                  }
                  placeholder="Can be added later"
                  type="url"
                  value={input.registration.url ?? ''}
                />
              </label>
              <label>
                <span>Registration opens</span>
                <input
                  onChange={(event) =>
                    setInput({
                      ...input,
                      registration: {
                        ...input.registration,
                        openDate: event.target.value || null,
                      },
                    })
                  }
                  type="date"
                  value={input.registration.openDate ?? ''}
                />
              </label>
              <label>
                <span>Sign-up deadline</span>
                <input
                  onChange={(event) =>
                    setInput({
                      ...input,
                      registration: {
                        ...input.registration,
                        closeDate: event.target.value || null,
                      },
                    })
                  }
                  type="date"
                  value={input.registration.closeDate ?? ''}
                />
              </label>
              <label>
                <span>Capacity</span>
                <input
                  min="1"
                  onChange={(event) =>
                    setInput({
                      ...input,
                      registration: {
                        ...input.registration,
                        capacity: event.target.value ? Number(event.target.value) : null,
                      },
                    })
                  }
                  type="number"
                  value={input.registration.capacity ?? ''}
                />
              </label>
              <label>
                <span>Cost</span>
                <span className="event-money-input">
                  <span aria-hidden="true">$</span>
                  <input
                    min="0"
                    onChange={(event) =>
                      setInput({
                        ...input,
                        registration: {
                          ...input.registration,
                          cost: event.target.value === '' ? null : Number(event.target.value),
                        },
                      })
                    }
                    placeholder="0"
                    step="0.01"
                    type="number"
                    value={input.registration.cost ?? ''}
                  />
                </span>
              </label>
              {input.registration.cost !== null && input.registration.cost > 0 ? (
                <label>
                  <span>Chart of accounts</span>
                  <input
                    maxLength={120}
                    onChange={(event) =>
                      setInput({
                        ...input,
                        registration: {
                          ...input.registration,
                          accountCode: event.target.value,
                        },
                      })
                    }
                    value={input.registration.accountCode}
                  />
                </label>
              ) : null}
              <label className="event-checkbox-field is-wide">
                <input
                  aria-label="Scholarship or fundraising available"
                  checked={input.registration.scholarshipAvailable}
                  onChange={(event) =>
                    setInput({
                      ...input,
                      registration: {
                        ...input.registration,
                        scholarshipAvailable: event.target.checked,
                      },
                    })
                  }
                  type="checkbox"
                />
                <span>Scholarship or fundraising is available</span>
              </label>
              {input.registration.scholarshipAvailable ? (
                <label className="is-wide">
                  <span>Scholarship or fundraising process</span>
                  <textarea
                    maxLength={2000}
                    onChange={(event) =>
                      setInput({
                        ...input,
                        registration: {
                          ...input.registration,
                          scholarshipDetails: event.target.value,
                        },
                      })
                    }
                    placeholder="Explain how someone requests help and who follows up."
                    rows={3}
                    value={input.registration.scholarshipDetails}
                  />
                </label>
              ) : null}
              <fieldset className="event-resource-grid is-wide">
                <legend>Additional sign-up fields</legend>
                {registrationFieldOptions.map((field) => (
                  <label
                    className={input.registration.formFields.includes(field) ? 'is-selected' : ''}
                    key={field}
                  >
                    <input
                      checked={input.registration.formFields.includes(field)}
                      onChange={() =>
                        setInput({
                          ...input,
                          registration: {
                            ...input.registration,
                            formFields: toggleValue(input.registration.formFields, field),
                          },
                        })
                      }
                      type="checkbox"
                    />
                    <span>{field}</span>
                  </label>
                ))}
              </fieldset>
              <label className="is-wide">
                <span>Registration questions or special requirements</span>
                <textarea
                  maxLength={4000}
                  onChange={(event) =>
                    setInput({
                      ...input,
                      registration: {
                        ...input.registration,
                        additionalQuestions: event.target.value,
                      },
                    })
                  }
                  placeholder="Waivers, scholarships, ticketing, shirts, or other questions"
                  rows={3}
                  value={input.registration.additionalQuestions}
                />
              </label>
            </div>
          ) : null}
        </section>

        <section
          className={`event-request-section event-request-stage ${
            revealedStage >= 2 ? 'is-revealed' : 'is-pending'
          }`}
          ref={(element) => {
            stageRefs.current[2] = element;
          }}
        >
          <header>
            <span>2</span>
            <div>
              <h2>What creative things do you need?</h2>
              <p>Choose only the specific finished pieces needed for this event.</p>
            </div>
          </header>

          <fieldset className="event-channel-grid event-request-options">
            <legend className="sr-only">Creative requests</legend>
            {creativeOptions.map((option) => (
              <label
                className={input.channels.includes(option.channel) ? 'is-selected' : ''}
                key={option.channel}
              >
                <input
                  checked={input.channels.includes(option.channel)}
                  onChange={() =>
                    setInput({
                      ...input,
                      channels: toggleValue(input.channels, option.channel),
                    })
                  }
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

          {hasCreativeRequest ? (
            <div className="event-form-grid">
              <label className="is-wide">
                <span>Creative direction or references</span>
                <textarea
                  maxLength={4000}
                  onChange={(event) =>
                    setInput({
                      ...input,
                      creativeBrief: {
                        ...input.creativeBrief,
                        designDirection: event.target.value,
                      },
                    })
                  }
                  placeholder="Visual ideas, an older event to reference, or important constraints. Designers make the final design decisions."
                  rows={3}
                  value={input.creativeBrief.designDirection}
                />
              </label>
              {input.channels.includes('print') || input.channels.includes('physical') ? (
                <>
                  <label className="is-wide">
                    <span>Handout or sign details</span>
                    <textarea
                      maxLength={4000}
                      onChange={(event) =>
                        setInput({
                          ...input,
                          creativeBrief: {
                            ...input.creativeBrief,
                            productionDetails: event.target.value,
                          },
                        })
                      }
                      placeholder="Required text, size, placement, delivery location, or other specifications"
                      rows={3}
                      value={input.creativeBrief.productionDetails}
                    />
                  </label>
                  <label>
                    <span>Quantity</span>
                    <input
                      min="0"
                      onChange={(event) =>
                        setInput({
                          ...input,
                          creativeBrief: {
                            ...input.creativeBrief,
                            quantity: event.target.value ? Number(event.target.value) : null,
                          },
                        })
                      }
                      type="number"
                      value={input.creativeBrief.quantity ?? ''}
                    />
                  </label>
                </>
              ) : null}
              <label>
                <span>Language</span>
                <select
                  onChange={(event) =>
                    setInput({
                      ...input,
                      languages: event.target.value === 'both' ? ['en', 'es'] : ['en'],
                    })
                  }
                  value={input.languages.includes('es') ? 'both' : 'en'}
                >
                  <option value="en">English</option>
                  <option value="both">English and {vocabulary.secondLanguageName}</option>
                </select>
              </label>
            </div>
          ) : null}
        </section>

        <section
          className={`event-request-section event-request-stage ${
            revealedStage >= 3 ? 'is-revealed' : 'is-pending'
          }`}
          ref={(element) => {
            stageRefs.current[3] = element;
          }}
        >
          <header>
            <span>3</span>
            <div>
              <h2>Facilities and special requests</h2>
              <p>Select the teams or resources this event needs, then explain anything unusual.</p>
            </div>
          </header>

          <fieldset className="event-channel-grid event-request-options">
            <legend className="sr-only">Facilities and coordination requests</legend>
            {coordinationOptions.map((option) => (
              <label
                className={input.operations.includes(option.operation) ? 'is-selected' : ''}
                key={option.operation}
              >
                <input
                  checked={input.operations.includes(option.operation)}
                  onChange={() =>
                    setInput({
                      ...input,
                      operations: toggleValue(input.operations, option.operation),
                    })
                  }
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

          {input.operations.includes('facilities') ? (
            <>
              <fieldset className="event-resource-grid">
                <legend>Rooms and spaces</legend>
                {roomOptions.map((resource) => (
                  <label
                    className={input.resourceRequests.rooms.includes(resource) ? 'is-selected' : ''}
                    key={resource}
                  >
                    <input
                      checked={input.resourceRequests.rooms.includes(resource)}
                      onChange={() =>
                        setInput({
                          ...input,
                          resourceRequests: {
                            ...input.resourceRequests,
                            rooms: toggleValue(input.resourceRequests.rooms, resource),
                          },
                        })
                      }
                      type="checkbox"
                    />
                    <span>{resource}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="event-resource-grid">
                <legend>Building resources</legend>
                {buildingOptions.map((resource) => (
                  <label
                    className={
                      input.resourceRequests.building.includes(resource) ? 'is-selected' : ''
                    }
                    key={resource}
                  >
                    <input
                      checked={input.resourceRequests.building.includes(resource)}
                      onChange={() =>
                        setInput({
                          ...input,
                          resourceRequests: {
                            ...input.resourceRequests,
                            building: toggleValue(input.resourceRequests.building, resource),
                          },
                        })
                      }
                      type="checkbox"
                    />
                    <span>{resource}</span>
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}

          {input.operations.includes('production') ? (
            <fieldset className="event-resource-grid">
              <legend>Technology resources</legend>
              {technologyOptions.map((resource) => (
                <label
                  className={
                    input.resourceRequests.technology.includes(resource) ? 'is-selected' : ''
                  }
                  key={resource}
                >
                  <input
                    checked={input.resourceRequests.technology.includes(resource)}
                    onChange={() =>
                      setInput({
                        ...input,
                        resourceRequests: {
                          ...input.resourceRequests,
                          technology: toggleValue(input.resourceRequests.technology, resource),
                        },
                      })
                    }
                    type="checkbox"
                  />
                  <span>{resource}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {input.operations.includes('transportation') ? (
            <fieldset className="event-resource-grid">
              <legend>Transportation resources</legend>
              {transportationOptions.map((resource) => (
                <label
                  className={
                    input.resourceRequests.transportation.includes(resource) ? 'is-selected' : ''
                  }
                  key={resource}
                >
                  <input
                    checked={input.resourceRequests.transportation.includes(resource)}
                    onChange={() =>
                      setInput({
                        ...input,
                        resourceRequests: {
                          ...input.resourceRequests,
                          transportation: toggleValue(
                            input.resourceRequests.transportation,
                            resource,
                          ),
                        },
                      })
                    }
                    type="checkbox"
                  />
                  <span>{resource}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          <label className="event-standalone-field">
            <span>Special requests, needs, or setup details</span>
            <textarea
              maxLength={5000}
              onChange={(event) => {
                setInput({
                  ...input,
                  notes: event.target.value,
                  resourceRequests: { ...input.resourceRequests, notes: event.target.value },
                });
              }}
              placeholder="Childcare, accessibility, food details, room setup, quantities, delivery needs, volunteer needs, or anything else the teams should know"
              rows={5}
              value={input.notes}
            />
          </label>
        </section>

        <footer
          className={`event-request-actions event-request-final-stage ${
            revealedStage >= 4 ? 'is-revealed' : 'is-pending'
          }`}
          ref={(element) => {
            stageRefs.current[4] = element;
          }}
        >
          <div className="event-request-final-copy">
            <span className="event-request-stage-number">4</span>
            <div>
              <strong>Review and send</strong>
              <span>
                Confirm the details above, then assign accountable owners in the event workspace.
              </span>
            </div>
          </div>
          <button
            className="button-primary"
            disabled={create.isPending}
            onClick={() => void submit()}
            type="button"
          >
            {create.isPending ? <LoaderCircle className="is-spinning" /> : <Check />}
            {create.isPending ? 'Creating request…' : 'Create event request'}
          </button>
        </footer>
      </main>
    </div>
  );
}
