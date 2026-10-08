import type { Dialect } from '../dialect'
import type { MigrationHistoryEntry } from './history'
import type { QueryFn } from './types'
import { MigrationError, ValidationError } from '../errors/index'
import { djb2Hash, getMigrationHistory, recordMigration } from './history'
import { IRREVERSIBLE_MARKER } from './reverse'
import { MIGRATION_LOCK_KEY } from './types'

export interface RollbackContext {
  query: QueryFn
  transact: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>
  readonly dialect?: Dialect
}

/** Rollback the last N migrations by executing their down SQL. */
export async function rollbackMigrations(
  ctx: RollbackContext,
  count = 1,
): Promise<{ rolledBack: string[], sql: string }> {
  // `slice(-0)` and `slice(-NaN)` are the whole array, so a zero or a CLI typo would roll back every migration.
  if (!Number.isInteger(count) || count < 1)
    throw new ValidationError(`rollback count must be a positive integer, got ${count}`, 'rollback', { value: count })

  return ctx.transact(async (txQuery) => {
    const txExecutor = { query: txQuery }

    // Locked and read inside the transaction, which resolves the history table in the configured schema and keeps a concurrent sync or rollback out.
    if (ctx.dialect !== 'sqlite')
      await txQuery('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])

    const pendingRollbacks = liveMigrations(await getMigrationHistory(txExecutor, ctx.dialect)).slice(-count).reverse()

    // Checked for all of them before any runs, so a refusal leaves the schema and the history as they were.
    for (const migration of pendingRollbacks)
      assertReversible(migration)

    const rolledBack: string[] = []
    const sqlParts: string[] = []

    for (const migration of pendingRollbacks) {
      // Execute the entire down SQL as a single call (avoids naive `;` splitting
      // which breaks on semicolons inside string literals or dollar-quoted blocks)
      await txQuery(migration.downSql, [])

      await recordMigration(txExecutor, {
        name: migration.name,
        sqlHash: djb2Hash(migration.downSql),
        upSql: migration.upSql,
        downSql: migration.downSql,
        direction: 'down',
      })

      rolledBack.push(migration.name)
      sqlParts.push(migration.downSql)
    }

    return { rolledBack, sql: sqlParts.join('\n\n') }
  })
}

function assertReversible(migration: MigrationHistoryEntry): void {
  if (!migration.downSql || migration.downSql.trim() === '')
    throw new MigrationError(`Cannot rollback migration "${migration.name}": no down SQL recorded`, 'apply', migration.name)

  const irreversible = migration.downSql.split('\n').filter(line => line.startsWith(IRREVERSIBLE_MARKER))

  if (irreversible.length > 0)
    throw new MigrationError(`Cannot rollback migration "${migration.name}": ${irreversible.map(line => line.slice(IRREVERSIBLE_MARKER.length).trim()).join('; ')} has no reverse`, 'apply', migration.name)
}

// The applied migrations not rolled back since, oldest first: each rollback cancels the latest application of its name, which a name applied twice (re-applied, or two syncs sharing a name before names were unique) needs.
function liveMigrations(history: MigrationHistoryEntry[]): MigrationHistoryEntry[] {
  const live: MigrationHistoryEntry[] = []

  for (const entry of history) {
    if (entry.direction === 'up') {
      live.push(entry)

      continue
    }

    const applied = live.findLastIndex(m => m.name === entry.name)

    if (applied >= 0)
      live.splice(applied, 1)
  }

  return live
}
