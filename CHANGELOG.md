# Changelog

## 1.12.0

- Add an "All tasks" view below Completed that lists tasks of every status with the same
  access rules, ordering and 500-result cap as the other views.
- Replace the People filters' native dropdowns with the application's standard dropdown
  menus, matching every other filter and keeping the same status and role semantics. Each
  menu button's accessible name includes its current value.

## 1.11.0

- Bound preferences dialog height and scrolling in desktop and mobile browsers.
- Add per-category email frequencies, personal limits and an atomic deployment email cap.
  Expired immediate or scheduled attempts are terminal; no email backlog or retries.
- Persist browser sessions with seven-day idle and 30-day absolute expiry and revocation.
  Existing Google/session-cookie users must sign in again after upgrade.
- Update vulnerable JavaScript and Python dependencies and enforce shared session key validation.
- Provide a tested SQLite down-migration to the 1.10.0 schema; see docs/SQLITE_ROLLBACK.md.

## 1.10.0

- Add optional design-request ingestion and stable task links.
