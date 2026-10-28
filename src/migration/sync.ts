import type { Dialect } from '../dialect'
import type { AnyTableDef } from '../types/index'
import type { IgnoreTables } from './plan'
import type { MigrationOp, QueryFn } from './types'
import { DestructiveOpError, MigrationError } from '../errors/index'
import { ensureMigrationTable, migrationName, recordMigration, sqlHash } from './history'
import { promptSync } from './interactive'
import { runOutsideTransaction } from './outside'
import { planEnumAdditions, planMigration } from './plan'
import { generateDownSql } from './reverse'
import { MIGRATION_LOCK_KEY } from './types'

export interface SyncContext {
  query: QueryFn
  transact: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>
  /** Runs the statements a transaction refuses, after it commits; `query` itself when absent. */
  outside?: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>
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
 * The destructive gate and the prompt see the whole plan before anything runs, so a refused sync leaves the database untouched.
 * Uses `pg_advisory_xact_lock` to prevent concurrent sync() calls; SQLite needs none, its write transactions running one at a time.
 */
export async function syncSchema(ctx: SyncContext, opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
  const dialect = ctx.dialect ?? 'postgres'
  const plan = (query: QueryFn): Promise<MigrationOp[]> => planMigration({ query }, ctx.tables, dialect, ctx.schema, opts?.ignoreTables)
  const planned = await plan(ctx.query)

  if (planned.length === 0)
    return { sql: '', ops: [] }

  const plannedSql = toSql(planned)

  // A dry run lists destructive ops rather than refusing them, as the CLI and `syncMigration` dry runs do.
  if (opts?.dryRun)
    return { sql: plannedSql, ops: planned }

  const destructiveOps = planned.filter(o => o.destructive)

  if (destructiveOps.length && !opts?.allowDestructive && !opts?.confirm) {
    throw new DestructiveOpError(
      `Sync contains ${destructiveOps.length} destructive operation(s). Use { allowDestructive: true } or { confirm: true } to proceed.`,
      'diff',
      destructiveOps.map(o => o.description),
    )
  }

  if (opts?.confirm && !await promptSync(planned, destructiveOps))
    return { sql: plannedSql, ops: [] }

  // Phase 1: a value an enum gains cannot be used in the transaction that adds it, so the additions commit first, in a transaction of their own.
  // If the main transaction then fails, the values persist harmlessly, skipped on retry via IF NOT EXISTS.
  const added = dialect === 'postgres'
    ? await ctx.transact(async (txQuery) => {
      await txQuery('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])

      const additions = await planEnumAdditions({ query: txQuery }, ctx.tables, ctx.schema, opts?.ignoreTables)

      for (const op of additions)
        await txQuery(`${op.sql};`, [])

      return additions
    })
    : []

  // Phase 2: advisory lock + introspect + diff + apply DDL inside a single transaction, the lock released on commit or rollback.
  const result = await ctx.transact(async (txQuery) => {
    if (dialect === 'postgres')
      await txQuery('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])

    const rest = (await plan(txQuery)).filter(o => o.type !== 'alter_enum_add')
    const approved = new Set(planned.map(o => o.sql))
    const unapproved = rest.filter(o => !approved.has(o.sql))

    // Another process changed the schema between the plan and the lock: what runs must be what the gate and the prompt saw.
    if (unapproved.length > 0)
      throw new MigrationError(`The schema changed while sync waited for its lock: ${unapproved.map(o => o.description).join('; ')}. Run sync again.`, 'diff')

    const ops = [...added, ...rest]

    if (ops.length === 0)
      return { sql: '', ops: [] }

    for (const op of rest) {
      if (!op.outsideTransaction)
        await txQuery(`${op.sql};`, [])
    }

    const txExecutor = { query: txQuery }
    const sqlStr = toSql(ops)

    await ensureMigrationTable(txExecutor, dialect)
    await recordMigration(txExecutor, {
      name: migrationName('sync'),
      sqlHash: sqlHash(sqlStr),
      upSql: sqlStr,
      downSql: generateDownSql(ops, { validate: true, dialect }),
    })

    return { sql: sqlStr, ops }
  })

  // Phase 3: what a transaction refuses (CREATE INDEX CONCURRENTLY), once the rest has committed.
  const outside = result.ops.filter(o => o.outsideTransaction)

  if (outside.length > 0)
    await runOutsideTransaction(ctx.outside ?? (fn => fn(ctx.query)), outside.map(o => o.sql))

  return result
}

function toSql(ops: MigrationOp[]): string {
  return ops.map(o => `${o.sql};`).join('\n')
}
