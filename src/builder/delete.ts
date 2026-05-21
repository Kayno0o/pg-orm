import type { AnyColumns, InferSelect } from '../types/index'
import { WhereableMutationBuilder } from './base'

export class DeleteBuilder<TColumns extends AnyColumns, _TResult = void> extends WhereableMutationBuilder<TColumns> {
  constructor(table: string) {
    super('delete', table)
  }

  returning(): DeleteBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): DeleteBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): DeleteBuilder<TColumns, unknown> {
    return this._setReturning(cols) as never
  }
}
