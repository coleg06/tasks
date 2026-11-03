import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { SqlDatabase, SqlMeta, SqlResult, SqlStatement } from '../ports';
import { inspectSql } from './sql-scan';

/**
 * D1-compatible SQL port on the built-in `node:sqlite`.
 *
 * Semantics that matter to the application (verified by tests/platform/sql-conformance):
 * - `batch` runs inside one write transaction and rolls back entirely if any statement fails.
 * - `first/all/run` return D1-shaped `{ results, success, meta }` objects.
 * - `meta.changes` is the connection `total_changes()` delta for the statement, exactly as
 *   Cloudflare D1 reports it: it includes trigger and FTS shadow-table writes. Callers must not
 *   treat it as a row count on tables with triggers (use `changes > 0`, or `SELECT changes()`
 *   in the same batch for the direct count).
 * - Values follow D1: integers beyond 2^53 lose precision as numbers, BLOBs come back as number
 *   arrays, `bigint` and `undefined` binds are rejected with D1_TYPE_ERROR, and statements that
 *   control transactions (BEGIN, COMMIT, END, ROLLBACK, SAVEPOINT, RELEASE) are rejected.
 * - Foreign keys are enforced; the database runs in WAL with a busy timeout.
 *
 * node:sqlite is synchronous. Every statement here runs to completion without yielding, so a
 * batch cannot interleave with other callers on the single connection.
 */

export interface SqliteDatabaseOptions {
  /** Milliseconds SQLite waits on a locked database before failing. Default 5000. */
  busyTimeoutMs?: number;
  readOnly?: boolean;
}

type Bindable = null | number | string | Uint8Array;

const TRANSACTION_CONTROL = new Set(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release']);

function assertNotTransactionControl(sql: string) {
  const inspection = inspectSql(sql);
  if (inspection.hasTail) {
    throw new Error('D1_ERROR: only a single statement per query is supported');
  }
  if (TRANSACTION_CONTROL.has(inspection.verb)) {
    throw new Error(
      'D1_ERROR: transaction control statements are not allowed; use batch() for atomic writes',
    );
  }
}

function fromSqlite(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Uint8Array) return Array.from(value);
  return value;
}

function normalizeBinding(value: unknown, index: number): Bindable {
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    throw new TypeError(`D1_TYPE_ERROR: Type 'bigint' not supported for value '${value}'`);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // D1 rejects undefined and objects rather than coercing them; do the same.
  throw new TypeError(
    `D1_TYPE_ERROR: Type '${value === undefined ? 'undefined' : typeof value}' not supported for bind parameter ${index + 1}`,
  );
}

function plainRow<T>(row: unknown): T {
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as object)) converted[key] = fromSqlite(value);
  return converted as T;
}

export class SqliteStatement implements SqlStatement {
  constructor(
    readonly owner: SqliteDatabase,
    readonly sql: string,
    private readonly values: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new SqliteStatement(this.owner, this.sql, values);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.execute<Record<string, unknown>>('first').results[0];
    if (column === undefined) return (row ?? null) as T | null;
    if (!row) return null;
    if (!Object.hasOwn(row, column)) {
      throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    }
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.execute<T>('all');
  }

  async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.execute<T>('run');
  }

  /** Synchronous execution shared with `batch`. */
  execute<T>(mode: 'first' | 'all' | 'run'): SqlResult<T> {
    return this.owner.executeStatement<T>(this.sql, this.values, mode);
  }
}

export class SqliteDatabase implements SqlDatabase {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private readonly meter: StatementSync;
  private closed = false;

  constructor(path: string, options: SqliteDatabaseOptions = {}) {
    const busyTimeout = options.busyTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 0) {
      throw new Error('busyTimeoutMs must be a non-negative integer');
    }
    this.raw = new DatabaseSync(path, {
      readOnly: options.readOnly ?? false,
      enableForeignKeyConstraints: true,
    });
    this.raw.exec(`PRAGMA busy_timeout = ${busyTimeout}`);
    this.raw.exec('PRAGMA foreign_keys = ON');
    if (!options.readOnly && path !== ':memory:') {
      const mode = this.raw.prepare('PRAGMA journal_mode = WAL').get() as
        | { journal_mode?: string }
        | undefined;
      if (mode?.journal_mode?.toLowerCase() !== 'wal') {
        throw new Error('SQLite could not enable WAL journaling at this path');
      }
      this.raw.exec('PRAGMA synchronous = NORMAL');
    }
    this.meter = this.raw.prepare('SELECT total_changes() AS total, last_insert_rowid() AS id');
    this.meter.setReadBigInts(true);
  }

  prepare(query: string): SqlStatement {
    return new SqliteStatement(this, query);
  }

  async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    const prepared = statements.map((statement) => {
      if (!(statement instanceof SqliteStatement) || statement.owner !== this) {
        throw new TypeError('batch() requires statements prepared on the same database');
      }
      return statement;
    });
    // Reject before executing anything: a stray COMMIT would otherwise end the batch transaction
    // early and retain the statements before it.
    for (const statement of prepared) assertNotTransactionControl(statement.sql);
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const results = prepared.map((statement) => statement.execute<T>('all'));
      this.raw.exec('COMMIT');
      return results;
    } catch (error) {
      if (this.raw.isTransaction) this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  executeStatement<T>(
    sql: string,
    values: readonly unknown[],
    mode: 'first' | 'all' | 'run',
  ): SqlResult<T> {
    assertNotTransactionControl(sql);
    const statement = this.statement(sql);
    const bound = values.map(normalizeBinding);
    const started = performance.now();
    // D1 runs every statement inside a transaction that commits after the response metadata is
    // computed, so FTS5's pending-data flush (4 shadow-table writes per write on a FTS-indexed
    // table) is not part of `changes`. Reproduce that: measure inside an explicit transaction and
    // commit afterwards. A batch already holds the transaction.
    const ownsTransaction = !this.raw.isTransaction && !inspectSql(sql).readOnly;
    if (ownsTransaction) this.raw.exec('BEGIN IMMEDIATE');
    let results: T[] = [];
    let before: { total: number; lastRowId: number };
    let after: { total: number; lastRowId: number };
    try {
      before = this.counters();
      if (statement.columns().length === 0) {
        statement.run(...bound);
      } else {
        results = statement.all(...bound).map((row) => plainRow<T>(row));
        if (mode === 'first') results = results.slice(0, 1);
      }
      after = this.counters();
      if (ownsTransaction) this.raw.exec('COMMIT');
    } catch (error) {
      if (ownsTransaction && this.raw.isTransaction) this.raw.exec('ROLLBACK');
      throw error;
    }
    const changes = after.total - before.total;
    const meta: SqlMeta = {
      changes,
      last_row_id: after.lastRowId,
      changed_db: changes > 0,
      duration: performance.now() - started,
      rows_read: results.length,
      rows_written: changes,
      served_by: 'node:sqlite',
    };
    return { results, success: true, meta };
  }

  private counters() {
    const row = this.meter.get() as { total: bigint; id: bigint };
    return { total: Number(row.total), lastRowId: Number(row.id) };
  }

  private statement(sql: string) {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.raw.prepare(sql);
      statement.setReadBigInts(true);
      if (this.cache.size >= 256) this.cache.clear();
      this.cache.set(sql, statement);
    }
    return statement;
  }

  /** Cheap liveness probe used by /readyz. */
  async ping() {
    const row = this.raw.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    if (row?.ok !== 1) throw new Error('SQLite ping failed');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.raw.close();
  }
}
