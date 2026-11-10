# SQLite rollback from 1.11.0 to 1.10.0

A plain older image cannot start on the migrated SQLite database: its migration checker
rejects unknown applied names. Use the **1.11.0 migration bundle** for this offline down-migration.
It supports exactly migrations through 0022, validates their checksums, and requires a new backup
file. It refuses unknown later migrations, pending migrations and an existing backup path.

1. Stop all application replicas, schedulers and other writers using this SQLite file. Keep traffic
   stopped until rollback and the old release's schema check succeed. Preserve the exact prior
   image/source and current migrations; do not copy migrations between private and exported builds.
2. Using the 1.11.0 bundle, the existing deployment-owned datastore/path/migration environment
   and a new absolute backup path on a protected persistent volume, run:

   ```sh
   node dist/migrate.js --rollback-to=1.10.0 --backup=/data/tasks-before-rollback.db
   ```

   The command first creates a complete consistent SQLite backup (mode 0600), then transactionally
   removes only the 0021/0022 feature tables, session revocation trigger, added delivery index and
   their two migration-history entries. Original users, tasks, comments, delivery records, legacy
   category flags and all other pre-existing tables/history remain. All new session, email policy,
   quota and digest data survives **in the backup**, but is removed from the active database.
   Failure inside the down-migration rolls back its transaction. A backup failure changes no schema.
3. With the actual 1.10.0 bundle and its own migrations directory, run
   `node dist/migrate.js --status`; it must report `{"pending":[]}`. Start the prior image only
   after the authentication and email conditions below are met, then verify health/readiness and
   ordinary access through the deployment's normal process.

The automated regression imports the byte-for-byte SQLite migration checker from release
v1.10.0 (source commit 8c84b1d), proves it rejects the migrated database, then proves both its
startup checks (`pendingMigrations` and `runMigrations`) pass after the down-migration. It verifies
original user data/writes, retained feature data in the backup, and a subsequent forward upgrade.
This is a schema-check test, not a claim of a production rollback or live identity-provider test.

## Authentication and email conditions

Old code rejects new session cookies, so users must sign in again. Still-unexpired pre-upgrade
stateless cookies can become valid again if the unchanged signing secret is restored with old
code. Wait until all legacy cookies have expired (12 hours after the last old issuer stopped),
or obtain explicit approval for a coordinated invalidation plan covering every consumer before
earlier rollback. A backup restore can resurrect revoked sessions; do not restore it into a
serving deployment without separately resolving session invalidation.

Old code ignores new limits/frequencies and a zero personal cap. Before resuming traffic, either
explicitly accept that policy change or disable automatic email at the deployment's existing
gateway/configuration boundary and verify it is disabled. Do not infer that a personal cap or new
table constrains an older binary. No tenant configuration or credentials are changed by this tool.

Keep the backup offline for retention/recovery; do not replay notifications from it. A later normal
forward upgrade reapplies 0021/0022 with fresh defaults and empty sessions/quotas/digests, while
legacy category opt-outs remain. Do not replay historical events. This resets new email settings
and quota history; recovery of those settings requires a separately reviewed reconciliation.

This command is SQLite-only. It refuses D1-export databases through the normal migration guard.
It is not a D1 down-migration or proof of prior-Worker compatibility; D1 recovery must retain the
additive schema and use a separately verified Worker rollback or forward fix.
