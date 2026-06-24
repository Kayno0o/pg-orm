import type { SQL } from 'bun'
import type { AnyTableDef } from '../types/index'
import type { MigrationOp } from './types'
import { DestructiveOpError } from '../errors/index'
import { asDriver } from '../sql/adapter'
import { TIMESTAMP_DELIM_RE } from '../utils/regex'
import { diffSchema } from './diff'
import { ensureMigrationTable, recordMigration } from './history'
import { promptSync } from './interactive'
import { introspectLiveSchema } from './introspect'
import { generateDownSql } from './reverse'

export interface SyncContext {
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>
  readonly sql: InstanceType<typeof SQL>
  readonly schema: string
  readonly tables: ReadonlyMap<string, AnyTableDef>
}

export interface SyncOptions {
  allowDestructive?: boolean
  dryRun?: boolean
  confirm?: boolean
}

// Stable hash key for `pg_advisory_xact_lock` — derived once from "pg-orm-sync".
const SYNC_LOCK_KEY = 741953258

/**
 * Auto-migrate: introspect the live DB, diff against registered tables, and apply DDL.
 * Uses `pg_advisory_xact_lock` to prevent concurrent sync() calls.
 */
export async function syncSchema(ctx: SyncContext, opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
  // Phase 1: enum ADD VALUE ops can't run inside a transaction in PG < 16, so execute them first.
  // If they succeed but the main transaction fails, the enum values persist harmlessly
  // (skipped on retry via IF NOT EXISTS).
  if (!opts?.dryRun) {
    const preLive = await introspectLiveSchema({ query: ctx.query, sql: ctx.sql }, ctx.schema)
    const preOps = diffSchema(preLive, ctx.tables)
    const enumAddOps = preOps.filter(o => o.type === 'alter_enum_add')

    for (const op of enumAddOps)
      await ctx.query(`${op.sql};`, [])
  }

  // Phase 2: advisory lock + introspect + diff + apply DDL inside a single transaction.
  // The lock is transaction-scoped and auto-released on commit/rollback.
  return asDriver(ctx.sql).begin(async (sqlTx) => {
    const txDriver = asDriver(sqlTx)

    await txDriver.unsafe('SELECT pg_advisory_xact_lock($1)', [SYNC_LOCK_KEY])

    const txExecutor = {
      query: async (sqlStr: string, params: unknown[]) => {
        return await txDriver.unsafe(sqlStr, params) as Record<string, unknown>[]
      },
      sql: sqlTx,
    }

    const live = await introspectLiveSchema(txExecutor, ctx.schema)
    const ops = diffSchema(live, ctx.tables)

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
        await txDriver.unsafe(`${op.sql};`, [])

      await ensureMigrationTable(txExecutor)
      const timestamp = new Date().toISOString().replace(TIMESTAMP_DELIM_RE, '-').slice(0, 19)
      const downSql = generateDownSql(ops, { validate: true })
      const hash = djb2Hash(sqlStr)

      await recordMigration(txExecutor, {
        name: `${timestamp}_sync`,
        sqlHash: hash,
        upSql: sqlStr,
        downSql,
      })
    }

    return { sql: sqlStr, ops }
  })
}

function djb2Hash(input: string): string {
  let hash = 5381

  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i) | 0
  }

  return (hash >>> 0).toString(36)
}
