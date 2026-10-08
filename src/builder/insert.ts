import type { AnyColumns, InferInsert, InferSelect } from '../types/index'
import type { SubqueryRef } from './_tape'
import type { OptionalWhere } from './_where'
import type { ConflictExprBuilder, ConflictSet } from './conflict'
import type { TableTarget } from './state'
import { compileWhere } from './_where'
import { MutationBuilder } from './base'
import { createConflictExprBuilder } from './conflict'
import { validateValues } from './state'

/** What an upsert does to the row it conflicts with. */
export interface ConflictUpdate<TColumns extends AnyColumns> {
  /** Columns copied from the incoming row. Defaults to every incoming column but the conflict target; `[]` copies none. */
  columns?: (keyof TColumns & string)[]
  /** Columns written from the existing and incoming rows: `u => ({ visits: u.add(u.existing('visits'), 1) })`. Wins over `columns` for a column in both. */
  set?: (u: ConflictExprBuilder<TColumns>) => ConflictSet<TColumns>
  /** Update only when this holds, bare columns naming the existing row (`e.ref('excluded.col')` for the incoming one). A row it skips is not returned. */
  where?: OptionalWhere<TColumns>
}

export class InsertBuilder<TColumns extends AnyColumns, TResult = void> extends MutationBuilder {
  constructor(table: TableTarget) {
    super('insert', table)
  }

  values(vals: InferInsert<TColumns>): this {
    validateValues(vals as Record<string, unknown>, 'InsertBuilder.values()')
    this._state.insertValues = vals as Record<string, unknown>

    return this
  }

  many(vals: InferInsert<TColumns>[]): this {
    this._state.op = 'insert_many'
    for (const v of vals) {
      validateValues(v as Record<string, unknown>, 'InsertBuilder.many()')
    }
    this._state.insertManyValues = vals as Record<string, unknown>[]

    return this
  }

  /** INSERT ... SELECT: write `columns` from the rows `query` returns, its columns in the same order. */
  fromSelect(columns: (keyof TColumns & string)[], query: SubqueryRef): this {
    this._state.insertSelect = { columns: [...columns], query }

    return this
  }

  /** Without a target, `ON CONFLICT DO NOTHING` skips a row conflicting on any unique constraint. */
  onConflict(): Pick<OnConflictBuilder<TColumns, TResult>, 'doNothing'>
  onConflict(target: (keyof TColumns & string)[]): OnConflictBuilder<TColumns, TResult>
  onConflict(target: (keyof TColumns & string)[] = []): OnConflictBuilder<TColumns, TResult> {
    this._state.conflictTarget = target as string[]

    return new OnConflictBuilder(this)
  }

  returning(): InsertBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): InsertBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): InsertBuilder<TColumns, unknown> {
    return this._setReturning(cols) as never
  }
}

export class OnConflictBuilder<TColumns extends AnyColumns, TResult> {
  constructor(private parent: InsertBuilder<TColumns, TResult>) {}

  doNothing(): InsertBuilder<TColumns, TResult> {
    this.parent._state.conflictAction = 'nothing'

    return this.parent
  }

  doUpdate(...cols: (keyof TColumns & string)[]): InsertBuilder<TColumns, TResult> {
    this.parent._state.conflictAction = 'update'
    this.parent._state.conflictUpdateCols = cols as string[]

    return this.parent
  }

  /** `DO UPDATE` with values computed from the existing row, and an optional guard. See `ConflictUpdate`. */
  doUpdateWith(update: ConflictUpdate<TColumns>): InsertBuilder<TColumns, TResult> {
    const state = this.parent._state
    const set = update.set?.(createConflictExprBuilder<TColumns>(state.table)) as Record<string, unknown> | undefined

    if (set)
      validateValues(set, 'upsert set')

    state.conflictAction = 'update'
    // In state `[]` means every incoming column and `null` none, the shape `doUpdate()` already uses.
    state.conflictUpdateCols = update.columns === undefined ? [] : update.columns.length ? update.columns as string[] : null
    state.conflictSet = set ?? null
    state.conflictWhere = update.where ? compileWhere(update.where) : null

    return this.parent
  }
}
