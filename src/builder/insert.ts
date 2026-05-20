import type { AnyColumns, InferInsert, InferSelect } from '../types/index'
import { MutationBuilder } from './base'
import { validateValues } from './state'

export class InsertBuilder<TColumns extends AnyColumns, TResult = void> extends MutationBuilder {
  constructor(table: string) {
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

  onConflict(target: (keyof TColumns & string)[]): OnConflictBuilder<TColumns, TResult> {
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
}
