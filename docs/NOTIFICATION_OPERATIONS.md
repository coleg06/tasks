# Notification operations

Workflow email defaults to immediate delivery for assignments, comments, and mentions. The
existing deadline scan combines work due today, tomorrow, or in three days into one daily
email per recipient. Existing category email opt-outs remain off. New preferences are additive.

## Hard limits and suppression

The deployment-wide default is **five email attempts per rolling 60 seconds** across all
recipients and categories, including digests. This applies to the database for this deployment;
it does not coordinate unrelated organizations or databases. Platform administrators can change
it in **Administration → Overview → Email limits**, from zero (disabled) through 1,000. Updates
and their audit records commit together. Task managers without `platform.admin` cannot change it.

Each person defaults to **five email attempts per rolling day**. Preferences offers a configurable cap from zero through 1,000,
including zero to disable all workflow email, and a rolling hour, day, or week. Five per day keeps
routine activity from becoming a stream of mail; choosing one per week provides a stronger bound.
The personal period and platform minute limit are independent: a user may choose 20 per week
while the platform still allows only five per minute. Both limits must permit each attempt. Counts span
all categories and both immediate messages and summaries. Saving preferences never resets usage.

Both quotas are checked and consumed by one atomic `INSERT SELECT` on SQLite or D1.
Every send then atomically rechecks both current limits and claims its reservation once with an
`UPDATE` immediately before the gateway request. Expired reservations cannot send. Signing is
finished before this check. A submission must start within five seconds of the final claim call;
quota remains charged through that deadline (rounded up by one second), then for the full rolling
period. This conservative accounting can suppress additional mail for up to six seconds rather
than exceed a limit when a database response is delayed. There is no
process-local limiter. A failed gateway request or process interruption still consumes its
reservation. Dedupe ownership also uses a unique database insert, so competing callers cannot
submit the same email twice.

**Excess immediate email is terminally suppressed. It is never queued, retried, or delivered in a
later minute.** Delivery records use `status = skipped` and `error_code = quota_suppressed`.
Failed, interrupted, accepted, and suppressed attempts are all terminal for their dedupe key.
There is no automatic email retry job. A stuck `pending` record is an interrupted attempt, not
work to drain. Portal inbox/push retries remain separate and do not send email.

## Category delivery choices

Each category supports **Immediate, Hourly, Daily, Weekly, or Off**. These choices affect email;
Portal inbox and push choices remain independent. Legacy boolean preferences still work: false
suppresses the category, and existing enabled categories default to immediate.

Digest choices aggregate references to work, never deferred individual messages. Categories
with the same interval share one summary, containing up to 25 item references across the
categories. Repeated activity on the same item/category is folded into one reference; overflow
is discarded. A summary displays current item titles and links, not the original comment body.
Hourly boundaries are the hour in UTC, daily boundaries are midnight UTC, and weekly boundaries
are Monday midnight UTC. Users can therefore choose different intervals for different categories,
with at most one summary per selected interval. The deadline scan still runs at 13:00 UTC; a
chosen interval collects those references into its next boundary instead of sending the default
deadline email.

At preparation, one atomic database snapshot checks the recipient's current category choices, workspace
membership, project visibility/membership, task/event permissions, and archive state. The summary includes
current titles only for accessible items. Completed or reassigned deadline items are excluded.
Inactive recipients cannot send. Changing email policy clears existing digest references.

The runner atomically claims the entire due cohort before preparation, including all recipients
it may later suppress. It prepares admission decisions for the entire cohort before any gateway
request, using at most five concurrent operations. Quota is evaluated against the fixed dispatch
start, and no scheduled send may start 60 seconds after that start or beyond the summary's
five-minute grace. Reservations are advanced to the bounded send deadline before gateway requests. Immediate
messages use the same atomic send claim and expiry checks as scheduled messages.
A daily deadline run is also claimed once before work starts. A crash cannot leave other
recipients available to consume a later quota window. If quota blocks a summary, it is suppressed permanently. Empty, failed, or interrupted summaries do not retry.
A due interval has a five-minute scheduling grace; intervals older than that are deleted. Each
digest or daily deadline run prepares at most 50 recipients; overflow due recipients are discarded in that run so they
cannot consume the next minute's newly available quota. This is deliberately lossy under load
or downtime: there is no old-event backlog or catch-up stream.

## Storage and retention

No email body, recipient address, or comment text is stored in digest aggregation. Each recipient
can retain at most 25 references per frequency and boundary, with the current bucket and a briefly
due previous bucket. Keys are capped at 100 characters and displayed titles/context at 240 each.
The minute job deletes expired buckets (cascading to references), granted quota reservations
outside the longest rolling week, and delivery/dispatch records older than 30 days. A unique delivery
key therefore provides a 30-day dedupe horizon. The source produces fresh activity, not a replay
of historical events. Do not replay old events or delete current quota/delivery rows as an incident
response: those actions can bypass intentional suppression.

## Runtime integration

Migration `0021_email_delivery_preferences.sql` must be applied before starting this code. It is
additive and contains only neutral settings and schema; no new environment fields are needed.
The application registers these functions after the existing authenticated API, tenant-verification,
and CSRF middleware, alongside the account/admin route registrations:

```ts
import { registerAccountEmailRoutes } from './account/email';
import { registerAdminEmailRoutes } from './admin/email-settings';

registerAccountEmailRoutes(app);
registerAdminEmailRoutes(app);
```

The new routes are `GET/PATCH /api/account/email-preferences` and
`GET/PATCH /api/admin/email-settings`. Both require current authorization and the email capability.
The existing `PATCH /api/account/preferences` also accepts `emailDelivery`, allowing the web
preferences form to save all choices atomically. The UI fetches email policy independently, so
bootstrap needs no new field. Email settings responses contain `{ settings: { perMinute } }`;
personal reads include `{ preferences, settings }` and writes accept the full preference object.

The shared scheduled job table adds `email_digests` on `* * * * *`. The self-hosted scheduler uses
that table directly. A deployment's Cloudflare cron configuration must additionally register
`* * * * *`, preserving `0 13 * * *` and `*/5 * * * *`. The Worker dispatches matching expressions
through the shared table and fresh tenant verification. Central source changes do not deploy
or mutate tenant cron configuration.

## Delivery safeguards and administration

Automatic email remains production-only and requires the profile capability plus the exact
configured gateway origin, client identity, sender, and valid secret. Tests use synthetic users
and mocked gateway calls, never live email. Portal inbox/push outbox rows require their own
configured publisher and retain their existing retry behavior.

The Administration notification view shows accepted/failed email counts, stalled pending records,
Portal delivery health, environment policy, and recent delivery metadata. A suppressed email is
shown as skipped, with `quota_suppressed` in its error metadata. Records contain recipient and
entity references, gateway request ID, status, error code, and timestamps, without email bodies
or credentials.

For an incident, first confirm environment policy and current caps. Inspect suppression and
failure records; correlate gateway request IDs without resending accepted or suppressed events.
Leave manual live email smoke tests unrun. An `accepted` record means the gateway accepted the
request; mailbox delivery remains the email service's responsibility.
