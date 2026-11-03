# Tasks

A task and project tracker with an optional event-planning module and an MCP interface for AI
agents. One application (Hono API, React web UI) runs either on **Cloudflare Workers + D1 + R2** or
**self-hosted on Node with SQLite and the local filesystem**.

- Tasks, projects, comments, assignments, notifications, audit history
- Optional **events** module (event requests, workflow plans, responsibilities, analytics),
  enabled by `FEATURE_MODULES` and the build-time tenant profile
- Stateless MCP endpoint (`/mcp`) and a headless task-service API (`/api/task-service/v1`)
- Sign-in with Google, or identity headers from your own reverse proxy (oauth2-proxy, Authentik, ...)
- MIT licensed

## Run it with Docker (SQLite, filesystem storage)

Requires Docker. From a checkout of this repository:

```sh
docker build -t tasks .
```

Create `tasks.env` from [`examples/google-sign-in/tasks.env.example`](examples/google-sign-in/tasks.env.example)
(set your Google OAuth client, `SESSION_SECRET`, the public origin, and your first administrator),
then start the container:

```sh
docker run -d --name tasks -p 8080:8080 \
  --read-only --tmpfs /tmp -v tasks-data:/data \
  --env-file tasks.env tasks
```

Migrations are applied to an empty database automatically at startup. To run them explicitly (for
example before an upgrade) use the bundled command, with the same environment:

```sh
docker run --rm -v tasks-data:/data --env-file tasks.env tasks node dist/migrate.js
docker run --rm -v tasks-data:/data --env-file tasks.env tasks node dist/migrate.js --status
```

Open <http://localhost:8080>. `GET /readyz` reports `{"ok":true,...}` once the database is migrated and
sign-in is configured; `GET /healthz` reports the process. Docker Compose files for both sign-in modes
are in [`examples/`](examples/): `cd examples/google-sign-in && cp tasks.env.example tasks.env &&
docker compose up --build`.

To try the UI with no sign-in at all, set `ENVIRONMENT=local` and omit the Google settings: the UI is
served, `/readyz` stays 503, and nobody can sign in. With `ENVIRONMENT=production` the container
**refuses to start** (naming only the missing variables) unless sign-in is fully configured.

### Sign-in

Choose exactly one mode with `TASKS_AUTH_MODE`.

**Google (default, `TASKS_AUTH_MODE` unset or `session`).** Requires `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET` and `SESSION_SECRET` (32+ random characters). Register
`<TASKS_PUBLIC_ORIGIN>/auth/callback` as an authorized redirect URI. Sessions are signed cookies.

**Trusted upstream (`TASKS_AUTH_MODE=trusted-upstream`).** The application takes the user's email
from a header set by a reverse proxy that authenticates users (oauth2-proxy, Authentik forward auth,
...). It requires `TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER` (the header name) and
`TASKS_TRUSTED_UPSTREAM_TRUST=proxy-replaces-headers`, your acknowledgement that only the proxy can
reach the application and that it replaces that header on every request. `TASKS_TRUSTED_UPSTREAM_NAME_HEADER`
is optional. Google sign-in is disabled, and session cookies are never consulted. A missing or
invalid setting stops startup in production and answers 503 elsewhere; a request without the header
is simply unauthenticated. See [`examples/trusted-upstream`](examples/trusted-upstream/) for a
Compose file with oauth2-proxy (only the proxy publishes a port).

Both modes share:

| Variable | Meaning |
| --- | --- |
| `TASKS_PUBLIC_ORIGIN` | Browser-facing origin, for example `https://tasks.example.org`. Needed behind a TLS-terminating proxy so redirect URIs and the CSRF origin check match. Default: the request origin. |
| `TASKS_HOSTED_DOMAIN` | Only email addresses in this domain may sign in or be invited, and anyone in it is created automatically at first sign-in. **No default.** |
| `TASKS_INITIAL_ADMIN_EMAIL` | The first administrator: created at first sign-in and given every permission. **No default.** |

**Access fails closed.** With no `TASKS_HOSTED_DOMAIN`, only `TASKS_INITIAL_ADMIN_EMAIL` and users an
administrator has already created can sign in; any other address is denied, and no user row or
grant is created for it. Set `TASKS_HOSTED_DOMAIN` to let everyone in your domain sign in
(they receive a personal workspace and no administration). The same rule applies in both sign-in modes.

Beyond the first administrator, access is granted inside the application (Administration) and a
task manager can grant event and approval roles to themselves; that is intended behavior.

### Other settings

`ENVIRONMENT` (`local`, `dev` or `production`) and `RELEASE_SHA` are required. `TASKS_DATASTORE=sqlite`
with `TASKS_SQLITE_PATH`, and `TASKS_OBJECT_STORE=filesystem` with `TASKS_OBJECT_STORE_PATH`, select
the storage. `FEATURE_MODULES` (default all) can disable the events module. See
[`docs/HOSTING.md`](docs/HOSTING.md) for every variable, backups, the scheduler, and limits (one
replica per database file).

## Develop

Node 24 or newer.

```sh
npm ci
npm run check      # format, lint, typecheck
npm test           # unit, integration and conformance tests (includes real workerd D1/R2)
npm run build      # Worker bundle, self-hosted server, MCP runtime, web UI
npm run smoke:self-hosted   # boots the built server from empty and checks both sign-in modes
```

`src/` is the API and runtime, `web/` the React UI, `shared/` code shared by both (including the
tenant profile), and `migrations/` the D1/SQLite schema.

## Tenant profile

The build compiles one tenant profile, `shared/tenant-profile.ts`. The default is neutral: no hosted
domain, no administrator, no origins and no external integrations. A deployment can keep its own copy
of `shared/tenant-profile.ts`, `src/runtime/tenant-adapters.ts` and `wrangler.jsonc` and build this
source with them. Everything that differs per tenant is reachable through these fields (the optional
ones are typed in `shared/tenant-profile-support.ts`):

| Field | Purpose |
| --- | --- |
| `identity.hostedDomain`, `identity.initialAdminEmail` | Compile a sign-in domain and first administrator into the build. Empty means "use the runtime settings". A compiled domain cannot be loosened at runtime. |
| `origins`, `links.portal` | Browser origins (CSRF, links in email) and the portal link. Empty falls back to `TASKS_PUBLIC_ORIGIN` or the request origin. |
| `capabilities.*` | Optional modules (portal, mobile API, support intake, alerts, email, events, analytics). `FEATURE_MODULES` can only disable what is compiled in. |
| `integrations.emailGateway`, `.mobileGateway`, `.portalAlerts`, `.portalSupport`, `.eventAssist` | Endpoints, header prefixes, hosts and owners for each integration. Enabling a capability without its settings makes the readiness check fail with a configuration error. |
| `events` | Event vocabulary: presets, destinations, rooms, equipment, default time zone (UTC), labels for the coordinating group, destination, week and second language, and the names of the announcement screen and recurring program. |

## Project

This repository is published from a maintained source tree as an unrelated-history snapshot per
release (`PUBLIC-SOURCE.json` records the version; `PUBLIC-FILES.sha256` the file digests). Pull
requests are welcome and are reviewed and merged by the maintainers before the next release.
See [SECURITY.md](SECURITY.md) to report vulnerabilities and [LICENSE](LICENSE) for the MIT terms.
