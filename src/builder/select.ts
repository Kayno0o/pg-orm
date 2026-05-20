import type { AnyColumns, AnyRelations, AnyTableDef, InferRelationResult, InferSelect, RelationDef } from '../types/index'
import type { AggResult, ExprBuilder, ExprOp, ExprTape } from './expr'
import type { IncludeCallback, OrderDir, OrderEntry } from './state'
import { validateIdentifier } from '../schema/validate'
import { BaseBuilder } from './base'
import { createExprBuilder, OP_AND } from './expr'

export class SelectBuilder<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TResult = InferSelect<TColumns>,
> extends BaseBuilder {
  constructor(table: string) {
    super('select', table)
  }

  /** Select only the specified columns. */
  pick<K extends (keyof TColumns & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Pick<InferSelect<TColumns>, K[number]>> {
    this._state.columns = cols as string[]

    return this as never
  }

  /** Exclude the specified columns from the result. */
  omit<K extends (keyof TColumns & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Omit<InferSelect<TColumns>, K[number]>> {
    this._state.omitColumns = cols as string[]

    return this as never
  }

  /**
   * Add a computed column built from the safe `ExprBuilder` aggregate API.
   * Example: `.computed(e => e.countCol(), 'total')`
   */
  computed<T>(
    fn: (e: ExprBuilder<TColumns>) => AggResult<T>,
    alias: string,
  ): SelectBuilder<TColumns, TRelations, TResult & Record<typeof alias, T>> {
    validateIdentifier(alias, 'computed alias')

    const builder = createExprBuilder<TColumns>()
    const expr = fn(builder)

    this._state.computedColumns.push({ expr, alias })

    return this as never
  }

  /**
   * Add a computed column from a raw SQL expression string. The string is
   * interpolated unparameterized; the caller is responsible for ensuring it
   * contains only trusted SQL (no user input). Prefer `computed()` with the
   * `ExprBuilder` callback whenever possible.
   */
  computedRaw<TComputed = unknown>(
    expr: string,
    alias: string,
  ): SelectBuilder<TColumns, TRelations, TResult & Record<typeof alias, TComputed>> {
    validateIdentifier(alias, 'computed alias')
    this._state.computedColumns.push({ expr, alias })

    return this as never
  }

  distinct(): this {
    this._state.distinct = true

    return this
  }

  distinctOn<K extends (keyof TColumns & string)[]>(...cols: K): this {
    this._state.distinctOn = cols as string[]

    return this
  }

  /** Set the WHERE clause. Replaces any existing WHERE. */
  where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }

  /** Add an additional AND condition to the existing WHERE clause. */
  andWhere(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()
    const newTape = fn(builder)

    if (this._state.whereTape) {
      this._state.whereTape = [
        { op: OP_AND, count: 2 } as ExprOp,
        ...this._state.whereTape,
        ...newTape,
      ]
    }
    else {
      this._state.whereTape = newTape
    }

    return this
  }

  /** INNER JOIN another table. */
  join(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'inner', table, alias, on: on(builder) })

    return this
  }

  /** LEFT JOIN another table. */
  leftJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'left', table, alias, on: on(builder) })

    return this
  }

  rightJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'right', table, alias, on: on(builder) })

    return this
  }

  fullJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'full', table, alias, on: on(builder) })

    return this
  }

  /** Add an ORDER BY clause. Can be called multiple times for multi-column ordering. */
  orderBy(col: keyof TColumns & string, dir: OrderDir = 'asc', nulls?: 'first' | 'last'): this {
    this._state.orderBy.push({ col, dir, nulls })

    return this
  }

  /** Limit the number of returned rows. */
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`limit() requires a non-negative integer, got ${n}`)
    }

    this._state.limit = n

    return this
  }

  /** Skip the first N rows. */
  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`offset() requires a non-negative integer, got ${n}`)
    }

    this._state.offset = n

    return this
  }

  groupBy(...cols: (keyof TColumns & string)[]): this {
    this._state.groupBy = cols as string[]

    return this
  }

  having(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.havingTape = fn(builder)

    return this
  }

  /** Add FOR UPDATE row-level locking. */
  forUpdate(): this {
    this._state.lockMode = 'update'

    return this
  }

  forShare(): this {
    this._state.lockMode = 'share'

    return this
  }

  forNoKeyUpdate(): this {
    this._state.lockMode = 'no_key_update'

    return this
  }

  skipLocked(): this {
    this._state.skipLocked = true

    return this
  }

  window(name: string, opts: { partitionBy?: string[], orderBy?: OrderEntry[] }): this {
    this._state.windows.push({ name, partitionBy: opts.partitionBy ?? [], orderBy: opts.orderBy ?? [] })

    return this
  }

  with(name: string, sql: string, params: unknown[] = [], materialized?: boolean): this {
    this._state.ctes.push({ name, sql, params, materialized })

    return this
  }

  withRecursive(name: string, sql: string, params: unknown[] = [], materialized?: boolean): this {
    this._state.ctes.push({ name, sql, params, materialized, recursive: true })

    return this
  }

  as(_alias: string): this {
    this._state.alias = _alias

    return this
  }

  // Typed eager relation loading — constrained to relation names only.
  // hasMany relations always use WHERE fk = ANY($1) batching, never per-row subqueries.
  //
  // Two forms:
  //   .include('posts')                                           — simple include
  //   .include('posts', postsTable, pq => pq.include(...))       — typed callback (filtering + nesting)
  include<K extends keyof TRelations & string>(
    relation: K,
  ): SelectBuilder<TColumns, TRelations, TResult & { [P in K]: InferRelationResult<TRelations[P]> }>
  include<K extends keyof TRelations & string, TTable extends AnyTableDef, TChildResult>(
    relation: K,
    table: TTable,
    callback: (q: SelectBuilder<TTable['columns'], TTable['relations'], InferSelect<TTable['columns']>>) => SelectBuilder<TTable['columns'], TTable['relations'], TChildResult>,
  ): SelectBuilder<TColumns, TRelations, TResult & {
    [P in K]: TRelations[P] extends RelationDef<'hasMany', any, any> ? TChildResult[]
      : TRelations[P] extends RelationDef<'hasManyThrough', any, any> ? TChildResult[]
        : TRelations[P] extends RelationDef<infer _K, any, infer N> ? N extends true ? TChildResult | null : TChildResult
          : TChildResult
  }>
  include(
    relation: string,
    table?: AnyTableDef,
    callback?: IncludeCallback,
  ): SelectBuilder<TColumns, TRelations, any> {
    this._state.includes.push({ relation, strategy: 'batch', callback })

    return this as never
  }

  // Aggregate builder — uses ExprBuilder aggregate methods to build computed columns
  // Usage: .aggregate(e => ({ total: e.sum('amount'), avg: e.avg('price') }))
  aggregate<TAgg extends Record<string, AggResult<unknown>>>(
    fn: (e: ExprBuilder<TColumns>) => TAgg,
  ): SelectBuilder<TColumns, TRelations, { [K in keyof TAgg]: TAgg[K] extends AggResult<infer T> ? T : number }> {
    const builder = createExprBuilder<TColumns>()
    const aggs = fn(builder)

    this._state.columns = []

    for (const [alias, expr] of Object.entries(aggs)) {
      this._state.computedColumns.push({ expr, alias })
    }

    return this as never
  }

  count(): SelectBuilder<TColumns, TRelations, { count: number }> {
    this._state.op = 'count'

    return this as never
  }

  /** Include soft-deleted rows in the result. */
  withTrashed(): this {
    this._state.withTrashed = true

    return this
  }
}
