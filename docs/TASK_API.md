# Task HTTP API

Tasks has three HTTP surfaces over the same data. This guide describes what each one accepts and
returns in this source tree; the code in `src/tasks/api.ts`, `src/shared/schemas.ts` and
`src/task-service/api.ts` is the reference. There is no OpenAPI document, and nothing here is a
promise of a stable contract beyond what is stated for the task-service API.

| Surface | Path | Who calls it | Authentication |
| --- | --- | --- | --- |
| Application API | `/api/tasks`, `/api/projects`, ... | The web UI | Session cookie (Google sign-in) or the proxy's identity header, plus CSRF proof for writes |
| Agent API | `/api/agent/v1/...` | Scripts and AI agents | Gateway secret header plus bearer token |
| Task-service API | `/api/task-service/v1/...` | Integrations | Same as the application API |

Bodies and responses are JSON. Errors are `{"error": "<code>"}` with an HTTP status, sometimes with
`issues` (validation details) or the current task (conflicts).

## Task fields

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | 1-240 characters, required |
| `description` | string | up to 10,000 characters, required (may be empty) |
| `status` | enum | `backlog`, `not_started`, `in_progress`, `blocked`, `done` |
| `priority` | enum or null | `high`, `medium`, `low` |
| `effort` | enum or null | `small`, `medium`, `large` |
| `assigneeEmail` | string or null | must be an active workspace member |
| `dueDate` | string or null | `YYYY-MM-DD` |
| `projectKey` | string | a project you can edit tasks in |
| `taskTypes` | string[] | up to 20 labels of up to 60 characters |

A task response (`{"task": {...}}`) adds `key` (opaque, for example `TASK-DA6B26E632EB`),
`reference` (`T-<n>`), `seq`, `creator`, `assignee`, `project`, `completedAt`, `createdAt`,
`updatedAt` and `version`. The application and agent APIs address a task by its `key`; the
task-service API also accepts the `T-<n>` reference.

## Application API

Used by the web UI. Safe methods need only the identity. A write also needs CSRF proof, because the
browser sends credentials automatically: an `Origin` header equal to the application's public origin
(`TASKS_PUBLIC_ORIGIN`), and an `X-CSRF-Token` header equal to the `tasks_csrf` cookie, which
`GET /api/bootstrap` sets. Without it the answer is 403 `csrf_rejected`. A script can do the same
with a cookie jar:

```sh
B=http://127.0.0.1:8080                      # your application origin
curl -s -c jar.txt $B/api/bootstrap >/dev/null   # identity + CSRF cookie
CSRF=$(awk '$6=="tasks_csrf"{print $7}' jar.txt)

curl -s -b jar.txt -H "X-CSRF-Token: $CSRF" -H "Origin: $B" -H 'Content-Type: application/json' \
  -X POST $B/api/tasks -d '{
    "title": "Write the docs", "projectKey": "TASKS", "description": "", "status": "not_started",
    "priority": "high", "effort": null, "assigneeEmail": null, "dueDate": "2027-01-15",
    "taskTypes": []
  }'
```

(With `TASKS_AUTH_MODE=trusted-upstream`, the cookie jar is replaced by whatever header your proxy
sets; the CSRF cookie and `Origin` rules are the same.)

| Method and path | Purpose |
| --- | --- |
| `GET /api/bootstrap` | Current user, permissions, enabled features |
| `GET /api/tasks?view=&q=&project=&sort=&hideAgent=1` | List tasks. `view` is `open` (default; in progress or blocked), `mine`, `backlog`, `completed` or `all` (every status). `q` is a case-insensitive substring match on title and description (at most 120 characters). Up to 500 results; a view that holds more returns the first 500 by the sort order, the same for every view. |
| `POST /api/tasks` | Create. An optional `mutationKey` (UUID) makes the create idempotent. Returns 201 with the task. |
| `GET /api/tasks/:taskKey` | The task plus `comments`, `activity` (its history), `canEdit` and `canComment` |
| `PATCH /api/tasks/:taskKey` | Update any subset of the fields above. Send `If-Match: "<version>"` to fail with 409 `version_conflict` (and the current task) when someone else changed it first. Without the header the update applies to the version just read and still cannot overwrite a concurrent write. |
| `POST /api/tasks/:taskKey/comments` | `{"body": "..."}`, up to 5,000 characters. `@mentions` of people with access notify them. |
| `DELETE /api/tasks/:taskKey/comments/:commentId` | Author, or a task manager. 204. |
| `GET /api/projects`, `POST /api/projects`, `PATCH /api/projects/:projectKey` | List, create and edit projects (`name`, `description`, `visibility` of `workspace` or `private`). Creating and editing need the task-manager role. |
| `GET\|PUT /api/projects/:projectKey/members` | Project membership (`viewer`, `editor`, `owner`) |
| `GET /api/projects/:projectKey/assignees` | Who a task in the project can be assigned to |
| `/api/admin/...` | User administration and "view as" (task managers) |
| `/api/events/...`, `/api/event-*` | The events module, when enabled |

