import type { ConflictSet, ConflictValue } from '../builder/conflict'
import type { ConflictUpdate } from '../builder/insert'
import type { InsertBuilder as InsertBuilderCtor, WhereInput } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyTableDef, HookContext, InsertOptions, ScopedWriteOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { isConflictValue } from '../builder/conflict'
import { compileWhere, SelectBuilder as SelectBuilderCtor } from '../builder/query'
import { SOFT_DELETE_SCOPE } from '../constants'
import { dialectOf } from '../dialect'
import { ValidationError } from '../errors/index'
import { hasHooks } from '../hooks/index'
import { columnOf } from '../schema/inspect'
import { chunks } from '../utils/collection'
import { quote } from '../utils/quote'
import { scopeResolver } from './relation-filter'
import { resolveScopes } from './table-behavior'

const INSERTED_FLAG = '__pgorm_inserted'
// SQLite nests an OR chain one level per term, under its expression depth limit of 1000.
const SQLITE_OR_TERMS = 500

/** What `findOrCreate` takes: the scopes it lifts, by name. It reaches a trashed row anyway, to restore it. */
export type FindOrCreateOptions = Pick<ScopedWriteOptions, 'withoutScopes'>

/** An upsert's conflict update: the columns to copy from the incoming row, or the full `ConflictUpdate`. */
export type UpsertUpdate<TColumns extends AnyColumns> = (keyof TColumns & string)[] | ConflictUpdate<TColumns>

/** What an upsert takes after its conflict target: the `update` to run on a conflict, and the options every scoped write takes. */
export interface UpsertOptions<TColumns extends AnyColumns> extends ScopedWriteOptions {
  update?: UpsertUpdate<TColumns>
}

export function skipConflicts<TColumns extends AnyColumns>(builder: InsertBuilderCtor<TColumns>, opts?: InsertOptions<TColumns>): InsertBuilderCtor<TColumns> {
  return opts?.skipConflicts ? builder.onConflict(opts.skipConflicts).doNothing() : builder
}

/**
 * How to tell an upsert's inserted rows from its updated ones, so each fires its own after hook; undefined when no hook listens.
 * Postgres says it per row (`xmax = 0` on a row the statement inserted). SQLite has no such column, so the keys already present are read first: exact inside a transaction, best effort outside one, where a concurrent insert can land between the two statements.
 */
export async function insertedClassifier<TColumns extends AnyColumns>(executor: Executable, table: AnyTableDef, builder: InsertBuilderCtor<TColumns>, rows: Record<string, unknown>[], target: string[]): Promise<((raw: Record<string, unknown>) => boolean) | undefined> {
  if (!hasHooks(table, 'afterInsert') && !hasHooks(table, 'afterUpdate'))
    return undefined

  if (dialectOf(executor) === 'postgres') {
    builder.getState().returningExtra = `(xmax = 0) AS ${quote(INSERTED_FLAG)}`

    return (raw) => {
      const inserted = raw[INSERTED_FLAG] === true

      delete raw[INSERTED_FLAG]

      return inserted
    }
  }

  const keyOf = (row: Record<string, unknown>): string => JSON.stringify(target.map(col => String(row[col])))
  const conflicting = rows.filter(row => target.every(col => row[col] !== undefined && row[col] !== null))

  if (conflicting.length === 0)
    return () => true

  const existing = new Set<string>()

  for (const chunk of chunks(conflicting, SQLITE_OR_TERMS)) {
    const present = new SelectBuilderCtor<TColumns>(table)
      .pick(...target as (keyof TColumns & string)[])
      .where(e => e.or(...chunk.map(row => compileWhere<TColumns>(Object.fromEntries(target.map(col => [col, row[col]])) as WhereInput<TColumns>))))
    const { sql, params } = present.toSQL(dialectOf(executor))

    for (const row of await executor.query(sql, params))
      existing.add(keyOf(row))
  }

  return raw => !existing.has(keyOf(raw))
}

/**
 * Runs `beforeUpdate` on each upsert row, as the update it may become: what a hook sets or changes is written into the row, for the conflict update to take through EXCLUDED, so the inserted row carries it too.
 * Gives the rows and those columns, which every row must set alike, a row lacking one inserting its default and updating to it.
 */
export async function updateHookedRows(runtime: TableRuntime, hooks: HookContext, rows: Record<string, unknown>[]): Promise<{ rows: Record<string, unknown>[], columns: string[] }> {
  if (!hasHooks(runtime.table, 'beforeUpdate'))
    return { rows, columns: [] }

  const hooked = await runtime.runBeforeMany('beforeUpdate', rows.map(row => ({ ...row })), hooks)
  const changed = hooked.map((row, i) => Object.keys(row).filter(col => !Object.hasOwn(rows[i]!, col) || row[col] !== rows[i]![col]))
  const columns = [...new Set(changed.flat())]
  const uneven = columns.find(col => hooked.some(row => !Object.hasOwn(row, col)))

  if (uneven !== undefined)
    throw new ValidationError(`upsert on "${runtime.table.name}": a beforeUpdate hook set "${uneven}" on some rows only, where the conflict update writes it for every row.`, 'upsert', { field: uneven })

  return { rows: hooked, columns }
}

// The row an upsert updates is updated like any other: the columns `beforeUpdate` hooks set (timestamps), taken from the incoming row, and the version bump apply to it, and only while the scopes not `lifted` hold for it. A trashed row is restored, taking the incoming row's soft-delete column (null unless given), unless `set` says otherwise.
// `normalize` encodes a plain value for its column, as every write does.
export function conflictUpdate<TColumns extends AnyColumns>(
  runtime: TableRuntime,
  registry: ReadonlyMap<string, AnyTableDef> | undefined,
  normalize: (values: Record<string, unknown>) => Record<string, unknown>,
  update: UpsertUpdate<TColumns> | undefined,
  hookedColumns: string[],
  lifted: string[],
): ConflictUpdate<TColumns> {
  const { table } = runtime
  const given: ConflictUpdate<TColumns> = Array.isArray(update) ? { columns: update } : update ?? {}
  const guards = resolveScopes(table, undefined, scopeResolver(table, registry)).filter(scope => scope.name !== SOFT_DELETE_SCOPE && !lifted.includes(scope.name))
  const spec: ConflictUpdate<TColumns> = guards.length === 0
    ? given
    : { ...given, where: e => e.and(...given.where ? [compileWhere<TColumns>(given.where, table.columns as TColumns)] : [], ...guards.map(scope => scope.tape)) }
  const lock = runtime.behavior.getOptimisticLockColumn()
  const trashCol = runtime.behavior.getSoftDeleteColumn()

  for (const col of spec.columns ?? [])
    columnOf(table, col, 'upsert')

  if (!spec.set && hookedColumns.length === 0 && !lock && !trashCol && guards.length === 0)
    return spec

  return {
    ...spec,
    set: (u) => {
      const hooked = Object.fromEntries(hookedColumns.map(col => [col, u.excluded(col as keyof TColumns & string)]))
      const set: Record<string, unknown> = { ...hooked, ...trashCol && { [trashCol]: u.excluded(trashCol) }, ...spec.set?.(u) }

      if (lock)
        set[lock] = u.add(u.existing(lock) as ConflictValue<number>, 1)

      // Plain values are bound like any write's, so a json value is marked; an expression is left to render itself.
      for (const [col, value] of Object.entries(set)) {
        if (isConflictValue(value))
          columnOf(table, col, 'upsert')
        else
          Object.assign(set, normalize({ [col]: value }))
      }

      return set as ConflictSet<TColumns>
    },
  }
}
