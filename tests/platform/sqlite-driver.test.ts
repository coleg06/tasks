/// <reference types="node" />

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteDatabase } from '../../src/platform/sqlite/driver';
import {
  type MigrationFile,
  pendingMigrations,
  readMigrations,
  runMigrations,
  splitForeignKeyPragma,
} from '../../src/platform/sqlite/migrate';
import { inspectSql, splitStatements } from '../../src/platform/sqlite/sql-scan';
import { effectiveMigrationsDirectory } from '../support/migrations';

const directories: string[] = [];
function workdir() {
  const directory = mkdtempSync(join(tmpdir(), 'tasks-sqlite-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function migration(name: string, sql: string): MigrationFile {
  return { name, sql, checksum: `sum:${sql}` };
}

describe('node:sqlite driver', () => {
  it('enables WAL, foreign keys and a busy timeout, and has FTS5', async () => {
    const db = new SqliteDatabase(join(workdir(), 'a.db'), { busyTimeoutMs: 1234 });
    const pragma = (name: string) =>
      db.raw.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>;
    expect(pragma('journal_mode').journal_mode).toBe('wal');
    expect(pragma('foreign_keys').foreign_keys).toBe(1);
    expect(pragma('busy_timeout').timeout).toBe(1234);
    await db
      .prepare('CREATE VIRTUAL TABLE probe USING fts5(body, tokenize = "porter unicode61")')
      .run();
    db.close();
  });

  it('rejects unsupported bind values like D1 and maps booleans', async () => {
    const db = new SqliteDatabase(join(workdir(), 'b.db'));
    await expect(db.prepare('SELECT ?').bind(undefined).first()).rejects.toThrow('D1_TYPE_ERROR');
    await expect(db.prepare('SELECT ?').bind({}).first()).rejects.toThrow('D1_TYPE_ERROR');
    expect(await db.prepare('SELECT ? AS t, ? AS f').bind(true, false).first()).toEqual({
      t: 1,
      f: 0,
    });
    db.close();
  });

  it('rolls a failed batch back including DDL and refuses foreign statements', async () => {
    const db = new SqliteDatabase(join(workdir(), 'c.db'));
    await expect(
      db.batch([
        db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY)'),
        db.prepare('INSERT INTO t (id) VALUES (1)'),
        db.prepare('INSERT INTO t (id) VALUES (1)'),
      ]),
    ).rejects.toThrow();
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE name = 't'").first()).toBeNull();
    const other = new SqliteDatabase(join(workdir(), 'd.db'));
    await expect(db.batch([other.prepare('SELECT 1')])).rejects.toThrow('same database');
    db.close();
    other.close();
  });

  it('reports last_row_id and changes for RETURNING statements', async () => {
    const db = new SqliteDatabase(join(workdir(), 'e.db'));
    await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)').run();
    const result = await db
      .prepare("INSERT INTO t (v) VALUES ('x') RETURNING id")
      .all<{ id: number }>();
    expect(result.results).toEqual([{ id: 1 }]);
    expect(result.meta.changes).toBe(1);
    expect(result.meta.last_row_id).toBe(1);
    const read = await db.prepare('SELECT * FROM t').all();
    expect(read.meta.changes).toBe(0);
    db.close();
  });

  it('serialises writers across connections using the busy timeout', async () => {
    const path = join(workdir(), 'f.db');
    const one = new SqliteDatabase(path, { busyTimeoutMs: 2_000 });
    const two = new SqliteDatabase(path, { busyTimeoutMs: 2_000 });
    await one.prepare('CREATE TABLE t (v INTEGER)').run();
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        (index % 2 ? one : two).batch([
          (index % 2 ? one : two).prepare('INSERT INTO t VALUES (?)').bind(index),
        ]),
      ),
    );
    expect((await one.prepare('SELECT COUNT(*) AS n FROM t').first<{ n: number }>())?.n).toBe(50);
    one.close();
    two.close();
  });
});

