# Changelog

## 1.11.0 (unreleased)

- Bound preferences dialog height and scrolling in desktop and mobile browsers.
- Add per-category email frequencies, personal limits and an atomic deployment email cap.
  Expired immediate or scheduled attempts are terminal; no email backlog or retries.
- Persist browser sessions with seven-day idle and 30-day absolute expiry and revocation.
  Existing Google/session-cookie users must sign in again after upgrade.
- Update vulnerable JavaScript and Python dependencies and enforce shared session key validation.
- Provide a tested SQLite down-migration to the 1.10.0 schema; see docs/SQLITE_ROLLBACK.md.

## 1.10.0

- Add optional design-request ingestion and stable task links.
