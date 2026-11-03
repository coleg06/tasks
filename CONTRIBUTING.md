# Contributing

Thanks for looking. Bug reports, fixes and small features are welcome as pull requests or issues.
Report security problems privately instead; see [SECURITY.md](SECURITY.md).

## How contributions are handled

This repository is a reviewed snapshot published per release from a maintained source tree. A pull
request is not merged here directly: the maintainers import it into the source tree, review and test
it there, and the change appears in the next published snapshot, at which point the pull request is
closed as accepted. Expect that to take a release cycle, and expect questions on the pull request.

A pull request can be imported automatically when it only touches files that exist in this
repository. One that changes `package.json` outside its dependency sections, edits an existing
migration, or adds files outside the published layout is reviewed by hand instead.

## Set up

Node 24 or newer.

```sh
npm ci
npm run check    # Biome format and lint, TypeScript
npm test         # unit, integration and contract tests, including real workerd D1/R2
npm run build
```

Run `npm run format` to apply Biome's formatting. `npm run dev` starts the Vite dev server for the UI;
for a working backend see the local trial in the [README](README.md#try-it-in-five-minutes).

## Ground rules

- **Keep it neutral.** Behavior that differs per deployment belongs in the tenant profile
  (`shared/tenant-profile.ts`) or an adapter, not in the shared code. Do not add names of
  organizations, hostnames, addresses or people, in code, tests or documentation.
- **Migrations are append-only.** Never edit or reorder a file in `migrations/`; add a new,
  numbered one. A deployed database checks each applied file's checksum.
- **Test what you change.** Add a test next to the behavior. Tests run twice, with the neutral
  profile and with every optional capability on (`vitest.config.ts`), and both must pass. SQL
  behavior must hold on both D1 and `node:sqlite`; the contract tests in `tests/platform/` check
  that.
- **Mind the runtimes.** `src/index.ts` is the Worker entry and its bundle must not reference `node:sqlite` (a test
  checks). Code that needs `node:sqlite` or the filesystem lives under `src/self-hosted/`,
  `src/platform/sqlite/` or `src/platform/fs-object-store/`.
- **Validate at the edge.** New request bodies get a Zod schema with explicit length limits; new SQL
  uses bound parameters only; anything stored and later shown as a link must be http(s).
- **Do not commit secrets,** `.env` files, databases or exports. A pull request containing them is
  rejected by the publishing checks.

## Pull request checklist

1. `npm run check`, `npm test` and `npm run build` pass.
2. The change is described in terms of behavior: what was wrong or missing, and what now happens.
3. New configuration is documented in [docs/HOSTING.md](docs/HOSTING.md); new endpoints in
   [docs/TASK_API.md](docs/TASK_API.md).
4. The pull request is small enough to review in one sitting. Split unrelated changes.

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
