# Hosting Tasks

For a tenant deployment that composes its own profile on top of this source, replace
`shared/tenant-profile.ts`, `src/runtime/tenant-adapters.ts` and `wrangler.jsonc` (see the tenant profile
section of the README).

Tasks runs in three supported shapes. They share one application; they differ in where state lives
and who owns identity.

| Shape | Datastore | Object store | Scheduler | Surface | Status |
| --- | --- | --- | --- | --- | --- |
| Cloudflare Worker | D1 | R2 | Cron Triggers | Full application | Supported (baseline) |
| Self-hosted container, SQLite | SQLite file (`node:sqlite`) | Local filesystem | In-process | Full application when the tenant profile is `legacy` | Supported, single replica |
| Self-hosted container, adapter-only | None; a tenant adapter calls a remote task service | None | None | Portable API only (`/api/bootstrap`, `/api/task-service/v1/*`) | Supported (default) |
| Self-hosted container, Postgres | - | - | - | - | **Not supported** (see below) |
| S3-compatible object store | - | - | - | - | **Not implemented** (the `ObjectStore` port exists) |

## Architecture seams

`src/platform/ports.ts` defines the narrow interfaces the application depends on:

- `SqlDatabase` / `SqlStatement`: `prepare`, `bind`, `first`, `all`, `run`, `batch`. Cloudflare D1
  satisfies it structurally, so the Worker has no adapter. `batch` must be atomic.
- `ObjectStore`: `put`, `get`, `delete`. R2 satisfies it structurally.
- `ScheduledJobs`: one shared job table (`src/platform/jobs.ts`) of name + cron expression + function.
  The Worker's `scheduled()` handler and the self-hosted scheduler both run exactly that table.

`Env.DB` and `Env.EVENT_ASSETS` are typed as these ports. A portable (adapter-only) deployment wires
neither (`PortableEnv`); the legacy routes then fail closed (503 from the tenant gate, 503
`object_store_unavailable` for assets).

Implementations for self-hosting live in `src/platform/sqlite/` (driver and migration runner) and
`src/platform/fs-object-store/`. `node:sqlite` is imported only from the self-hosted server bundle,
never from `src/index.ts`; a test bundles the Worker entry point and asserts it contains no
`node:sqlite` reference.

## Cloudflare Worker

`wrangler.jsonc` is a neutral template (`name: tasks-local`, a zeroed D1 `database_id`, an R2 bucket
`tasks-assets-local`). Copy it into your deployment, replace those names and IDs, and add what it
deliberately leaves out: routes or a custom domain, and cron triggers. The Worker's `scheduled()`
handler runs every job in `src/platform/jobs.ts` whose cron expression equals the trigger that fired,
so declare `triggers.crons` with the expressions in that table (`0 13 * * *` and `*/5 * * * *` at the
time of writing).

- `npm run build` produces the Worker bundle (`dist/index.js`) and the UI (`web/dist`, served by the
  `ASSETS` binding). The API paths run the Worker first; other paths are static assets.
