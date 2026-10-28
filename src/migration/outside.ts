import type { Executable } from '../sql/executor'
import type { QueryFn } from './types'
import { MigrationError, sanitizePgErrorMessage } from '../errors/index'

// A statement a transaction refuses, on a line of its own as a migration writes it.
const OUTSIDE_TRANSACTION_RE = /^(?:CREATE (?:UNIQUE )?INDEX|DROP INDEX) CONCURRENTLY\b.*;$/gm

/** Splits migration SQL into what runs in its transaction and the statements a transaction refuses (`CREATE INDEX CONCURRENTLY`), run after it commits. */
export function splitOutsideTransaction(sql: string): { inside: string, outside: string[] } {
  const outside = sql.match(OUTSIDE_TRANSACTION_RE)?.map(stmt => stmt.slice(0, -1)) ?? []

  return { inside: outside.length > 0 ? sql.replace(OUTSIDE_TRANSACTION_RE, '') : sql, outside }
}

/** How `db` runs statements outside a transaction: its own runner, else its query as is. */
export function outsideRunner(db: Pick<Executable, 'query' | 'migrateOutside'>): <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T> {
  return fn => db.migrateOutside ? db.migrateOutside(fn) : fn((sql, params) => db.query(sql, params))
}

/** Runs each statement on its own, outside a transaction; one that fails is reported with what it leaves behind. */
export async function runOutsideTransaction(outside: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>, statements: string[]): Promise<void> {
  await outside(async (query) => {
    for (const sql of statements) {
      try {
        await query(`${sql};`, [])
      }
      catch (err) {
        throw new MigrationError(`"${sql}" failed after the rest of the migration committed: a concurrent index build that fails leaves an invalid index, which the next sync drops and builds again; a migration file is already recorded as applied, so \`apply\` will not retry it. ${sanitizePgErrorMessage(err instanceof Error ? err.message : String(err))}`, 'apply', undefined, err)
      }
    }
  })
}
