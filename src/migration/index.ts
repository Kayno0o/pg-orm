import type { Executable } from '../sql/executor'
import type { AnyTableDef } from '../types/index'
import type { MigrationFile, MigrationOp } from './types'
import { dialectOf } from '../dialect'
import { DestructiveOpError, MigrationError } from '../errors/index'
import { TIMESTAMP_DELIM_RE } from '../utils/regex'
import { planMigration } from './plan'
import { generateDownSql } from './reverse'

export { diffSchema } from './diff'
export { djb2Hash, ensureMigrationTable, getMigrationHistory, type MigrationHistoryEntry, recordMigration } from './history'
export { introspectLiveSchema } from './introspect'
export { planMigration } from './plan'
export { type RollbackContext, rollbackMigrations } from './rollback'
export { type SyncContext, type SyncOptions, syncSchema } from './sync'
export type { MigrationFile, MigrationOp } from './types'

/** Generate a timestamped migration file with up/down SQL from the schema diff. */
export async function generateMigration(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  opts: { allowDestructive?: boolean, schema?: string } = {},
): Promise<MigrationFile | null> {
  const ops = await planMigration(executor, registry, dialectOf(executor), opts.schema)

  if (ops.length === 0)
    return null

  const destructiveOps = ops.filter(o => o.destructive)

  if (destructiveOps.length && !opts.allowDestructive) {
    throw new DestructiveOpError(
      `Migration contains ${destructiveOps.length} destructive operation(s). Use --allow-destructive to proceed.`,
      'diff',
      destructiveOps.map(o => o.description),
    )
  }

  const timestamp = new Date().toISOString().replace(TIMESTAMP_DELIM_RE, '-').slice(0, 19)
  const upSql = ops.map(o => `${o.sql};`).join('\n\n')
  const downSql = generateDownSql(ops, { dialect: dialectOf(executor) })

  return {
    name: `${timestamp}_migration`,
    up: upSql,
    down: downSql,
  }
}

/** Execute raw migration SQL against the database. Wraps errors in MigrationError. */
export async function applyMigration(executor: Executable, sql: string): Promise<void> {
  try {
    // A SQLite rebuild drops a table, which with foreign keys on would delete the rows pointing at it.
    if (executor.migrate && dialectOf(executor) === 'sqlite')
      await executor.migrate(query => query(sql, []))
    else
      await executor.query(sql, [])
  }
  catch (err) {
    throw new MigrationError(
      `Migration apply failed: ${err instanceof Error ? err.message : String(err)}`,
      'apply',
      undefined,
      err,
    )
  }
}

/** Check if the live database has drifted from the desired schema. */
export async function getMigrationStatus(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  schema?: string,
): Promise<{
  drift: MigrationOp[]
  hasDrift: boolean
}> {
  const drift = await planMigration(executor, registry, dialectOf(executor), schema)

  return { drift, hasDrift: drift.length > 0 }
}
