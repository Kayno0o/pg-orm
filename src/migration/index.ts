import type { Dialect } from '../dialect'
import type { Executable } from '../sql/executor'
import type { AnyTableDef } from '../types/index'
import type { IgnoreTables } from './plan'
import type { MigrationFile, MigrationOp } from './types'
import { dialectOf } from '../dialect'
import { DestructiveOpError, MigrationError } from '../errors/index'
import { migrationName } from './history'
import { outsideRunner, runOutsideTransaction, splitOutsideTransaction } from './outside'
import { planMigration } from './plan'
import { generateDownSql, sqlComment } from './reverse'

export { diffSchema } from './diff'
export { ensureMigrationTable, getMigrationHistory, recordMigration } from './history'
export { introspectLiveSchema } from './introspect'
export { type IgnoreTables, planMigration } from './plan'
export { rollbackMigrations } from './rollback'
export { syncSchema } from './sync'
export type { MigrationFile, MigrationOp } from './types'

export interface GenerateMigrationOptions {
  allowDestructive?: boolean
  schema?: string
  ignoreTables?: IgnoreTables
}

/** Generate a timestamped migration file with up/down SQL from the schema diff. */
export async function generateMigration(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  opts: GenerateMigrationOptions = {},
): Promise<MigrationFile | null> {
  return migrationFile(await planMigration(executor, registry, dialectOf(executor), opts.schema, opts.ignoreTables), dialectOf(executor), opts.allowDestructive)
}

/** The file running `ops`, each statement under a comment naming its op, null without any; throws on a destructive op unless allowed. */
export function migrationFile(ops: MigrationOp[], dialect: Dialect, allowDestructive = false): MigrationFile | null {
  if (ops.length === 0)
    return null

  const destructiveOps = ops.filter(o => o.destructive)

  if (destructiveOps.length && !allowDestructive) {
    throw new DestructiveOpError(
      `Migration contains ${destructiveOps.length} destructive operation(s). Use --allow-destructive to proceed.`,
      'diff',
      destructiveOps.map(o => o.description),
    )
  }

  const upSql = ops.map(o => `${sqlComment(o.description)}\n${o.sql};`).join('\n\n')
  const downSql = generateDownSql(ops, { dialect, comments: true })

  return {
    name: migrationName('migration'),
    up: upSql,
    down: downSql,
  }
}

/** Execute raw migration SQL against the database. Wraps errors in MigrationError. */
export async function applyMigration(executor: Executable, sql: string): Promise<void> {
  const { inside, outside } = splitOutsideTransaction(sql)

  try {
    // A SQLite rebuild drops a table, which with foreign keys on would delete the rows pointing at it.
    if (executor.migrate && dialectOf(executor) === 'sqlite')
      await executor.migrate(query => query(inside, []))
    else
      await executor.query(inside, [])
  }
  catch (err) {
    throw new MigrationError(
      `Migration apply failed: ${err instanceof Error ? err.message : String(err)}`,
      'apply',
      undefined,
      err,
    )
  }

  if (outside.length > 0)
    await runOutsideTransaction(outsideRunner(executor), outside)
}

/** Check if the live database has drifted from the desired schema. */
export async function getMigrationStatus(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  schema?: string,
  ignoreTables?: IgnoreTables,
): Promise<{
  drift: MigrationOp[]
  hasDrift: boolean
}> {
  const drift = await planMigration(executor, registry, dialectOf(executor), schema, ignoreTables)

  return { drift, hasDrift: drift.length > 0 }
}
