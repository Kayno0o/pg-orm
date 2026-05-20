import type { SQL } from 'bun'
import { MigrationError } from '../errors/index'
import { asDriver } from '../sql/adapter'
import { ensureMigrationTable, getMigrationHistory, recordMigration } from './history'

export interface RollbackContext {
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>
  readonly sql: InstanceType<typeof SQL>
}

/** Rollback the last N migrations by executing their down SQL. */
export async function rollbackMigrations(
  ctx: RollbackContext,
  count = 1,
): Promise<{ rolledBack: string[], sql: string }> {
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

  return asDriver(ctx.sql).begin(async (sqlTx) => {
    const txDriver = asDriver(sqlTx)
    const txExecutor = {
      query: async (sqlStr: string, params: unknown[]) => {
        return await txDriver.unsafe(sqlStr, params) as Record<string, unknown>[]
      },
      sql: sqlTx,
    }

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
      await txDriver.unsafe(migration.downSql, [])

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

function djb2Hash(input: string): string {
  let hash = 5381

  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i) | 0
  }

  return (hash >>> 0).toString(36)
}
