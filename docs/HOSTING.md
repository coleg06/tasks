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
| `TASKS_MCP_*`, ... | Same application secrets as on Cloudflare; supply them through your secret mechanism, never in the image. |

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
request**; anything that can reach the port directly can impersonate any user. Impersonation (administrator
"view as") is a session-cookie feature and is unavailable in this mode. Sign-out belongs to the proxy.

Working configurations: `examples/google-sign-in` and `examples/trusted-upstream` (Compose files and
environment templates).

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
- **Sign-in is Google or a trusted proxy.** See [Sign-in](#sign-in). This mode adds no passwords and
  no other identity provider; a different provider means supplying a tenant adapter
  (`src/runtime/tenant-adapters.ts`).
- Postgres: not supported.

### What Postgres would take

The 21 source files that use `env.DB` issue about 260 SQLite-dialect statements. A Postgres port needs
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
