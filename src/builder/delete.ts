import type { AnyColumns, InferSelect } from '../types/index'
import type { ExprBuilder, ExprTape } from './expr'
import { WhereableMutationBuilder } from './base'
import { createExprBuilder } from './expr'

export class DeleteBuilder<TColumns extends AnyColumns, _TResult = void> extends WhereableMutationBuilder {
  constructor(table: string) {
    super('delete', table)
  }

  override where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }

  returning(): DeleteBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): DeleteBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): DeleteBuilder<TColumns, unknown> {
    return this._setReturning(cols) as never
  }
}