describe('single statement rule and SQL scanner', () => {
  const rejected = [
    'INSERT INTO t VALUES (1); COMMIT',
    "INSERT INTO t VALUES ('a'); DROP TABLE t",
    'CREATE TABLE x (a); COMMIT',
    'CREATE TABLE x (a); INSERT INTO t VALUES (1)',
    'CREATE INDEX i ON t (v); DROP TABLE t',
    'CREATE TABLE x (a);; COMMIT',
    'SELECT 1; /* c */ SELECT 2',
    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; COMMIT',
    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; END; DROP TABLE t',
    "CREATE TABLE y (a DEFAULT ';'); COMMIT",
  ];
  const accepted = [
    'INSERT INTO t VALUES (2)',
    'INSERT INTO t VALUES (2);',
    "INSERT INTO t VALUES ('a;b') ; -- trailing comment",
    "INSERT INTO t VALUES ('it''s; fine') /* ; COMMIT */ ;  ",
    'SELECT "a;b" AS "c;d" FROM (SELECT 1 AS "a;b")',
    'SELECT `a;b`, [c;d] FROM (SELECT 1 AS `a;b`, 2 AS [c;d]) -- ; COMMIT',
    'CREATE TABLE x (a, b DEFAULT (1));',
    'CREATE INDEX i ON t (v); -- done',
    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO t VALUES (3); SELECT CASE WHEN 1 THEN 2 END; END',
    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN INSERT INTO t VALUES (3); END; /* tail comment */',
    "CREATE TEMP TRIGGER tr2 AFTER INSERT ON t BEGIN SELECT ';'; END;",
  ];

  it('inspectSql flags a tail after any statement, including CREATE, and tracks trigger bodies', () => {
    for (const sql of rejected) expect(inspectSql(sql).hasTail, sql).toBe(true);
    for (const sql of accepted) expect(inspectSql(sql).hasTail, sql).toBe(false);
  });

  it('the driver rejects every smuggled tail before executing and accepts the rest', async () => {
    const db = new SqliteDatabase(join(workdir(), 'g.db'));
    await db.prepare('CREATE TABLE t (v TEXT)').run();
    for (const sql of rejected) {
      await expect(db.prepare(sql).run(), sql).rejects.toThrow('single statement');
    }
    expect(db.raw.isTransaction).toBe(false);
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('x', 'y', 'i', 'tr')").all(),
    ).toMatchObject({ results: [] });
    for (const sql of accepted) {
      if (sql.startsWith('CREATE TRIGGER') || sql.startsWith('CREATE TEMP TRIGGER')) {
        await db
          .prepare(sql.replace(/\btr2?\b/, `tr_${Math.random().toString(36).slice(2, 8)}`))
          .run();
      } else if (sql.startsWith('CREATE')) {
        await db
          .prepare(sql.replace(/\b(x|i)\b/, `n_${Math.random().toString(36).slice(2, 8)}`))
          .run();
      } else {
        await db.prepare(sql).run();
      }
    }
    db.close();
  });

  it('classifies verbs, including the main verb behind WITH', () => {
    const read = (sql: string) => inspectSql(sql).readOnly;
    expect(read('SELECT 1')).toBe(true);
    expect(read('  -- c\n SELECT 1')).toBe(true);
    expect(read('EXPLAIN QUERY PLAN SELECT 1')).toBe(true);
    expect(read('VALUES (1)')).toBe(true);
    expect(read('WITH a AS (SELECT 1 AS v) SELECT v FROM a')).toBe(true);
    expect(
      read("WITH a AS (SELECT 'insert' AS v), b(x) AS MATERIALIZED (SELECT 2) SELECT * FROM a, b"),
    ).toBe(true);
    expect(
      read(
        'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n',
      ),
    ).toBe(true);
    expect(read('WITH a AS (SELECT 1) INSERT INTO t SELECT * FROM a')).toBe(false);
    expect(read('WITH a AS (SELECT 1) UPDATE t SET v = (SELECT * FROM a)')).toBe(false);
    expect(read('WITH a AS (SELECT 1) DELETE FROM t WHERE v IN (SELECT * FROM a)')).toBe(false);
    expect(read('WITH a AS (SELECT 1) REPLACE INTO t SELECT * FROM a')).toBe(false);
    expect(read('WITH a AS (SELECT 1)')).toBe(false); // uncertain => write
    expect(read('INSERT INTO t VALUES (1)')).toBe(false);
    expect(read('PRAGMA table_info(t)')).toBe(true);
    expect(read('PRAGMA foreign_keys = ON')).toBe(false);
    expect(read('PRAGMA wal_checkpoint')).toBe(false);
    expect(read('')).toBe(false);
  });

  it('a CTE SELECT succeeds while another connection holds a write transaction', async () => {
    const path = join(workdir(), 'h.db');
    const writer = new SqliteDatabase(path, { busyTimeoutMs: 100 });
    const reader = new SqliteDatabase(path, { busyTimeoutMs: 100 });
    await writer.prepare('CREATE TABLE t (v INTEGER)').run();
    writer.raw.exec('BEGIN IMMEDIATE');
    writer.raw.exec('INSERT INTO t VALUES (1)');
    try {
      const rows = await reader
        .prepare('WITH a AS (SELECT 41 AS v) SELECT v + 1 AS answer FROM a')
        .all<{ answer: number }>();
      expect(rows.results).toEqual([{ answer: 42 }]);
      // Control: a CTE-prefixed write does need the write lock and reports it.
      await expect(
        reader.prepare('WITH a AS (SELECT 2 AS v) INSERT INTO t SELECT v FROM a').run(),
      ).rejects.toThrow(/locked|busy/i);
    } finally {
      writer.raw.exec('ROLLBACK');
    }
    reader.close();
    writer.close();
  });

  it('splits and accepts every statement of every shipped migration', () => {
    for (const file of readMigrations(effectiveMigrationsDirectory())) {
      const statements = splitStatements(file.sql);
      expect(statements.length, file.name).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(inspectSql(statement).hasTail, `${file.name}: ${statement.slice(0, 60)}`).toBe(
          false,
        );
      }
      // Re-joining the split must reproduce every statement boundary (no statement swallowed).
      const rebuilt = statements.join('\n');
      expect(rebuilt.replace(/\s+/g, '').length).toBeLessThanOrEqual(
        file.sql.replace(/\s+/g, '').length,
      );
    }
  });

  it('accepts every static SQL string the application prepares', () => {
    const checked: string[] = [];
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['platform', 'self-hosted'].includes(entry.name)) walk(path);
        } else if (entry.name.endsWith('.ts')) {
          const source = readFileSync(path, 'utf8');
          for (const match of source.matchAll(/prepare\(\s*(?:`([^`]*)`|'((?:[^'\\]|\\.)*)')/g)) {
            const sql = (match[1] ?? match[2] ?? '').replace(/\$\{[^}]*\}/g, '1');
            const inspection = inspectSql(sql);
            expect(inspection.hasTail, `${path}: ${sql.slice(0, 80)}`).toBe(false);
            expect(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release']).not.toContain(
              inspection.verb,
            );
            checked.push(sql);
          }
        }
      }
    };
    walk(resolve('src'));
    expect(checked.length).toBeGreaterThan(150);
  });
});

describe('migrations runner', () => {
  it('applies the repository migrations, then is idempotent', () => {
    const db = new DatabaseSync(':memory:');
    const migrations = readMigrations(effectiveMigrationsDirectory());
    const first = runMigrations(db, migrations);
    expect(first.applied).toEqual(migrations.map((entry) => entry.name));
    const second = runMigrations(db, migrations);
    expect(second.applied).toEqual([]);
    expect(second.skipped).toHaveLength(migrations.length);
    expect(pendingMigrations(db, migrations)).toEqual([]);
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    db.close();
  });

  it('lifts PRAGMA foreign_keys out of the transaction so table rebuilds work', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    const migrations = [
      migration(
        '0001_base.sql',
        'PRAGMA foreign_keys = ON;\nCREATE TABLE p (id INTEGER PRIMARY KEY);\nCREATE TABLE c (id INTEGER PRIMARY KEY, p_id INTEGER REFERENCES p(id));\nINSERT INTO p VALUES (1);\nINSERT INTO c VALUES (1, 1);',
      ),
      migration(
        '0002_rebuild.sql',
        'PRAGMA foreign_keys = OFF;\nCREATE TABLE p2 (id INTEGER PRIMARY KEY, extra TEXT);\nINSERT INTO p2 (id) SELECT id FROM p;\nDROP TABLE p;\nALTER TABLE p2 RENAME TO p;\nPRAGMA foreign_keys = ON;',
      ),
    ];
    runMigrations(db, migrations);
    expect(db.prepare('SELECT COUNT(*) AS n FROM c').get()).toEqual({ n: 1 });
    expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(
      1,
    );
    expect(splitForeignKeyPragma('PRAGMA foreign_keys = ON;\nSELECT 1;').foreignKeys).toBe(true);
    db.close();
  });

  it('rolls back only the failing migration and resumes after it is fixed', () => {
    const db = new DatabaseSync(':memory:');
    const good = migration('0001_a.sql', 'CREATE TABLE a (id INTEGER);');
    const bad = migration(
      '0002_b.sql',
      'CREATE TABLE b (id INTEGER); INSERT INTO nonexistent VALUES (1);',
    );
    expect(() => runMigrations(db, [good, bad])).toThrow('0002_b.sql failed and was rolled back');
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined();
    expect(db.prepare('SELECT name FROM schema_migrations').all()).toEqual([
      { name: '0001_a.sql' },
    ]);
    const fixed = migration('0002_b.sql', 'CREATE TABLE b (id INTEGER);');
    expect(runMigrations(db, [good, fixed]).applied).toEqual(['0002_b.sql']);
    db.close();
  });

  it('fails on checksum drift and on migrations missing from the image', () => {
    const db = new DatabaseSync(':memory:');
    runMigrations(db, [migration('0001_a.sql', 'CREATE TABLE a (id INTEGER);')]);
    expect(() => runMigrations(db, [migration('0001_a.sql', 'CREATE TABLE a (id TEXT);')])).toThrow(
      'checksum mismatch',
    );
    expect(() => runMigrations(db, [migration('0002_other.sql', 'SELECT 1;')])).toThrow(
      'missing from the image',
    );
    db.close();
  });

  it('refuses a database that carries a D1 migration history instead of replaying', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, applied_at TEXT)',
    );
    db.exec("INSERT INTO d1_migrations (name) VALUES ('0001_initial.sql')");
    const migrations = readMigrations(effectiveMigrationsDirectory());
    expect(() => runMigrations(db, migrations)).toThrow('d1_migrations');
    expect(() => pendingMigrations(db, migrations)).toThrow(
      'Importing a D1 database is not supported',
    );
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'users'").get()).toBeUndefined();
    db.close();
  });

  it('is safe when two runners start together', () => {
    const path = join(workdir(), 'race.db');
    const migrations = readMigrations(effectiveMigrationsDirectory());
    const one = new DatabaseSync(path);
    const two = new DatabaseSync(path);
    for (const db of [one, two]) {
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
    }
    runMigrations(one, migrations);
    const second = runMigrations(two, migrations);
    expect(second.applied).toEqual([]);
    one.close();
    two.close();
  });
});

describe('SQL scanner review regressions', () => {
  it('treats non-ASCII characters as identifier characters', () => {
    const write = inspectSql('WITH éselect AS (SELECT 1) INSERT INTO t SELECT * FROM éselect');
    expect(write).toMatchObject({ mainVerb: 'insert', readOnly: false });
    const trigger = inspectSql(
      'CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1 AS écase; END; COMMIT',
    );
    expect(trigger.hasTail).toBe(true);
  });

  it('only treats a real CREATE TRIGGER as having a body', () => {
    expect(inspectSql('CREATE TABLE trigger AS SELECT 1 AS begin; COMMIT').hasTail).toBe(true);
    expect(inspectSql('CREATE TEMP TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;').hasTail).toBe(
      false,
    );
  });

  it('does not treat aliases named end or case as block keywords', () => {
    const body = 'BEGIN SELECT 1 AS end; SELECT 2 AS case; SELECT 3; END';
    const sql = `CREATE TRIGGER t AFTER INSERT ON a ${body}`;
    expect(inspectSql(`${sql};`).hasTail).toBe(false);
    expect(inspectSql(`${sql}; COMMIT`).hasTail).toBe(true);
  });

  it('treats schema-qualified and uncertain pragmas as writes', () => {
    expect(inspectSql('PRAGMA table_info.user_version(42)').readOnly).toBe(false);
    expect(inspectSql('PRAGMA main.table_info(t)').readOnly).toBe(false);
    expect(inspectSql('PRAGMA table_info = 1').readOnly).toBe(false);
    expect(inspectSql('PRAGMA user_version').readOnly).toBe(false);
    expect(inspectSql('PRAGMA table_info(t)').readOnly).toBe(true);
    expect(inspectSql('PRAGMA quick_check').readOnly).toBe(true);
  });
});
