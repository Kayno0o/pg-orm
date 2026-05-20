import type { AnyColumns, InferSelect, InferUpdate } from '../types/index'
import type { ExprBuilder, ExprTape } from './expr'
import { WhereableMutationBuilder } from './base'
import { createExprBuilder } from './expr'
import { validateValues } from './state'

export class UpdateBuilder<TColumns extends AnyColumns, _TResult = void> extends WhereableMutationBuilder {
  constructor(table: string) {
    super('update', table)
  }

  set(vals: InferUpdate<TColumns>): this {
    validateValues(vals as Record<string, unknown>, 'UpdateBuilder.set()')
    this._state.setValues = vals as Record<string, unknown>

    return this
  }

  override where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }

  returning(): UpdateBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): UpdateBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): UpdateBuilder<TColumns, unknown> {
    return this._setReturning(cols) as never
  }
}
