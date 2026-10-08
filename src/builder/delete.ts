import type { AnyColumns, AnyTableDef, InferSelect } from '../types/index'
import type { Joined } from './select'
import { WhereableMutationBuilder } from './base'

export class DeleteBuilder<TColumns extends AnyColumns, _TResult = void, TJoined extends AnyColumns = {}> extends WhereableMutationBuilder<TColumns, TJoined> {
  constructor(table: string) {
    super('delete', table)
  }

  /** `DELETE ... USING` (Postgres only): read another table, its columns named `alias.col` in `where()`, the deleted table's own columns qualified. */
  using<TJoin extends AnyTableDef, TAlias extends string>(table: TJoin, alias: TAlias): DeleteBuilder<TColumns, _TResult, TJoined & Joined<TJoin['columns'], TAlias, false>>
  using(table: string, alias: string): this
  using(table: AnyTableDef | string, alias: string): unknown {
    this._addFrom(table, alias, 'DeleteBuilder.using()')

    return this
  }

  returning(): DeleteBuilder<TColumns, InferSelect<TColumns>, TJoined>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): DeleteBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>, TJoined>
  returning(...cols: string[]): DeleteBuilder<TColumns, unknown, TJoined> {
    return this._setReturning(cols) as never
  }
}
