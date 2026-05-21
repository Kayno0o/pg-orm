import type { AnyColumns, InferSelect, InferUpdate } from '../types/index'
import { WhereableMutationBuilder } from './base'
import { rawSql, validateValues } from './state'

export class UpdateBuilder<TColumns extends AnyColumns, _TResult = void> extends WhereableMutationBuilder<TColumns> {
  constructor(table: string) {
    super('update', table)
  }

  set(vals: InferUpdate<TColumns>): this {
    validateValues(vals as Record<string, unknown>, 'UpdateBuilder.set()')
    this._state.setValues = vals as Record<string, unknown>

    return this
  }

  /**
   * Set a column to a raw SQL expression (bypasses `validateValues`). Internal
   * escape hatch for ORM-managed updates like the optimistic-lock increment.
   *
   * @trusted The SQL expression is inlined verbatim. Pass only developer-authored
   * SQL — never user input. See README "Security model".
   */
  setRaw(column: keyof TColumns & string, sqlExpression: string): this {
    ;(this._state.setValues ??= {})[column] = rawSql(sqlExpression)

    return this
  }

  returning(): UpdateBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): UpdateBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): UpdateBuilder<TColumns, unknown> {
    return this._setReturning(cols) as never
  }
}
