import type { Executable } from '../sql/executor'
import type { AnyTableDef } from '../types/index'
import type { MigrationFile, MigrationOp } from './types'
import { DestructiveOpError, MigrationError } from '../errors/index'
import { TIMESTAMP_DELIM_RE } from '../utils/regex'
import { diffSchema } from './diff'
import { introspectLiveSchema } from './introspect'
import { generateDownSql } from './reverse'

export { diffSchema } from './diff'
export { djb2Hash, ensureMigrationTable, getMigrationHistory, type MigrationHistoryEntry, recordMigration } from './history'
export { introspectLiveSchema } from './introspect'
export { type RollbackContext, rollbackMigrations } from './rollback'
export { type SyncContext, type SyncOptions, syncSchema } from './sync'
export type { MigrationFile, MigrationOp } from './types'

/** Generate a timestamped migration file with up/down SQL from the schema diff. */
export async function generateMigration(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  opts: { allowDestructive?: boolean } = {},
): Promise<MigrationFile | null> {
  const live = await introspectLiveSchema(executor)
  const ops = diffSchema(live, registry)

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
  const downSql = generateDownSql(ops)

  return {
    name: `${timestamp}_migration`,
    up: upSql,
    down: downSql,
  }
}

/** Execute raw migration SQL against the database. Wraps errors in MigrationError. */
export async function applyMigration(executor: Executable, sql: string): Promise<void> {
  try {
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
): Promise<{
  drift: MigrationOp[]
  hasDrift: boolean
}> {
  const live = await introspectLiveSchema(executor)
  const drift = diffSchema(live, registry)

  return { drift, hasDrift: drift.length > 0 }
}
