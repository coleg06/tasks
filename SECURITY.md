# Security

Please report suspected vulnerabilities privately, through the repository's private vulnerability
reporting (GitHub Security Advisories) rather than a public issue or pull request. Include the
version (`PUBLIC-SOURCE.json`), the deployment shape (Cloudflare Workers or self-hosted), and the
steps to reproduce.

## What belongs in this repository

- Application source, migrations, tests and documentation only.
- Never commit credentials, session or OAuth secrets, MCP tokens, `.env` files, database files or
  exports, object-store contents, or production configuration. Deployment-specific configuration
  lives in your own deployment repository or secret store.

## Operating notes

- Sign-in is Google OAuth with signed session cookies, or identity headers from a reverse proxy you
  control (`TASKS_AUTH_MODE=trusted-upstream`). In trusted-upstream mode the application trusts the
  configured header completely: it must be reachable only through the proxy, and the proxy must
  replace (never pass through) that header on every request. The application refuses to start in
  production, and answers 503, when the mode is selected but not fully configured.
- `TASKS_INITIAL_ADMIN_EMAIL` grants every permission to that address at its first sign-in. Remove
  it after the first administrator has granted roles to others if you do not want it to persist.
- The SQLite deployment is a single writer on one host; back up the database file and the object
  directory together (see `docs/HOSTING.md`).
- Run the container as the non-root `node` user with a read-only root filesystem and a writable
  volume at `/data`, as in `README.md`.
