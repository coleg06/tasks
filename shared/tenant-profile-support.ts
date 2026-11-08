import type { TenantProfile } from './tenant-profile.ts';
import { tenantProfile } from './tenant-profile.ts';

/**
 * Profile additions that are optional, owned by the base rather than by a deployment's replacement
 * of `shared/tenant-profile.ts`. A deployment profile that predates them still compiles; base code
 * reads them only through `tenantExtensions`, which treats every field as optional. Absent fields
 * mean the neutral behavior (no integration, neutral vocabulary, `X-Tasks` header prefixes).
 */
export type TenantProfileExtensions = {
  integrations?: {
    emailGateway?: {
      /** Prefix of the signed request headers sent to the gateway. Default `X-Tasks`. */
      headerPrefix?: string;
    };
    mobileGateway?: {
      /** Prefix of the assertion headers accepted from the gateway. Default `X-Tasks`. */
      headerPrefix?: string;
    };
    /** Outbound task-alert publisher. Absent: alert publishing stays disabled. */
    portalAlerts?: {
      endpoint: string;
      /** Prefix of the signed request headers. Default `X-Tasks`. */
      headerPrefix?: string;
    };
    /** Inbound support-ticket ingestion. Absent: tickets are rejected. */
    portalSupport?: {
      /** Hostnames a ticket link may point at. */
      ticketHosts: readonly string[];
      /** Emails a ticket may name as its owner. Empty: any hosted email is accepted. */
      ownerEmails: readonly string[];
      /** Preferred actor for imported tickets, when that user is active. */
      actorEmail?: string;
    };
    /** Inbound design requests. Absent: the endpoint answers 503. */
    portalDesign?: {
      /** Allowed nonempty campus keys and their display labels. Empty campus is always allowed. */
      campusLabels?: Readonly<Record<string, string>>;
      projectKey: string;
      assigneeEmail: string;
      actorEmail: string;
      /** A fixed lane, or the deployment's ENVIRONMENT binding for multi-lane builds. */
      environment: 'dev' | 'production' | 'deployment';
    };
    /** Event-intake assistant. Absent: no model endpoint is accepted. */
    eventAssist?: {
      /** Hostnames of the model endpoint EVENT_AI_ENDPOINT may point at. */
      allowedHosts: readonly string[];
    };
  };
  /** Event-planning vocabulary. Absent fields fall back to `DEFAULT_EVENT_VOCABULARY`. */
  events?: Partial<EventVocabulary>;
};

export type EventVocabulary = {
  /** Ministry/team presets offered when an event is requested. */
  ministryPresets: readonly string[];
  /** Destination (campus) selected for a ministry, by lower-case unaccented ministry name. */
  destinationsByMinistry: Readonly<Record<string, readonly string[]>>;
  /** Destinations (campuses) an event or the assistant may name. */
  destinations: readonly string[];
  defaultDestination: string;
  defaultLocation: string;
  defaultTimezone: string;
  rooms: readonly string[];
  technology: readonly string[];
  transportation: readonly string[];
  buildingResources: readonly string[];
  registrationFields: readonly string[];
  /** Singular user-visible name of the coordinating group an event belongs to. */
  ministryLabel: string;
  /** User-visible name of where an event happens (a destination or site). */
  destinationLabel: string;
  /** Unit of the promotion lead time ("5-Week promotion window"). */
  weekLabel: string;
  /** User-visible name of the second language the translation workflow supports. */
  secondLanguageName: string;
  /** Name of the on-site announcement screen: `<name> slide`, `<name> screen slide`. */
  screenName: string;
  /** Name of the recurring program the event workflow writes copy for. */
  programLabel: string;
  /** Organization named in the event-assistant prompt. */
  assistantOrganization: string;
};

export const DEFAULT_EVENT_VOCABULARY: EventVocabulary = {
  ministryPresets: ['General'],
  destinationsByMinistry: {},
  destinations: ['Main', 'Online'],
  defaultDestination: 'Main',
  defaultLocation: 'Main location',
  defaultTimezone: 'UTC',
  rooms: ['Main room', 'Meeting room', 'Lobby', 'Outdoor space', 'Off-site event'],
  technology: [
    'Live sound',
    'Lighting',
    'Projection / slides',
    'Video recording',
    'Audio recording',
    'Laptop',
    'Portable sound system',
  ],
  transportation: ['Vehicle', 'Trailer'],
  buildingResources: [
    'Tables',
    'Chairs',
    'Trash cans',
    'Portable restrooms',
    'Outdoor electricity',
  ],
  registrationFields: [
    'Liability waiver',
    'Transportation waiver',
    'Scholarship request',
    'Volunteer interest',
    'Ticket sales',
    'T-shirt size',
  ],
  ministryLabel: 'Team',
  destinationLabel: 'Location',
  weekLabel: 'Week',
  secondLanguageName: 'Second language',
  screenName: 'Announcement',
  programLabel: 'Program',
  assistantOrganization: 'an organization',
};

export function tenantExtensions(profile: TenantProfile = tenantProfile): TenantProfileExtensions {
  return profile as unknown as TenantProfileExtensions;
}

export function tenantEventVocabulary(profile: TenantProfile = tenantProfile): EventVocabulary {
  // An explicitly undefined field must not erase a default.
  const defined = Object.fromEntries(
    Object.entries(tenantExtensions(profile).events ?? {}).filter(
      ([, value]) => value !== undefined,
    ),
  );
  return { ...DEFAULT_EVENT_VOCABULARY, ...defined };
}
