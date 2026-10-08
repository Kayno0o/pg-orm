import type { AnyColumns, AnyTableDef, InferSelect, InferUpdate } from '../types/index'
import type { ColumnRef, ExprBuilder } from './expr'
import type { Joined } from './select'
import { WhereableMutationBuilder } from './base'
import { createExprBuilder } from './expr'
import { rawSql, validateValues } from './state'

/** What `set()` writes: per column a value, or an expression (`e.ref('o.qty')`, `e.coalesce(...)`) printed as SQL. */
export type SetValues<TColumns extends AnyColumns> = { [K in keyof InferUpdate<TColumns>]?: InferUpdate<TColumns>[K] | ColumnRef }

export class UpdateBuilder<TColumns extends AnyColumns, _TResult = void, TJoined extends AnyColumns = {}> extends WhereableMutationBuilder<TColumns, TJoined> {
  constructor(table: string) {
    super('update', table)
  }

  /** The columns to write, as values or, from a callback, expressions reading the row or a `from()` table: `e => ({ stock: e.ref('o.qty') })`. */
  set(vals: InferUpdate<TColumns> | ((e: ExprBuilder<TColumns & TJoined>) => SetValues<TColumns>)): this {
    const values = (typeof vals === 'function' ? vals(createExprBuilder<TColumns & TJoined>()) : vals) as Record<string, unknown>

    validateValues(values, 'UpdateBuilder.set()')
    this._state.setValues = values

    return this
  }

  /** `UPDATE ... FROM`: read another table, its columns named `alias.col` in `where()` and `set()`, the updated table's own columns qualified. */
  from<TJoin extends AnyTableDef, TAlias extends string>(table: TJoin, alias: TAlias): UpdateBuilder<TColumns, _TResult, TJoined & Joined<TJoin['columns'], TAlias, false>>
  from(table: string, alias: string): this
  from(table: AnyTableDef | string, alias: string): unknown {
    this._addFrom(table, alias, 'UpdateBuilder.from()')

    return this
  }

  /**
   * Set a column to a raw SQL expression (bypasses `validateValues`). Internal
   * escape hatch for ORM-managed updates like the optimistic-lock increment.
   *
   * @trusted The SQL expression is inlined verbatim. Pass only developer-authored
   * SQL - never user input. See README "Security model".
   */
  setRaw(column: keyof TColumns & string, sqlExpression: string): this {
    ;(this._state.setValues ??= {})[column] = rawSql(sqlExpression)

    return this
  }

  returning(): UpdateBuilder<TColumns, InferSelect<TColumns>, TJoined>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): UpdateBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>, TJoined>
  returning(...cols: string[]): UpdateBuilder<TColumns, unknown, TJoined> {
    return this._setReturning(cols) as never
  }
}
