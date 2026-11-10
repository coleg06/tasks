import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../../src/platform/ports';

export interface SqlBackendHandle {
  db: SqlDatabase;
  dispose(): Promise<void>;
}

let counter = 0;
const unique = (prefix: string) => `${prefix}-${process.pid}-${Date.now()}-${++counter}`;

/**
 * One contract, run identically against every SQL backend. `open` must return a database on which
 * every file in migrations/ has already been applied from an empty store.
 */
export function describeSqlContract(label: string, open: () => Promise<SqlBackendHandle>) {
  describe(`SQL contract: ${label}`, () => {
    let handle: SqlBackendHandle;
    let db: SqlDatabase;
    beforeAll(async () => {
      handle = await open();
      db = handle.db;
    }, 120_000);
    afterAll(async () => {
      await handle?.dispose();
    });

    async function insertUser(email = `${unique('u')}@example.test`) {
      const result = await db.prepare('INSERT INTO users (email) VALUES (?)').bind(email).run();
      return { email, id: Number(result.meta.last_row_id), result };
    }

    async function project() {
      const row = await db
        .prepare('SELECT id, workspace_id FROM projects ORDER BY id LIMIT 1')
        .first<{ id: number; workspace_id: number }>();
      if (!row) throw new Error('migrations must seed a project');
      return row;
    }

    async function insertTask(title: string, userId: number, suffix = unique('T')) {
      const target = await project();
      return db
        .prepare(
          `INSERT INTO tasks (task_key, seq, title, description, sort_key, created_by_user_id, workspace_id, project_id)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), ?, ?, ?, ?, ?, ?)`,
        )
        .bind(suffix, title, `${title} body`, suffix, userId, target.workspace_id, target.id)
        .run();
    }

    it('applies every migration from an empty store', async () => {
      const tables = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all<{ name: string }>();
      const names = tables.results.map((row) => row.name);
      for (const expected of [
        'users',
        'tasks',
        'tasks_fts',
        'tenant_configuration',
        'audit_events',
        'event_responsibilities',
      ]) {
        expect(names).toContain(expected);
      }
      const tenant = await db
        .prepare('SELECT COUNT(*) AS count FROM tenant_configuration')
        .first<{ count: number }>();
      expect(tenant?.count).toBe(1);
      const triggers = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all<{ name: string }>();
      expect(triggers.results.map((row) => row.name)).toEqual(
        expect.arrayContaining([
          'tenant_configuration_no_update',
          'tenant_configuration_no_delete',
          'tenant_configuration_no_replace',
          'event_work_responsibility_same_event_insert',
        ]),
      );
    });

    it('supports CRUD with D1 result shapes', async () => {
      const { email, id, result } = await insertUser();
      expect(result.success).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(typeof result.meta.changes).toBe('number');

      const found = await db
        .prepare('SELECT id, email, status FROM users WHERE email = ? COLLATE NOCASE')
        .bind(email.toUpperCase())
        .first<{ id: number; email: string; status: string }>();
      expect(found).toEqual({ id, email, status: 'active' });

      const updated = await db
        .prepare("UPDATE users SET first_name = ? WHERE id = ? AND status = 'active'")
        .bind('Ada', id)
        .run();
      expect(updated.meta.changes).toBe(1);

      const listed = await db
        .prepare('SELECT first_name FROM users WHERE id = ?')
        .bind(id)
        .all<{ first_name: string }>();
      expect(listed.success).toBe(true);
      expect(listed.results).toEqual([{ first_name: 'Ada' }]);

      expect(await db.prepare('SELECT id FROM users WHERE id = ?').bind(-1).first()).toBeNull();
      const none = await db.prepare('SELECT id FROM users WHERE id = ?').bind(-1).all();
      expect(none.results).toEqual([]);

      const removed = await db.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
      expect(removed.meta.changes).toBeGreaterThanOrEqual(1);
      expect(await db.prepare('SELECT id FROM users WHERE id = ?').bind(id).first()).toBeNull();
    });

    it('binds null, numbers, text and blobs', async () => {
      const row = await db
        .prepare('SELECT ? AS a, ? AS b, ? AS c, typeof(?) AS d')
        .bind(null, 7, 'text', new Uint8Array([1, 2, 3]).buffer)
        .first<{ a: null; b: number; c: string; d: string }>();
      expect(row).toEqual({ a: null, b: 7, c: 'text', d: 'blob' });
    });

    it('batch is atomic and returns one result per statement', async () => {
      const keep = unique('batch-ok');
      const results = await db.batch([
        db.prepare('INSERT INTO permissions (key, label) VALUES (?, ?)').bind(keep, 'Keep'),
        db.prepare('SELECT changes() AS changed'),
        db.prepare('SELECT label FROM permissions WHERE key = ?').bind(keep),
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]?.meta.changes).toBe(1);
      expect(results[1]?.results).toEqual([{ changed: 1 }]);
      expect(results[2]?.results).toEqual([{ label: 'Keep' }]);

      const doomed = unique('batch-rollback');
      await expect(
        db.batch([
          db.prepare('INSERT INTO permissions (key, label) VALUES (?, ?)').bind(doomed, 'Doomed'),
          db.prepare('INSERT INTO permissions (key, label) VALUES (?, ?)').bind(keep, 'Duplicate'),
        ]),
      ).rejects.toThrow();
      const leaked = await db
        .prepare('SELECT key FROM permissions WHERE key = ?')
        .bind(doomed)
        .first();
      expect(leaked).toBeNull();
    });

    it('INSERT OR IGNORE reports zero changes and the changes() idiom works', async () => {
      const key = unique('ignore');
      const first = await db
        .prepare('INSERT OR IGNORE INTO permissions (key, label) VALUES (?, ?)')
        .bind(key, 'One')
        .run();
      expect(first.meta.changes).toBe(1);
      const [second, probe] = await db.batch([
        db.prepare('INSERT OR IGNORE INTO permissions (key, label) VALUES (?, ?)').bind(key, 'Two'),
        db.prepare('SELECT changes() AS changed'),
      ]);
      expect(second?.meta.changes).toBe(0);
      expect(probe?.results).toEqual([{ changed: 0 }]);
    });

    it('meta.changes is exact for trigger-free tables (the callers that compare === 1)', async () => {
      // Tables behind the `meta.changes === 1` checks in email.ts, portal.ts, idempotency.ts,
      // assertion.ts: no trigger may fire on them, otherwise D1 and node:sqlite would disagree.
      const triggers = await db
        .prepare("SELECT tbl_name, name FROM sqlite_master WHERE type = 'trigger'")
        .all<{ tbl_name: string; name: string }>();
      const triggered = new Set(triggers.results.map((row) => row.tbl_name));
      for (const table of [
        'notification_outbox',
        'notification_deliveries',
        'mobile_idempotency_keys',
        'mobile_gateway_requests',
      ]) {
        expect(triggered.has(table), `${table} must not carry triggers`).toBe(false);
      }
      const key = unique('exact');
      const run = await db
        .prepare('INSERT INTO permissions (key, label) VALUES (?, ?)')
        .bind(key, 'Exact')
        .run();
      expect(run.meta.changes).toBe(1);
      expect(Number(run.meta.last_row_id)).toBeGreaterThan(0);
      const update = await db
        .prepare('UPDATE permissions SET label = ? WHERE key = ?')
        .bind('Exact2', key)
        .run();
      expect(update.meta.changes).toBe(1);
    });

    /**
     * Exact `meta.changes` per statement, as measured on workerd D1: the connection's
     * total_changes() delta, including trigger and FTS shadow-table writes. Both backends must
     * reproduce these numbers exactly, so any divergence in either direction fails here.
     */
    const EXPECTED_CHANGES = {
      insertUser: 5, // AFTER INSERT trigger creates a personal project + permissions
      insertTask: 3, // FTS insert trigger
      updateTask: 5, // FTS delete+insert trigger
      noMatchUpdate: 0,
      deleteTask: 3, // FTS delete trigger
      insertPermission: 1, // no triggers on a plain table
      updatePermission: 1,
      deletePermission: 1,
      ignoredInsert: 0,
      select: 0,
    };

    it('meta.changes equals the D1 total_changes() delta, trigger work included', async () => {
      const user = await insertUser();
      const taskKey = unique('CHG');
      const insertTaskResult = await insertTask('Changes probe', user.id, taskKey);
      const updated = await db
        .prepare('UPDATE tasks SET title = ? WHERE task_key = ? AND version = ?')
        .bind('Changes probe two', taskKey, 1)
        .run();
      const noMatch = await db
        .prepare('UPDATE tasks SET title = ? WHERE task_key = ? AND version = ?')
        .bind('never', taskKey, 99)
        .run();
      const deleted = await db.prepare('DELETE FROM tasks WHERE task_key = ?').bind(taskKey).run();
      const key = unique('plain');
      const insertPermission = await db
        .prepare('INSERT INTO permissions (key, label) VALUES (?, ?)')
        .bind(key, 'Plain')
        .run();
      const updatePermission = await db
        .prepare('UPDATE permissions SET label = ? WHERE key = ?')
        .bind('Plain 2', key)
        .run();
      const ignored = await db
        .prepare('INSERT OR IGNORE INTO permissions (key, label) VALUES (?, ?)')
        .bind(key, 'Dup')
        .run();
      const deletePermission = await db
        .prepare('DELETE FROM permissions WHERE key = ?')
        .bind(key)
        .run();
      const select = await db.prepare('SELECT 1 AS one').run();
      expect({
        insertUser: user.result.meta.changes,
        insertTask: insertTaskResult.meta.changes,
        updateTask: updated.meta.changes,
        noMatchUpdate: noMatch.meta.changes,
        deleteTask: deleted.meta.changes,
        insertPermission: insertPermission.meta.changes,
        updatePermission: updatePermission.meta.changes,
        deletePermission: deletePermission.meta.changes,
        ignoredInsert: ignored.meta.changes,
        select: select.meta.changes,
      }).toEqual(EXPECTED_CHANGES);
      expect(updated.meta.changed_db).toBe(true);
      expect(noMatch.meta.changed_db).toBe(false);
    });

    it('CTE-prefixed writes measure the same exact changes as plain writes; CTE reads work', async () => {
      const user = await insertUser();
      const taskKey = unique('CTE');
      const project = await db
        .prepare('SELECT id, workspace_id FROM projects ORDER BY id LIMIT 1')
        .first<{ id: number; workspace_id: number }>();
      const inserted = await db
        .prepare(
          `WITH src(k, u, w, p) AS (SELECT ?, ?, ?, ?)
           INSERT INTO tasks (task_key, seq, title, sort_key, created_by_user_id, workspace_id, project_id)
           SELECT k, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), 'CTE write', k, u, w, p FROM src`,
        )
        .bind(taskKey, user.id, project?.workspace_id, project?.id)
        .run();
      const updated = await db
        .prepare(
          `WITH target(k) AS (SELECT ?) UPDATE tasks SET title = 'CTE write 2'
           WHERE task_key IN (SELECT k FROM target) AND version = 1`,
        )
        .bind(taskKey)
        .run();
      const read = await db
        .prepare(
          'WITH t(k) AS (SELECT ?) SELECT title FROM tasks WHERE task_key IN (SELECT k FROM t)',
        )
        .bind(taskKey)
        .first<{ title: string }>();
      const deleted = await db
        .prepare(
          'WITH target(k) AS (SELECT ?) DELETE FROM tasks WHERE task_key IN (SELECT k FROM target)',
        )
        .bind(taskKey)
        .run();
      expect(inserted.meta.changes).toBe(EXPECTED_CHANGES.insertTask);
      expect(updated.meta.changes).toBe(EXPECTED_CHANGES.updateTask);
      expect(read).toEqual({ title: 'CTE write 2' });
      expect(deleted.meta.changes).toBe(EXPECTED_CHANGES.deleteTask);
    });

    it('meta.changes inside a batch is per statement, and changes() stays the direct count', async () => {
      const user = await insertUser();
      const taskKey = unique('IDI');
      const [insert, probe] = await db.batch([
        db
          .prepare(
            `INSERT OR IGNORE INTO tasks (task_key, seq, title, sort_key, created_by_user_id, workspace_id, project_id)
             SELECT ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM tasks), 'Idiom', 'k', ?, workspace_id, id
             FROM projects ORDER BY id LIMIT 1`,
          )
          .bind(taskKey, user.id),
        db.prepare('SELECT changes() AS task_inserted'),
      ]);
      expect(insert?.meta.changes).toBe(EXPECTED_CHANGES.insertTask);
      expect(probe?.results).toEqual([{ task_inserted: 1 }]);
      expect(probe?.meta.changes).toBe(0);
    });

    it('callers that compare meta.changes to 1 only do so on tables without triggers', async () => {
      // email.ts, portal.ts, idempotency.ts, assertion.ts and the comment batch compare
      // `meta.changes === 1`; that is exact only while no trigger fires for the operation.
      const triggers = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger'")
        .all<{ sql: string }>();
      const fires = (table: string, operation: string, column?: string) =>
        triggers.results.some((row) => {
          const match = new RegExp(
            `\\b(?:AFTER|BEFORE)\\s+${operation}(?:\\s+OF\\s+([\\w\\s,]+?))?\\s+ON\\s+${table}\\b`,
            'i',
          ).exec(row.sql);
          return (
            match !== null && (!column || !match[1] || match[1].split(/[,\s]+/).includes(column))
          );
        });
      for (const [table, operation, column] of [
        ['notification_outbox', 'INSERT'],
        ['notification_outbox', 'UPDATE'],
        ['notification_deliveries', 'INSERT'],
        ['mobile_idempotency_keys', 'INSERT'],
        ['mobile_gateway_requests', 'INSERT'],
        // Session revocation runs on status changes, not mobile identity linking.
        ['users', 'UPDATE', 'portal_db_id'],
        ['audit_events', 'INSERT'],
        ['task_comments', 'INSERT'],
        ['task_events', 'INSERT'],
      ] as const) {
        expect(
          fires(table, operation, column),
          `${operation} ${table} must not fire triggers`,
        ).toBe(false);
      }
      // ...and the tables the fixed callers write to do fire them (so they must use `> 0`).
      expect(fires('tasks', 'INSERT')).toBe(true);
      expect(fires('tasks', 'UPDATE')).toBe(true);
    });

    it('first(column) returns the column value, null for no row, and rejects unknown columns', async () => {
      expect(await db.prepare('SELECT 1 AS a, 2 AS b').first('b')).toBe(2);
      expect(await db.prepare('SELECT 1 AS a WHERE 0').first('a')).toBeNull();
      await expect(db.prepare('SELECT 1 AS a').first('missing')).rejects.toThrow(
        'D1_COLUMN_NOTFOUND',
      );
    });

    it('returns BLOBs as number arrays and accepts ArrayBuffer and typed-array binds', async () => {
      expect(await db.prepare("SELECT x'010203' AS b").first()).toEqual({ b: [1, 2, 3] });
      expect(
        await db
          .prepare('SELECT ? AS b')
          .bind(new Uint8Array([9, 8]).buffer)
          .first(),
      ).toEqual({
        b: [9, 8],
      });
      expect(
        await db
          .prepare('SELECT ? AS b')
          .bind(new Uint8Array([7, 6]))
          .first(),
      ).toEqual({
        b: [7, 6],
      });
    });

    it('rejects bigint and undefined binds like D1, and maps booleans and large integers', async () => {
      for (const value of [5n, 2n ** 53n + 1n, 2n ** 63n - 1n, 2n ** 63n, -(2n ** 63n) - 1n]) {
        await expect(
          (async () => db.prepare('SELECT ? AS v').bind(value).first())(),
          String(value),
        ).rejects.toThrow('D1_TYPE_ERROR');
      }
      await expect(
        (async () => db.prepare('SELECT ? AS v').bind(undefined).first())(),
      ).rejects.toThrow('D1_TYPE_ERROR');
      expect(await db.prepare('SELECT ? AS t, ? AS f').bind(true, false).first()).toEqual({
        t: 1,
        f: 0,
      });
      // Integers beyond 2^53 come back as (lossy) numbers rather than throwing.
      const big = await db.prepare('SELECT 9007199254740993 AS v').first<{ v: number }>();
      expect(typeof big?.v).toBe('number');
    });

    it('rejects transaction-control statements, in a batch before anything executes', async () => {
      const key = unique('txn');
      const count = async () =>
        (
          await db
            .prepare('SELECT COUNT(*) AS n FROM permissions WHERE key = ?')
            .bind(key)
            .first<{ n: number }>()
        )?.n;
      for (const control of [
        'COMMIT',
        'BEGIN',
        'END',
        'ROLLBACK',
        'SAVEPOINT a',
        'RELEASE a',
        '  /* c */ -- x\n commit',
      ]) {
        await expect(
          db.batch([
            db.prepare('INSERT INTO permissions (key, label) VALUES (?, ?)').bind(key, 'Txn'),
            db.prepare(control),
            db.prepare('SELECT * FROM table_that_does_not_exist'),
          ]),
          control,
        ).rejects.toThrow();
        expect(await count(), control).toBe(0);
      }
      await expect(db.prepare('COMMIT').run()).rejects.toThrow();
      // The connection is still usable and not stuck in a transaction.
      const results = await db.batch([
        db.prepare('INSERT INTO permissions (key, label) VALUES (?, ?)').bind(key, 'Txn'),
      ]);
      expect(results).toHaveLength(1);
      expect(await count()).toBe(1);
    });

    it('keeps the FTS index in step with tasks (insert, update, delete)', async () => {
      const user = await insertUser();
      const word = unique('zebraword').replaceAll('-', '');
      await insertTask(`Running ${word}`, user.id, unique('FTS'));
      const hits = (term: string) =>
        db
          .prepare(
            'SELECT t.title FROM tasks_fts JOIN tasks t ON t.id = tasks_fts.rowid WHERE tasks_fts MATCH ?',
          )
          .bind(term)
          .all<{ title: string }>();
      expect((await hits(word)).results).toHaveLength(1);
      // porter stemming: "run" matches "Running"
      expect((await hits(`run AND ${word}`)).results).toHaveLength(1);
      await db
        .prepare('UPDATE tasks SET title = ?, description = ? WHERE title = ?')
        .bind(`Walking ${word}`, `Walking ${word} body`, `Running ${word}`)
        .run();
      expect((await hits(`run AND ${word}`)).results).toHaveLength(0);
      expect((await hits(`walk AND ${word}`)).results).toHaveLength(1);
      await db.prepare('DELETE FROM tasks WHERE title = ?').bind(`Walking ${word}`).run();
      expect((await hits(word)).results).toHaveLength(0);
    });

    it('enforces foreign keys', async () => {
      await expect(insertTask('Orphan', 987_654_321)).rejects.toThrow();
      const user = await insertUser();
      const target = await project();
      // ON DELETE SET NULL / CASCADE paths stay available.
      await db
        .prepare('INSERT INTO user_permissions (user_id, permission_key) VALUES (?, ?)')
        .bind(user.id, 'tasks.view')
        .run();
      await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
      const orphan = await db
        .prepare('SELECT 1 AS present FROM user_permissions WHERE user_id = ?')
        .bind(user.id)
        .first();
      expect(orphan).toBeNull();
      expect(target.id).toBeGreaterThan(0);
    });

    it('supports strftime, json_extract, COLLATE NOCASE and AUTOINCREMENT', async () => {
      const row = await db
        .prepare(
          `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AS ts,
                  json_extract('{"a":{"b":5}}', '$.a.b') AS b,
                  ('ABC' = 'abc' COLLATE NOCASE) AS ci`,
        )
        .first<{ ts: string; b: number; ci: number }>();
      expect(row?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(row?.b).toBe(5);
      expect(row?.ci).toBe(1);

      const first = await insertUser();
      await db.prepare('DELETE FROM users WHERE id = ?').bind(first.id).run();
      const second = await insertUser();
      expect(second.id).toBeGreaterThan(first.id); // AUTOINCREMENT never reuses ids
    });
  });
}
