/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach } from 'vitest';
import type { Env } from '../../src/env';
import type { SqlStatement } from '../../src/platform/ports';

const stores: DatabaseSync[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

/** Give existing authorization stubs real durable session SQL without mocking JWT/revocation. */
export function withBrowserSessionStore(env: Env) {
  const original = env.DB;
  const sessions = new DatabaseSync(':memory:');
  stores.push(sessions);
  sessions.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, status TEXT)');
  sessions.exec(readFileSync('migrations/0022_browser_sessions.sql', 'utf8'));
  // Authorization still uses the fixture's users; these are synthetic foreign-key parents only.
  const insert = sessions.prepare("INSERT INTO users (id, status) VALUES (?, 'active')");
  for (let id = 1; id <= 100; id++) insert.run(id);
  env.DB = {
    prepare(sql) {
      if (!sql.includes('browser_sessions')) return original.prepare(sql);
      const prepared = sessions.prepare(sql);
      const statement = (values: SQLInputValue[]): SqlStatement => ({
        bind: (...next) => statement(next as SQLInputValue[]),
        async first<T>(column?: string) {
          const row = prepared.get(...values);
          return (column === undefined ? (row ?? null) : (row?.[column] ?? null)) as T | null;
        },
        async all<T>() {
          return {
            results: prepared.all(...values) as T[],
            success: true,
            meta: { changes: 0, last_row_id: 0 },
          };
        },
        async run<T>() {
          const result = prepared.run(...values);
          return {
            results: [] as T[],
            success: true,
            meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
          };
        },
      });
      return statement([]);
    },
    batch: (statements) => original.batch(statements),
  };
  return env;
}