A request body of more than 1 MiB (50 MiB plus form overhead for an asset upload) is refused with 413
before it is read, and a body that is not valid JSON answers 400 `invalid_json`.

## Agent API

For scripts and agents that should not use a browser session. It is the same family of handlers the
MCP tools call, exposed at `/api/agent/v1`:

| Method and path | Purpose |
| --- | --- |
| `GET /api/agent/v1/tasks` | List (same query parameters as above) |
| `POST /api/agent/v1/tasks` | Create; requires `Idempotency-Key` |
| `GET /api/agent/v1/tasks/:taskKey` | Read |
| `PATCH /api/agent/v1/tasks/:taskKey` | Update; requires `Idempotency-Key` and `If-Match: "<version>"` (428 if missing) |
| `POST /api/agent/v1/tasks/:taskKey/comments` | Comment; requires `Idempotency-Key` |

Every request carries the gateway secret in `X-Tasks-MCP-Gateway-Token` and a credential token as
`Authorization: Bearer <token>` (or in `X-Tasks-MCP-Token`). Both are configured with
`TASKS_MCP_GATEWAY_SECRET` and `TASKS_MCP_CREDENTIALS_JSON`; without them the routes answer 503
`not_configured`. A credential with `scope: "read"` may only use `GET`; other methods answer 403
`credential_read_only`. Requests act as the built-in `Agent` user, so task visibility is whatever that
user has been given.

`Idempotency-Key` is 8-128 characters of letters, digits, `.`, `_`, `:` and `-`. The key is bound to
the request (method, path, query, body and `If-Match`): repeating the identical request within seven
days returns the stored response with `X-Idempotent-Replay: true`; reusing the key for a different
request returns 409 `idempotency_key_reused`; repeating it while the first is still running returns
409 `request_in_progress`. A request that fails with a server error or an unexpected exception
releases its key so a retry runs again.

```sh
curl -s $B/api/agent/v1/tasks -H "X-Tasks-MCP-Gateway-Token: $GATEWAY" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: create-docs-task-1' -X POST -d '{"title": "Write the docs",
  "projectKey": "TASKS", "description": "", "status": "not_started", "priority": null,
  "effort": null, "assigneeEmail": null, "dueDate": null, "taskTypes": []}'
```

## Task-service API

`/api/task-service/v1` is a read-oriented, versioned boundary for integrations that should not depend
on the application's own shapes. In this source tree the default composition serves reads only:

- `GET /capabilities` describes the workflow states, priorities and optional features.
- `GET /tasks?search=&status=&priority=&assignee=&project=&cursor=&limit=` returns normalized tasks
  (`limit` 1-200, default 100) and an opaque `nextCursor`.
- `GET /tasks/:reference?comments=true&history=true` resolves a native key, a `T-<n>` reference or a
  number.

`GET /capabilities` reports `mutations: {create: false, update: false, comment: false}`, and the write
routes answer 405 `mutation_unsupported`, because the default composition provides no portable write
backend. `GET /principals` and `GET /projects` answer 405 `directory_unsupported`. A deployment that
replaces `src/runtime/tenant-adapters.ts` can supply those backends. Revisions, references and
cursors are opaque: return them unchanged. Additive response fields are allowed within `v1`.

## Errors worth handling

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_task`, `invalid_json`, `invalid_assignee` | Validation failed (see `issues`) |
| 401 | `unauthorized` | No identity |
| 403 | `forbidden`, `csrf_rejected`, `credential_read_only` | Not allowed |
| 404 | `not_found` | Missing, or not visible to you |
| 409 | `version_conflict`, `idempotency_key_reused`, `request_in_progress` | Retry with fresh state or a new key |
| 413 | `payload_too_large` | Body over the limit |
| 400 | `invalid_idempotency_key` | Agent API write without a valid `Idempotency-Key` |
| 428 | `if_match_required`, `idempotency_key_required` | Required header missing (`PATCH` without `If-Match` on the agent API; task-service writes without a key) |
