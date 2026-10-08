import type { Dialect } from '../dialect'
import type { AnyTableDef } from '../types/index'
import type { IgnoreTables } from './plan'
import type { MigrationOp, QueryFn } from './types'
import { DestructiveOpError } from '../errors/index'
import { djb2Hash, ensureMigrationTable, migrationName, recordMigration } from './history'
import { promptSync } from './interactive'
import { planMigration } from './plan'
import { generateDownSql } from './reverse'
import { MIGRATION_LOCK_KEY } from './types'

export interface SyncContext {
  query: QueryFn
  transact: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>
  readonly schema: string
  readonly tables: ReadonlyMap<string, AnyTableDef>
  readonly dialect?: Dialect
}

export interface SyncOptions {
  allowDestructive?: boolean
  dryRun?: boolean
  confirm?: boolean
  /** Tables neither created, changed nor dropped: a name, or a pattern names are tested against. */
  ignoreTables?: IgnoreTables
}

/**
 * Auto-migrate: introspect the live DB, diff against registered tables, and apply DDL.
 * Uses `pg_advisory_xact_lock` to prevent concurrent sync() calls; SQLite needs none, its write transactions running one at a time.
 */
export async function syncSchema(ctx: SyncContext, opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
  const dialect = ctx.dialect ?? 'postgres'

  // Phase 1: a value an enum gains cannot be used in the transaction that adds it, so the additions commit first, in a transaction of their own.
  // If they succeed but the main transaction fails, the enum values persist harmlessly (skipped on retry via IF NOT EXISTS).
  if (!opts?.dryRun && dialect === 'postgres') {
    await ctx.transact(async (txQuery) => {
      const preOps = await planMigration({ query: txQuery }, ctx.tables, dialect, ctx.schema, opts?.ignoreTables)

      for (const op of preOps.filter(o => o.type === 'alter_enum_add'))
        await txQuery(`${op.sql};`, [])
    })
  }

  // Phase 2: advisory lock + introspect + diff + apply DDL inside a single transaction.
  // The lock is transaction-scoped and auto-released on commit/rollback.
  return ctx.transact(async (txQuery) => {
    if (dialect === 'postgres')
      await txQuery('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])

    const txExecutor = { query: txQuery }
    const ops = await planMigration(txExecutor, ctx.tables, dialect, ctx.schema, opts?.ignoreTables)

    if (ops.length === 0)
      return { sql: '', ops: [] }

    const destructiveOps = ops.filter(o => o.destructive)

    if (destructiveOps.length && !opts?.allowDestructive && !opts?.confirm) {
      throw new DestructiveOpError(
        `Sync contains ${destructiveOps.length} destructive operation(s). Use { allowDestructive: true } or { confirm: true } to proceed.`,
        'diff',
        destructiveOps.map(o => o.description),
      )
    }

    const sqlStr = ops.map(o => `${o.sql};`).join('\n')

    if (opts?.confirm) {
      const confirmed = await promptSync(ops, destructiveOps)

      if (!confirmed)
        return { sql: sqlStr, ops: [] }
    }

    if (!opts?.dryRun) {
      // Filter out enum ADD VALUE ops (already applied in Phase 1)
      const otherOps = ops.filter(o => o.type !== 'alter_enum_add')

      for (const op of otherOps)
        await txQuery(`${op.sql};`, [])

      await ensureMigrationTable(txExecutor, dialect)
      const downSql = generateDownSql(ops, { validate: true, dialect })
      const hash = djb2Hash(sqlStr)

      await recordMigration(txExecutor, {
        name: migrationName('sync'),
        sqlHash: hash,
        upSql: sqlStr,
        downSql,
      })
    }

    return { sql: sqlStr, ops }
  })
}
