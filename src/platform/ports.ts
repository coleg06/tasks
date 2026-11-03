/**
 * Narrow platform ports. They describe only the subset of Cloudflare D1 and R2 that the
 * application actually calls, so D1 and R2 satisfy them structurally (no adapter on
 * Cloudflare) and other backends can implement them without importing platform packages.
 *
 * This module is type-only and must stay free of runtime imports so it is safe in every bundle.
 */

/** Result metadata. Only `changes` and `last_row_id` are consumed by application code. */
export interface SqlMeta {
  changes: number;
  last_row_id: number;
  [key: string]: unknown;
}

export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: SqlMeta;
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
}

/**
 * SQLite-dialect database. `batch` MUST be atomic: either every statement applies or none do.
 */
export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
}

export interface ObjectStoreWriteOptions {
  httpMetadata?: { contentType?: string; contentDisposition?: string };
  customMetadata?: Record<string, string>;
}

export interface ObjectStoreBody {
  readonly body: ReadableStream;
  readonly httpEtag: string;
  readonly size: number;
}

export interface ObjectStore {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: ObjectStoreWriteOptions,
  ): Promise<unknown>;
  get(key: string): Promise<ObjectStoreBody | null>;
  delete(key: string): Promise<void>;
}

/** One entry of the shared scheduled-job table. Cron expressions are five-field UTC. */
export interface ScheduledJob<Environment> {
  readonly name: string;
  readonly cron: string;
  run(env: Environment): Promise<unknown>;
}

export interface ScheduledJobs<Environment> {
  readonly jobs: readonly ScheduledJob<Environment>[];
  forCron(cron: string): readonly ScheduledJob<Environment>[];
}