- Bindings: `DB` (D1), `EVENT_ASSETS` (R2), `ASSETS`. Plain variables (`ENVIRONMENT`, `RELEASE_SHA`,
  `FEATURE_MODULES`) go in `vars`; secrets (`SESSION_SECRET`, `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, and the optional settings in the table below) with `wrangler secret put`.
- Migrations: `wrangler d1 migrations apply <database>` from the repository root, or
  `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/apply-d1-migrations.mjs <database>`.
  Apply them before or immediately after deploying a release that adds one.
- Static assets are served by Cloudflare without running the Worker, so the response headers the
  application adds to its own routes (`nosniff`, framing, referrer policy) do not cover them. Add a
  `_headers` file to the web build or set `run_worker_first` to `["/*"]` if you need them there.
- The Worker deployment is exercised by the contract tests under workerd; it is not covered by the
  self-hosted smoke test.

## Self-hosted SQLite mode

Requires Node 24 or newer (the image uses Node 24; `node:sqlite` is built in, no native dependency).

| Variable | Meaning |
| --- | --- |
| `ENVIRONMENT`, `RELEASE_SHA` | Required, as for every self-hosted run. |
| `TASKS_DATASTORE` | Unset: adapter-only mode, nothing below is read. `sqlite`: enable SQLite mode. Any other value fails startup. |
| `TASKS_SQLITE_PATH` | Required with `sqlite`. Database file path (the directory is created; WAL files appear beside it). |
| `TASKS_OBJECT_STORE` / `TASKS_OBJECT_STORE_PATH` | Optional pair. `filesystem` stores event assets under the path. The root is resolved once with `realpath` at startup (a symlinked volume mount is fine); any symlink in a component beneath it is rejected for reads, writes and deletes. Without it, asset routes return 503. |
| `TASKS_MIGRATE_ON_START` | `true` (default) applies pending migrations at startup. `false` makes startup fail while migrations are pending. |
| `TASKS_MIGRATIONS_DIR` | Migrations directory, default `./migrations` (bundled in the image). |
| `TASKS_SCHEDULER` | `enabled` (default) or `disabled`. |
| `TASKS_SITE_HOST`, `TASKS_SITE_PORT` | Listen address, default `0.0.0.0:8080`. |
| `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Required by the default Google session sign-in (see [Sign-in](#sign-in)). With `ENVIRONMENT=production` startup exits non-zero, before binding a port or opening any file, if any is missing or blank (the error names only the variables). In other environments the server starts but `/readyz` stays 503. Portable and adapter-only modes are unchanged. |
| `TASKS_AUTH_MODE`, `TASKS_TRUSTED_UPSTREAM_*` | Select and configure proxy-header sign-in instead of Google (see [Sign-in](#sign-in)). |
| `TASKS_PUBLIC_ORIGIN` | Browser-facing origin (`https://tasks.example.org`). Used for the OAuth redirect URI, the CSRF origin check and links in email. Default: the origin of each request, which is wrong behind a TLS-terminating proxy. |
| `TASKS_HOSTED_DOMAIN` | Restrict sign-in and invitations to one email domain. No default. |
| `TASKS_INITIAL_ADMIN_EMAIL` | The first administrator: granted every permission at first sign-in. No default. |
| `TASKS_MCP_ENABLED`, `TASKS_MCP_AUTH_MODE`, `TASKS_MCP_CREDENTIALS_JSON`, `TASKS_MCP_GATEWAY_SECRET` | The hosted MCP server (see [MCP server](#mcp-server)). Off unless enabled. Supply the credentials and gateway secret through your secret mechanism, never in the image. |

Invalid or partial configuration (for example `TASKS_SQLITE_PATH` without `TASKS_DATASTORE`, an object
store path without `TASKS_OBJECT_STORE`, or an unknown store) fails at startup before a port is bound.

### Migrations

`migrations/*.sql` are applied in name order. Each runs in its own transaction and is recorded in
`schema_migrations` with a SHA-256; re-running is a no-op, a changed already-applied file or a
database ahead of the image is an error, and a failing migration rolls back alone. A database that
contains a `d1_migrations` table (a Cloudflare D1 export) is refused rather than replayed: **importing a
D1 export is not supported in this version.** A migration's
`PRAGMA foreign_keys` line is applied outside the transaction (SQLite ignores it inside one), and
`PRAGMA foreign_key_check` must pass before commit. To run them without starting the server:

```sh
TASKS_DATASTORE=sqlite TASKS_SQLITE_PATH=/data/tasks.db node dist/migrate.js          # apply
TASKS_DATASTORE=sqlite TASKS_SQLITE_PATH=/data/tasks.db node dist/migrate.js --status # list pending
```

The shipped migrations seed the single tenant described by the build's tenant profile
(`migrations/0017_tenant_configuration.sql`; the default profile is neutral, with no administrator
and no domain). A deployment with a different profile edits that seed before its first migration, as
for D1. No administrator is seeded: name the first one with `TASKS_INITIAL_ADMIN_EMAIL`.

### Sign-in

Choose one mode with `TASKS_AUTH_MODE` (default `session`). The application never stores passwords.

| Mode | Settings | Behavior |
| --- | --- | --- |
| `session` (default) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` | Google OAuth with PKCE; signed session cookie. Register `<TASKS_PUBLIC_ORIGIN>/auth/callback` as the redirect URI. `TASKS_HOSTED_DOMAIN`, when set, is sent to Google as `hd` and enforced on the verified email. |
| `trusted-upstream` | `TASKS_TRUSTED_UPSTREAM_EMAIL_HEADER` (required), `TASKS_TRUSTED_UPSTREAM_TRUST=proxy-replaces-headers` (required acknowledgement), `TASKS_TRUSTED_UPSTREAM_NAME_HEADER` (optional) | Identity is the email in that request header, set by a reverse proxy that authenticates users (oauth2-proxy, Authentik forward auth). The user is created on first sight, joins the workspace, and receives the same grants as a Google sign-in. Session cookies and `/auth/login` are disabled. Browser writes still need the CSRF cookie and header. |

Admission: a person unknown to the database is created at sign-in only when `TASKS_HOSTED_DOMAIN` is set and the address is in it, or the address is `TASKS_INITIAL_ADMIN_EMAIL`; otherwise they are denied (Google: redirected with `auth=failed`; trusted-upstream: 403 `access_denied`) and nothing is written. Users an administrator created in advance can always sign in. This holds in both modes.

Fail-closed rules: an unknown `TASKS_AUTH_MODE`, or a trusted-upstream mode missing its header name or
acknowledgement, stops startup under `ENVIRONMENT=production` (naming only the variables) and makes every
`/api` and `/auth` request answer 503 `trusted_upstream_not_configured` elsewhere. A request without the
header, with an address outside `TASKS_HOSTED_DOMAIN`, or for a disabled user has no identity (401).
**The application must be reachable only through the proxy, and the proxy must overwrite the header on every
request**; anything that can reach the port directly can impersonate any user. The server listens on
`0.0.0.0` by default: publish no port for it (as `examples/trusted-upstream` does) or bind it with
`TASKS_SITE_HOST`. Impersonation (administrator
"view as") is a session-cookie feature and is unavailable in this mode. Sign-out belongs to the proxy.

Working configurations: `examples/google-sign-in` and `examples/trusted-upstream` (Compose files and
environment templates). For a throwaway local trial with no identity provider, `examples/local/try-it.mjs`
starts the built server in trusted-upstream mode behind a loopback-only proxy that signs you in as an
administrator; it is not for any shared or networked machine.

Generate `SESSION_SECRET` yourself (`openssl rand -hex 32`; production startup requires at least 32 characters); the example files ship it empty so that a
production start fails until you do. Any non-empty value is accepted, so a short or published secret
lets anyone sign in as any user.

### MCP server

Every Tasks server can host a Model Context Protocol endpoint at `/mcp` (stateless Streamable HTTP) so
agents can list, search, read, create, update and comment on tasks. It is **off on a fresh install**.

| Setting | Meaning |
| --- | --- |
| `TASKS_MCP_ENABLED` | `true`: on. `false`: off, and `/mcp` answers 404 exactly like a route that does not exist, even if credentials are present. Unset or blank: on only when `TASKS_MCP_CREDENTIALS_JSON` is set (existing deployments that already have credentials keep working; a new install stays off). Any other value is a configuration error and fails closed; it is never read as on. |
| `TASKS_MCP_CREDENTIALS_JSON` | The credential registry (below). A secret. |
| `TASKS_MCP_AUTH_MODE` | `gateway-and-token` (default) or `token`. |
| `TASKS_MCP_GATEWAY_SECRET` | At least 32 characters. Required by `gateway-and-token` only. |

With `TASKS_MCP_ENABLED=true`, a missing or invalid setting keeps `/mcp` answering 503
`{"error":"not_configured"}`. Under `ENVIRONMENT=production` startup exits non-zero and names the
variables (never their values); elsewhere the server starts and `/readyz` answers 503 naming them. The
agent API that the MCP tools call (`/api/agent/v1/*`) follows the same switch.

**Authentication modes.** `token` is the simplest and is meant for a server you reach directly or
through an ordinary TLS reverse proxy: the client sends its credential as
`Authorization: Bearer <token>` (or in the `X-Tasks-MCP-Token` header) and nothing else is needed. You must
choose it explicitly; nothing falls back to it. `gateway-and-token` is for a deployment whose `/mcp`
sits behind a private gateway: the gateway injects a second secret in a header and the application
requires both it and the client token, so a leaked client token is useless from the public hostname.
Removing the gateway secret never relaxes `gateway-and-token`; it stops answering until the secret is
restored. In both modes tokens are compared in constant time, a credential may be `read` (list, search,
get) or `read_write`, and an optional `expiresAt` ends it.

**Create a credential.** The command below generates a 256-bit token, prints it once, and prints the
registry entry. It reads no secrets and writes nothing unless you give `--output`
(a one-entry registry file, mode 0600, never overwritten). In the container image, run
`node dist/mcp-create-credential.js` with the same options.

```sh
npm run mcp:create-credential -- --name "My laptop" --scope read_write
# optional: --runtime <label> --client-id <id> --expires-in-days <n> --output <path>
```

The registry is `{"version":1,"credentials":[ <entry>, ... ]}` with up to 32 entries; each entry has
`clientId`, `name`, `role` (`Agent`), `runtime`, `scope`, `token` (32 characters or more) and an optional
`expiresAt` (epoch seconds). The token is stored as written, so the registry is a secret: supply it
as the value of `TASKS_MCP_CREDENTIALS_JSON`, never commit it, and rotate by adding a new entry,
moving clients, and removing the old one.

**Turn it on (token mode).**

```sh
TASKS_MCP_ENABLED=true
TASKS_MCP_AUTH_MODE=token
TASKS_MCP_CREDENTIALS_JSON='{"version":1,"credentials":[ ...entry from the command... ]}'
```

The endpoint is `<TASKS_PUBLIC_ORIGIN>/mcp`. It accepts only the host of `TASKS_PUBLIC_ORIGIN`
(DNS-rebinding protection), so a reverse proxy must forward the original `Host` header. Serve it over
HTTPS: in token mode the bearer token is the only credential. Check it:

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://tasks.example.org/mcp   # 401 without a token
```

**Client configuration.** Claude Code (`.mcp.json`, with the token in the environment):

```json
{
  "mcpServers": {
    "tasks": {
      "type": "http",
      "url": "https://tasks.example.org/mcp",
      "headers": { "Authorization": "Bearer ${TASKS_MCP_TOKEN}" }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.tasks]
url = "https://tasks.example.org/mcp"
bearer_token_env_var = "TASKS_MCP_TOKEN"
```

Every mutation takes an `idempotencyKey` so a retry cannot repeat it. Actions are attributed to a
non-login `Agent` principal and recorded in the audit log.

### Scheduler

The in-process scheduler evaluates the job table once per UTC minute. A job still running when its
next tick arrives is skipped, never run concurrently with itself. Failures are recorded through
`logApplicationError` like Worker cron failures. Ticks missed while the process is down are not
replayed (Cloudflare cron behaves the same). Run exactly one process per database.

### Container

```sh
docker run --read-only --tmpfs /tmp -p 8080:8080 -v tasks-data:/data \
  -e ENVIRONMENT=production -e RELEASE_SHA=... \
  -e TASKS_DATASTORE=sqlite -e TASKS_SQLITE_PATH=/data/tasks.db \
  -e TASKS_OBJECT_STORE=filesystem -e TASKS_OBJECT_STORE_PATH=/data/objects \
  <image>
```

The image runs as the non-root `node` user, bundles `migrations/` and `dist/migrate.js`, and needs
write access only to `/data` (declared as a volume). The root filesystem can be read-only.

### Backup and restore

State is the SQLite file plus the object directory. For a consistent online backup of the database use
SQLite's backup API (for example `sqlite3 /data/tasks.db ".backup '/backup/tasks.db'"`) or
`VACUUM INTO`, not a plain copy of the `-wal` file set; the object directory can be copied with
`rsync`/snapshots (objects are written atomically and never modified in place). Restore by stopping
the container, replacing both, and starting it (pending migrations then apply). Test a restore
before relying on it.

## Roles and user administration

Migration `0020_roles.sql` adds roles: named sets of the existing permission keys. A person's effective
permissions are the union of their direct grants (`user_permissions`) and the permissions of every role
they hold; a role containing `platform.admin` confers every permission, like the direct grant (a direct
`platform.admin` grant also expands to every permission on read, whatever copy rows exist). Four built-in
roles are seeded and assigned to nobody: `admin` (every permission), `manager` (`tasks.view`,
`tasks.comment`, `tasks.personal`, `tasks.manage`), `member` (`tasks.view`, `tasks.comment`,
`tasks.personal`) and `viewer` (`tasks.view`, read-only). Custom roles are created, edited and deleted by
platform administrators; nobody can hand out access they do not hold, whether through a role or through
the access switches when editing or inviting a person (task managers may additionally grant event
permissions), task managers cannot modify platform administrators, and the last active platform
administrator cannot be disabled, demoted or removed. Every change is written to the audit log; task
managers do not see audit events about personal-project tasks and comments.

Roles are real, not decorative. Every ordinary person holds the baseline permissions `tasks.view`,
`tasks.comment`, `tasks.personal`, `events.view` and `events.create` as direct grants (the creation
trigger and first sign-in add them). **Assigning a role to a person (one at a time, in bulk, or when
inviting) removes their direct grants of exactly those five permissions in the same atomic batch, and the
audit entry lists what was removed.** From then on their roles alone decide the baseline: a Viewer can
read but not comment, and removing Member takes access away on the person's next request. Sign-in
provisioning and administrator edits never add the baseline to a person who holds any role. Management
permissions (`tasks.manage`, `events.manage`, `events.approve`, `platform.admin`) are never touched by
role assignment. People with no role behave exactly as before: the migration does not rewrite any
existing row, and assignment is the only way a person moves to role-based access. An administrator may
remove a person's last role (the console says so first); they keep only the direct grants they still have,
and because they then hold no role, a later sign-in may add the baseline back for them like for any
other person without a role.

Administration (people directory with search, filters and paging, bulk invite and bulk actions, roles,
audit log) is served under `/api/admin/*` and the `/admin` page of the legacy API; it does not exist in
portable mode and answers 404 when the profile disables user administration. Code that checks
permissions in SQL must read `effective_user_permissions`, not `user_permissions`.

## D1 compatibility of the SQLite driver

The driver is held to D1's observable behaviour by the shared contract in `tests/platform/`, which runs
the same assertions on workerd D1 and on `node:sqlite`:

- `meta.changes` is the connection `total_changes()` delta for the statement, exactly as D1 reports
  it, so writes to tables with triggers or FTS indexes include trigger and shadow-table writes (the
  contract pins the exact numbers on both backends). To match D1 the driver measures inside a
  transaction that commits after the metadata is read, so FTS5's commit-time flush is not counted.
  **Do not compare `meta.changes` to 1 on a table with triggers**: use `changes > 0` (or `=== 0` for
  "nothing matched"), or `SELECT changes()` in the same batch for the direct row count. A test lists
  the tables behind the remaining `=== 1` checks and fails if a trigger ever fires on them.
- `batch` is one atomic transaction; statements that control transactions (BEGIN, COMMIT, END,
  ROLLBACK, SAVEPOINT, RELEASE, found after stripping comments) are rejected before anything runs, as is
  more than one statement per query (a small scanner that skips strings, quoted identifiers and comments finds statement ends, the main verb behind `WITH`, and the `BEGIN ... END` body of `CREATE TRIGGER`; only trailing whitespace and comments may follow a statement). Read-only statements (`SELECT`, `WITH ... SELECT`, `EXPLAIN`, informational `PRAGMA`s) never take the write lock; anything the scanner is unsure about is treated as a write.
- Values: BLOBs return as number arrays, `bigint` and `undefined` binds are rejected with
  `D1_TYPE_ERROR` (workerd D1 rejects every bigint, in range or not), integers beyond 2^53 return as
  lossy numbers, `first(column)` returns the column or `D1_COLUMN_NOTFOUND`.
- `exec()` is not part of the port; reads and writes share one connection serialized by the event
  loop; there is no read replica or session API.

## Limits

- **One writer, one replica.** SQLite in WAL mode allows many readers but a single writer, on one
  host and one filesystem. Do not run two containers against the same file, and do not put the file on
  a network filesystem. There is no high-availability story; restore from backup.
- Event assets are read into memory on download; the filesystem store is meant for small files.
  Uploads are limited to PNG, JPEG, WebP and PDF up to 50 MB, and every `/api` request body to 1 MiB
  (50 MiB plus form overhead for an upload), checked before the body is parsed.
- **No rate limiting.** Apply request limits at your reverse proxy or in front of the Worker.
- Sessions are stateless signed cookies (12 hours); disabling a user ends their access at once, but
  signing out only clears the cookie.
- **Sign-in is Google or a trusted proxy.** See [Sign-in](#sign-in). This mode adds no passwords and
  no other identity provider; a different provider means supplying a tenant adapter
  (`src/runtime/tenant-adapters.ts`).
- Postgres: not supported.

### What Postgres would take

The 23 source files that use `env.DB` issue about 250 SQLite-dialect statements. A Postgres port needs
a `SqlDatabase` implementation plus dialect work that a driver cannot hide: `strftime(...)` defaults
and comparisons, `INSERT OR IGNORE` / `INSERT OR REPLACE` (to `ON CONFLICT`), `AUTOINCREMENT` and
`last_row_id` (to identity columns and `RETURNING`), `?` placeholders (to `$n`), `COLLATE NOCASE`
(`citext` or `lower()` indexes), `json_extract`/`json_valid`, `changes()` in-batch idioms, and the
FTS5 virtual table with its triggers (to `tsvector` + GIN). It also needs a second, separately
maintained migration history and the same conformance suite run against it. That is a project of its
own, not a switch.

## Verification

`tests/platform/` holds one SQL contract and one object-store contract, each run against the real
Cloudflare bindings (workerd via wrangler's platform proxy; migrations applied with
`wrangler d1 migrations apply --local`) and against the self-hosted implementations. They cover
migrations from empty, CRUD, atomic batch rollback, `meta.changes`/`last_row_id`, FTS search,
`INSERT OR IGNORE`, foreign keys and `strftime`. `tests/self-hosted/sqlite-server.test.ts` boots the real
server with a temporary SQLite file and filesystem directory, checks `/readyz` and does an
authenticated API round trip and an MCP call. There is no skip path for workerd: if it cannot run,
the suite fails.
