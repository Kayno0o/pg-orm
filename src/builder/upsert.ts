import type { AnyColumns, InferInsert, InferSelect } from '../types/index'
import type { TableTarget } from './state'
import { MutationBuilder } from './base'
import { validateValues } from './state'

export class UpsertBuilder<TColumns extends AnyColumns, _TResult = void> extends MutationBuilder {
  constructor(table: TableTarget) {
    super('upsert', table)
  }

  values(vals: InferInsert<TColumns>): this {
    validateValues(vals as Record<string, unknown>, 'UpsertBuilder.values()')
    this._state.insertValues = vals as Record<string, unknown>

    return this
  }

  onConflict(...cols: (keyof TColumns & string)[]): this {
    this._state.conflictTarget = cols as string[]

    return this
  }

  doUpdate(...cols: (keyof TColumns & string)[]): this {
    this._state.conflictUpdateCols = cols.length ? (cols as string[]) : null

    return this
  }

  returning(): UpsertBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): UpsertBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): UpsertBuilder<TColumns, unknown> {
    return this._setReturning(cols) as never
  }
}
