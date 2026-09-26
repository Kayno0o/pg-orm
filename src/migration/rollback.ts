import type { QueryFn } from './types'
import { MigrationError, ValidationError } from '../errors/index'
import { djb2Hash, ensureMigrationTable, getMigrationHistory, recordMigration } from './history'

export interface RollbackContext {
  query: QueryFn
  transact: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>
}

/** Rollback the last N migrations by executing their down SQL. */
export async function rollbackMigrations(
  ctx: RollbackContext,
  count = 1,
): Promise<{ rolledBack: string[], sql: string }> {
  // `slice(-0)` and `slice(-NaN)` are the whole array, so a zero or a CLI typo would roll back every migration.
  if (!Number.isInteger(count) || count < 1)
    throw new ValidationError(`rollback count must be a positive integer, got ${count}`, 'rollback', { value: count })

  const history = await getMigrationHistory(ctx)

  const upMigrations = history.filter(m => m.direction === 'up')
  const downIds = new Set(
    history.filter(m => m.direction === 'down').map(m => m.name),
  )
  const pendingRollbacks = upMigrations
    .filter(m => !downIds.has(m.name))
    .slice(-count)
    .reverse()

  if (pendingRollbacks.length === 0) {
    return { rolledBack: [], sql: '' }
  }

  const rolledBack: string[] = []
  const sqlParts: string[] = []

  return ctx.transact(async (txQuery) => {
    const txExecutor = { query: txQuery }

    for (const migration of pendingRollbacks) {
      if (!migration.downSql || migration.downSql.trim() === '') {
        throw new MigrationError(
          `Cannot rollback migration "${migration.name}": no down SQL recorded`,
          'apply',
          migration.name,
        )
      }

      // Execute the entire down SQL as a single call (avoids naive `;` splitting
      // which breaks on semicolons inside string literals or dollar-quoted blocks)
      await txQuery(migration.downSql, [])

      await ensureMigrationTable(txExecutor)
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
