# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately, through the repository's private vulnerability
reporting (GitHub Security Advisories), not through a public issue or pull request. Include:

- the version (`PUBLIC-SOURCE.json`) and the deployment shape (Cloudflare Workers or self-hosted),
- the sign-in mode in use (`session` or `trusted-upstream`), and
- the steps to reproduce, ideally a request or a failing test.

## Security model in brief

- **Identity.** Google OAuth (authorization code with PKCE; the email must be verified and, when
  configured, in `TASKS_HOSTED_DOMAIN`) issuing a signed 12-hour session cookie, or an email header
  from a reverse proxy you operate (`TASKS_AUTH_MODE=trusted-upstream`). The application stores no
  passwords.
- **Authorization.** Permissions and project membership are read from the database on every
  request. The session cookie carries only an identity; claims in it are never used to authorize.
  Disabling a user takes effect on their next request. Impersonation ("view as") is re-authorized on
  every request and can never grant more permission than the impersonator holds.
- **Admission fails closed.** An address unknown to the database is created at sign-in only when it
  is in `TASKS_HOSTED_DOMAIN` or is `TASKS_INITIAL_ADMIN_EMAIL`. The built-in `Agent` principal can
  never sign in as a person.
- **Browser requests.** A write that carries browser credentials needs a same-origin `Origin`
  header and a double-submit CSRF token. Cross-origin (CORS) access is not granted. The session
  cookie is `HttpOnly`, `Secure` and `SameSite=Lax`.
- **Agents.** `/mcp` and `/api/agent/v1` require a gateway secret and a per-client bearer token,
  compared in constant time. A credential is `read` or `read_write` and may expire; write requests
  carry idempotency keys and (for updates) an expected version.
- **Input handling.** SQL is parameterized, request bodies are size-limited before parsing, uploads
  are restricted to PNG, JPEG, WebP and PDF up to 50 MB and are always served as attachments,
  stored links must be http(s), and object-store keys are hashed so they cannot address paths.
- **Responses** carry `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `frame-ancestors 'none'` and a same-origin referrer policy.

## What it does not provide

- **No rate limiting** and no account lockout. Put limits on your reverse proxy.
- **No full Content-Security-Policy and no HSTS.** Set both at the proxy, which knows your origin.
- **No server-side session revocation.** Sign-out clears the cookie; a copied cookie remains valid
  until it expires (12 hours) unless the user is disabled.
- **No encryption at rest.** The database file and uploaded assets are plain files; protect them
  with disk encryption and permissions.
- **No multi-replica or high-availability mode.** SQLite is a single writer on one host.

## Operating notes

- **Trusted-upstream mode trusts the configured header completely.** The application must be
  reachable only through the proxy (publish no port for it, as in `examples/trusted-upstream`), and
  the proxy must overwrite that header on every request. Anything that can reach the application
  port directly can act as any user. `TASKS_TRUSTED_UPSTREAM_TRUST=proxy-replaces-headers` is your
  acknowledgement of this; the application listens on `0.0.0.0` by default, so set
  `TASKS_SITE_HOST` if you need a narrower binding.
- **Set the secrets yourself.** Generate `SESSION_SECRET` (32+ random characters, for example
  `openssl rand -hex 32`) and the MCP gateway secret and client tokens; anyone who knows
  `SESSION_SECRET` can sign in as any user. The example environment files ship these empty on
  purpose. Keep secrets out of version control and out of the image.
- **Set `TASKS_PUBLIC_ORIGIN`** behind a TLS-terminating proxy so the CSRF origin check and OAuth
  redirect URI use the public address.
- `TASKS_INITIAL_ADMIN_EMAIL` grants every permission to that address at its first sign-in. Remove
  it after the first administrator has granted roles to others if you do not want it to persist.
- A task manager can grant themselves event and approval roles; this is intended.
- Run the container as the non-root `node` user with a read-only root filesystem and a writable
  volume at `/data`, as in the README. Back up the database file and the object directory together
  (see `docs/HOSTING.md`).

## What belongs in this repository

Application source, migrations, tests and documentation only. Never commit credentials, session or
OAuth secrets, MCP tokens, `.env` files, database files or exports, object-store contents, or
production configuration. A disclosure scan runs on every published snapshot and on incoming pull
requests.
