import type { AnyColumns, AnyRelations, AnyTableDef, ColumnDef, InferRelationResult, InferSelect, IsNullable, RelationDef, ScopeOptions } from '../types/index'
import type { OptionalWhere, WhereInput } from './_where'
import type { AggResult, ExprBuilder, ExprTape, RelationWhere, SubqueryRef, TypedExpr } from './expr'
import type { IncludeCallback, OrderDir, OrderEntry, TableTarget } from './state'
import type { VectorSearchOptions } from './vector-search'
import { SOFT_DELETE_SCOPE } from '../constants'
import { ValidationError } from '../errors/index'
import { validateIdentifier, validateRawSqlFragment } from '../schema/validate'
import { placeholderNumbers } from './_placeholders'
import { appendWhere, compileWhere, replaceWhere } from './_where'
import { BaseBuilder } from './base'
import { createExprBuilder } from './expr'
import { vectorSearchSettings } from './vector-search'

type CountableRelations<TRelations extends AnyRelations> = {
  [K in keyof TRelations]: TRelations[K] extends RelationDef<'hasMany' | 'hasManyThrough', any, any, any> ? K : never
}[keyof TRelations] & string

type RelationColumns<R> = R extends RelationDef<any, any, any, infer T> ? T['columns'] : AnyColumns

// A joined table's columns, keyed `alias.col`; an outer join makes them nullable.
export type Joined<TJoin extends AnyColumns, TAlias extends string, TNullable extends boolean> = {
  [K in keyof TJoin & string as `${TAlias}.${K}`]: TNullable extends true ? Nullable<TJoin[K]> : TJoin[K]
}

type Nullable<C> = C extends ColumnDef<infer T, any, infer D, infer P, infer G> ? ColumnDef<T, IsNullable, D, P, G> : C

// What a result holds beyond the table columns (computed, include, withCount, aggregates), which reshaping the columns keeps.
type Extras<TResult, TColumns extends AnyColumns> = Omit<TResult, keyof TColumns>

/** A raw SQL expression tagged with the type its value reads back as, for `computedRaw`. @trusted like every raw fragment. */
export interface RawExpr<T> {
  readonly sql: string
  readonly _type?: T
}

/** Tag a raw SQL expression with the type its value reads back as: `rawExpr<number>('count(*)')`. */
export function rawExpr<T>(sql: string): RawExpr<T> {
  return { sql }
}

/**
 * Builder for `SELECT` statements. Composable, fluent, returns `this`-typed
 * chains. The three generics drive end-to-end type inference; reshaping methods
 * (`pick`, `omit`, `computed`, `aggregate`, `count`, `include`) return a new
 * `SelectBuilder` instance with a refined `TResult`.
 *
 * @template TColumns  The owning table's column map. Constrains identifier-bound
 *   methods (`where`, `orderBy`, `groupBy`, `include`, …) so misspellings fail
 *   at compile time.
 * @template TRelations  The owning table's relation map. Constrains `include()`
 *   to defined relations and threads child-row types into `TResult`.
 * @template TResult  Row shape this builder will return. Defaults to
 *   `InferSelect<TColumns>`; reshaping methods narrow/widen it.
 * @template TGroup  The `groupBy` columns, which every column list keeps.
 * @template TJoined  The columns of joined tables, keyed `alias.col`.
 */
export class SelectBuilder<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TResult = InferSelect<TColumns>,
  TGroup extends keyof (TColumns & TJoined) & string = never,
  TJoined extends AnyColumns = {},
> extends BaseBuilder {
  constructor(table: TableTarget) {
    super('select', table)
  }

  /** Select only the specified columns, keeping computed, include and withCount fields. */
  pick<K extends (keyof (TColumns & TJoined) & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Pick<InferSelect<TColumns & TJoined>, K[number] | TGroup> & Extras<TResult, TColumns & TJoined>, TGroup, TJoined> {
    this._state.columns = cols as string[]

    return this as never
  }

  /** Leave the specified columns out of the SELECT, keeping computed, include and withCount fields. Group columns stay. */
  omit<K extends (keyof (TColumns & TJoined) & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Omit<TResult, Exclude<K[number], TGroup>>, TGroup, TJoined> {
    this._state.omitColumns = cols as string[]

    return this as never
  }

  /**
   * Add a computed column built from the safe `ExprBuilder` aggregate API.
   * Example: `.computed(e => e.countCol(), 'total')`
   */
  computed<TAlias extends string, T>(
    fn: (e: ExprBuilder<TColumns & TJoined>) => AggResult<T> | TypedExpr<T>,
    alias: TAlias,
  ): SelectBuilder<TColumns, TRelations, TResult & Record<TAlias, T>, TGroup, TJoined> {
    validateIdentifier(alias, 'computed alias')

    const builder = createExprBuilder<TColumns & TJoined>()
    const expr = fn(builder)

    this._state.computedColumns.push(typeof expr === 'string' ? { expr, alias } : { expr: '', alias, tape: expr })

    return this as never
  }

  /**
   * Add a computed column from a raw SQL expression string.
   *
   * @trusted The expression is interpolated unparameterized. Pass only
   * developer-authored SQL — never user input. Prefer `computed()` with the
   * `ExprBuilder` callback for safer composition.
   *
   * Defense-in-depth: the expression is run through `validateRawSqlFragment`
   * (same allowlist as DDL fragments) which rejects `;`, `--`, `/*`, dollar-
   * quoted strings, `E'...'`/`U&'...'` escape literals, and unterminated
   * quotes. This blocks the realistic injection path (analytics-dashboard
   * copy-paste, dynamic column lists) without lifting the "developer-authored
   * only" rule. See README "Security model".
   *
   * Type the value with `rawExpr`, which keeps the alias as a named property: `.computedRaw(rawExpr<number>('count(*)'), 'total')`.
   */
  computedRaw<TAlias extends string, TComputed = unknown>(
    raw: string | RawExpr<TComputed>,
    alias: TAlias,
  ): SelectBuilder<TColumns, TRelations, TResult & Record<TAlias, TComputed>, TGroup, TJoined> {
    validateIdentifier(alias, 'computed alias')

    const expr = typeof raw === 'string' ? raw : raw.sql

    if (!expr || !expr.trim()) {
      throw new ValidationError(
        'computedRaw expression must not be empty.',
        'computedRaw expression',
        { value: expr },
      )
    }

    validateRawSqlFragment(expr, 'computedRaw expression')
    this._state.computedColumns.push({ expr, alias })

    return this as never
  }

  /** Emit `SELECT DISTINCT`. */
  distinct(): this {
    this._state.distinct = true

    return this
  }

  /** Emit `SELECT DISTINCT ON (cols...)` — keep the first row per `cols` tuple. */
  distinctOn<K extends (keyof (TColumns & TJoined) & string)[]>(...cols: K): this {
    this._state.distinctOn = cols as string[]

    return this
  }

  /**
   * Set the WHERE clause, as either `{ col: value }` (entries ANDed) or an
   * `ExprBuilder` callback. Replaces any existing WHERE; a falsy `cond` is a no-op.
   */
  where(cond: OptionalWhere<TColumns & TJoined, TRelations>): this {
    replaceWhere<TColumns & TJoined>(this._state, cond)

    return this
  }

  /**
   * AND an additional condition onto the WHERE clause. Works as the first
   * clause too, and a falsy `cond` is a no-op — so optional filters need no
   * branching: `q.andWhere(status && { status })`.
   */
  andWhere(cond: OptionalWhere<TColumns & TJoined, TRelations>): this {
    appendWhere<TColumns & TJoined>(this._state, [cond])

    return this
  }

  /** AND `e.has(relation, where, opts)`: rows with at least one related row matching `where`. */
  whereHas<K extends keyof TRelations & string>(relation: K, where?: RelationWhere<TRelations[K]>, opts?: ScopeOptions): this {
    return this.andWhere(e => e.has(relation, where, opts))
  }

  /** AND `e.doesntHave(relation, where, opts)`: rows with no related row matching `where`. */
  whereDoesntHave<K extends keyof TRelations & string>(relation: K, where?: RelationWhere<TRelations[K]>, opts?: ScopeOptions): this {
    return this.andWhere(e => e.doesntHave(relation, where, opts))
  }

  /** AND every truthy condition onto the WHERE clause. Falsy entries are skipped. */
  whereAll(...conds: OptionalWhere<TColumns & TJoined, TRelations>[]): this {
    appendWhere<TColumns & TJoined>(this._state, conds)

    return this
  }

  /** INNER JOIN another table. Given its table def, its columns are typed as `alias.col` in ON, where, orderBy and pick, a pick returning them under that name. */
  join<TJoin extends AnyTableDef, TAlias extends string>(table: TJoin, alias: TAlias, on: (e: ExprBuilder<TColumns & TJoined & Joined<TJoin['columns'], TAlias, false>>) => ExprTape): SelectBuilder<TColumns, TRelations, TResult, TGroup, TJoined & Joined<TJoin['columns'], TAlias, false>>
  join(table: string, alias: string, on: (e: ExprBuilder<TColumns & TJoined>) => ExprTape): this
  join(table: AnyTableDef | string, alias: string, on: (e: ExprBuilder<any>) => ExprTape): any {
    return this._join('inner', table, alias, on)
  }

  /** LEFT JOIN another table, its typed columns nullable. */
  leftJoin<TJoin extends AnyTableDef, TAlias extends string>(table: TJoin, alias: TAlias, on: (e: ExprBuilder<TColumns & TJoined & Joined<TJoin['columns'], TAlias, true>>) => ExprTape): SelectBuilder<TColumns, TRelations, TResult, TGroup, TJoined & Joined<TJoin['columns'], TAlias, true>>
  leftJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns & TJoined>) => ExprTape): this
  leftJoin(table: AnyTableDef | string, alias: string, on: (e: ExprBuilder<any>) => ExprTape): any {
    return this._join('left', table, alias, on)
  }

  /** RIGHT JOIN another table. */
  rightJoin<TJoin extends AnyTableDef, TAlias extends string>(table: TJoin, alias: TAlias, on: (e: ExprBuilder<TColumns & TJoined & Joined<TJoin['columns'], TAlias, false>>) => ExprTape): SelectBuilder<TColumns, TRelations, TResult, TGroup, TJoined & Joined<TJoin['columns'], TAlias, false>>
  rightJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns & TJoined>) => ExprTape): this
  rightJoin(table: AnyTableDef | string, alias: string, on: (e: ExprBuilder<any>) => ExprTape): any {
    return this._join('right', table, alias, on)
  }

  /** FULL OUTER JOIN another table, its typed columns nullable. */
  fullJoin<TJoin extends AnyTableDef, TAlias extends string>(table: TJoin, alias: TAlias, on: (e: ExprBuilder<TColumns & TJoined & Joined<TJoin['columns'], TAlias, true>>) => ExprTape): SelectBuilder<TColumns, TRelations, TResult, TGroup, TJoined & Joined<TJoin['columns'], TAlias, true>>
  fullJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns & TJoined>) => ExprTape): this
  fullJoin(table: AnyTableDef | string, alias: string, on: (e: ExprBuilder<any>) => ExprTape): any {
    return this._join('full', table, alias, on)
  }

  private _join(type: 'inner' | 'left' | 'right' | 'full', target: AnyTableDef | string, alias: string, on: (e: ExprBuilder<any>) => ExprTape): this {
    const table = typeof target === 'string' ? target : target.name

    validateIdentifier(table, `${type} join table`)
    validateIdentifier(alias, `${type} join alias`)
    this._state.joins.push({ type, table, alias, on: on(createExprBuilder()), columns: typeof target === 'string' ? undefined : Object.keys(target.columns) })

    return this
  }

  /** Add an ORDER BY clause, on a column or an expression (`e => e.vectorCosineDistance('embedding', vec)`). Can be called multiple times for multi-column ordering. */
  orderBy(col: (keyof (TColumns & TJoined) & string) | ((e: ExprBuilder<TColumns & TJoined>) => ExprTape), dir: OrderDir = 'asc', nulls?: 'first' | 'last'): this {
    this._state.orderBy.push(typeof col === 'string' ? { col, dir, nulls } : { col: '', expr: col(createExprBuilder<TColumns & TJoined>()), dir, nulls })

    return this
  }

  /** Limit the number of returned rows. */
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new ValidationError(`limit() requires a non-negative integer, got ${n}`, 'limit', { value: n })
    }

    this._state.limit = n

    return this
  }

  /** Skip the first N rows. */
  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new ValidationError(`offset() requires a non-negative integer, got ${n}`, 'offset', { value: n })
    }

    this._state.offset = n

    return this
  }

  /** GROUP BY one or more columns, which the SELECT then always lists. */
  groupBy<K extends (keyof (TColumns & TJoined) & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, TResult & Pick<InferSelect<TColumns & TJoined>, K[number]>, K[number], TJoined> {
    this._state.groupBy = cols as string[]

    return this as never
  }

  /** GROUP BY expressions, after any `groupBy` columns: `groupByExpr(e => e.coalesce('team', 'none'))`. */
  groupByExpr(...exprs: ((e: ExprBuilder<TColumns & TJoined>) => ExprTape)[]): this {
    const builder = createExprBuilder<TColumns & TJoined>()

    this._state.groupByExprs = [...this._state.groupByExprs ?? [], ...exprs.map(fn => fn(builder))]

    return this
  }

  /** Filter aggregated groups (`HAVING`). Replaces any existing HAVING clause. */
  having(cond: WhereInput<TColumns & TJoined>): this {
    this._state.havingTape = compileWhere<TColumns & TJoined>(cond)

    return this
  }

  /**
   * Postgres only. Sets pgvector's search settings for this query: they are applied with `SET LOCAL` inside the transaction the statement runs in, one opened for it unless it already runs in one (where they then hold until that transaction ends).
   *
   * @example
   * ```ts
   * repo.read.findMany(q => q.orderBy(e => e.vectorCosineDistance('embedding', vec)).limit(10).vectorSearch({ efSearch: 100 }))
   * ```
   */
  vectorSearch(opts: VectorSearchOptions): this {
    vectorSearchSettings(opts)
    this._state.vectorSearch = { ...opts }

    return this
  }

  /** Add FOR UPDATE row-level locking. */
  forUpdate(): this {
    this._state.lockMode = 'update'

    return this
  }

  /** Add FOR SHARE shared row-level locking. */
  forShare(): this {
    this._state.lockMode = 'share'

    return this
  }

  /** Add FOR NO KEY UPDATE row-level locking (allows concurrent FK references). */
  forNoKeyUpdate(): this {
    this._state.lockMode = 'no_key_update'

    return this
  }

  /** Add FOR KEY SHARE row-level locking (blocks only changes to the key, so concurrent non-key updates go through). */
  forKeyShare(): this {
    this._state.lockMode = 'key_share'

    return this
  }

  /** Combine with a lock to skip rows that are already locked. */
  skipLocked(): this {
    this._state.skipLocked = true

    return this
  }

  /** Combine with a lock to fail at once, rather than wait, on a row already locked. */
  noWait(): this {
    this._state.noWait = true

    return this
  }

  /** Lock only the rows of these tables or join aliases (`FOR UPDATE OF "w"`), not every table the query reads. */
  lockOf(...tables: string[]): this {
    for (const table of tables) validateIdentifier(table, 'lockOf table')
    this._state.lockOf = tables

    return this
  }

  /** Declare a named WINDOW for use in window functions. */
  window(name: string, opts: { partitionBy?: string[], orderBy?: OrderEntry[] }): this {
    validateIdentifier(name, 'window name')
    this._state.windows.push({ name, partitionBy: opts.partitionBy ?? [], orderBy: opts.orderBy ?? [] })

    return this
  }

  /**
   * Attach a CTE (`WITH name AS (sql)`).
   *
   * @trusted The `sql` body is interpolated unparameterized. Pass only
   * developer-authored SQL — NEVER user input. Use positional `$N`
   * placeholders for any dynamic values and pass them via `params`. Do not
   * use template-string interpolation: ``` `... WHERE id = ${userInput}` ```
   * is an injection. See README "Security model".
   */
  with(name: string, sql: string, params?: unknown[], materialized?: boolean): this
  /** Attach a CTE built by a builder (`q.with('recent', db.repo(posts).read.select().where(...))`), parameterized like any query. */
  with(name: string, query: SubqueryRef, materialized?: boolean): this
  with(name: string, body: string | SubqueryRef, paramsOrMat?: unknown[] | boolean, materialized?: boolean): this {
    return this._cte('with', name, body, paramsOrMat, materialized)
  }

  /**
   * Attach a recursive CTE (`WITH RECURSIVE name AS (sql)`).
   *
   * @trusted Same safety contract as {@link with}: the `sql` body is
   * interpolated unparameterized. Use `$N` placeholders + `params` only;
   * never interpolate user input.
   */
  withRecursive(name: string, sql: string, params?: unknown[], materialized?: boolean): this
  /** Attach a recursive CTE built by a builder, typically a `SetOperationBuilder.unionAll` of a base query and one reading the CTE by name. */
  withRecursive(name: string, query: SubqueryRef, materialized?: boolean): this
  withRecursive(name: string, body: string | SubqueryRef, paramsOrMat?: unknown[] | boolean, materialized?: boolean): this {
    return this._cte('withRecursive', name, body, paramsOrMat, materialized, true)
  }

  private _cte(context: string, name: string, body: string | SubqueryRef, paramsOrMat: unknown[] | boolean | undefined, materialized: boolean | undefined, recursive?: true): this {
    validateIdentifier(name, `${context} CTE name`)

    if (typeof body !== 'string') {
      this._state.ctes.push({ name, sql: '', params: [], query: body, materialized: typeof paramsOrMat === 'boolean' ? paramsOrMat : undefined, recursive })

      return this
    }

    const params = Array.isArray(paramsOrMat) ? paramsOrMat : []

    validateCtePlaceholders(body, params, context)
    this._state.ctes.push({ name, sql: body, params, materialized, recursive })

    return this
  }

  /** Alias the SELECT for use as a subquery (`(SELECT ...) AS alias`). */
  as(alias: string): this {
    validateIdentifier(alias, 'subquery alias')
    this._state.alias = alias

    return this
  }

  /**
   * Typed eager relation loading — constrained to relation names only.
   * `hasMany`/`hasManyThrough` use `WHERE fk = ANY($1)` batching (one extra query),
   * never N+1 per-row subqueries.
   *
   * Two forms:
   * - `.include('posts')` — simple include
   * - `.include('posts', postsTable, pq => pq.where(...).include(...))` — typed
   *   callback for filtering child rows and nesting further `.include`s.
   */
  include<K extends keyof TRelations & string>(
    relation: K,
  ): SelectBuilder<TColumns, TRelations, TResult & { [P in K]: InferRelationResult<TRelations[P]> }, TGroup, TJoined>
  include<K extends keyof TRelations & string, TTable extends AnyTableDef, TChildResult>(
    relation: K,
    table: TTable,
    callback: (q: SelectBuilder<TTable['columns'], TTable['relations'], InferSelect<TTable['columns']>>) => SelectBuilder<TTable['columns'], TTable['relations'], TChildResult, any, any>,
  ): SelectBuilder<TColumns, TRelations, TResult & {
    [P in K]: TRelations[P] extends RelationDef<'hasMany', any, any> ? TChildResult[]
      : TRelations[P] extends RelationDef<'hasManyThrough', any, any> ? TChildResult[]
        : TRelations[P] extends RelationDef<infer _K, any, infer N> ? N extends true ? TChildResult | null : TChildResult
          : TChildResult
  }, TGroup, TJoined>
  include(
    relation: string,
    _table?: AnyTableDef,
    callback?: IncludeCallback,
  ): SelectBuilder<TColumns, TRelations, any> {
    this._state.includes.push({ relation, strategy: 'batch', callback })

    return this as never
  }

  /**
   * Add the number of related rows as a column, in the same query: `.withCount('tiers')` gives each row `tiersCount: number`.
   * `as` renames it, `where` counts only matching children (typed against the target when the relation was built from a table thunk). Soft-deleted children, and those linked through a soft-deleted pivot row, are counted only with `withDeleted`; the target's and pivot's other scopes apply unless named in `withoutScopes`.
   */
  withCount<K extends CountableRelations<TRelations>, TAlias extends string = `${K}Count`>(
    relation: K,
    opts?: { as?: TAlias, where?: OptionalWhere<RelationColumns<TRelations[K]>>, withDeleted?: boolean, withoutScopes?: string[] },
  ): SelectBuilder<TColumns, TRelations, TResult & Record<TAlias, number>, TGroup, TJoined> {
    const alias = opts?.as ?? `${relation}Count`

    validateIdentifier(alias, 'withCount alias')
    this._state.relationCounts.push({ relation, alias, where: opts?.where ? compileWhere(opts.where) : null, withoutScopes: [...opts?.withoutScopes ?? [], ...opts?.withDeleted ? [SOFT_DELETE_SCOPE] : []] })

    return this as never
  }

  /**
   * Replace the column list with one or more aggregate expressions, the group columns kept.
   * The returned `TResult` is reshaped to the aggregate aliases, plus the group columns and earlier computed, include and withCount fields.
   *
   * @example
   * ```ts
   * .aggregate(e => ({ total: e.sum('amount'), avg: e.avg('price') }))
   * ```
   */
  aggregate<TAgg extends Record<string, AggResult<unknown>>>(
    fn: (e: ExprBuilder<TColumns & TJoined>) => TAgg,
  ): SelectBuilder<TColumns, TRelations, { [K in keyof TAgg]: TAgg[K] extends AggResult<infer T> ? T : number } & Pick<InferSelect<TColumns & TJoined>, TGroup> & Extras<TResult, TColumns & TJoined>, TGroup, TJoined> {
    const builder = createExprBuilder<TColumns & TJoined>()
    const aggs = fn(builder)

    this._state.columns = []

    for (const [alias, expr] of Object.entries(aggs)) {
      validateIdentifier(alias, 'aggregate alias')
      this._state.computedColumns.push({ expr, alias })
    }

    return this as never
  }

  /** Reshape to `SELECT count(*) AS count`. Used by `repo.count()`. */
  count(): SelectBuilder<TColumns, TRelations, { count: number }> {
    this._state.op = 'count'

    return this as never
  }

  /** Include soft-deleted rows in the result: `withoutScope('softDelete')`. */
  withTrashed(): this {
    return this.withoutScope(SOFT_DELETE_SCOPE)
  }

  /** Lift these scopes of the table, by the names a trait or `withScope` declared them under. */
  withoutScope(...names: string[]): this {
    this._state.withoutScopes.push(...names)

    return this
  }

  /**
   * Reshape the SELECT to a single `1 AS _exists` column. Combined with
   * `LIMIT 1`, callers use `rows.length > 0` to test existence. Used by
   * `repo.exists()`; not typically called directly.
   */
  asExists(): this {
    this._state.columns = []
    this._state.omitColumns = []
    this._state.computedColumns = [{ expr: '1', alias: '_exists' }]

    return this
  }

  /**
   * Hint for `repo.stream.offset()` — overrides the default chunk size when this
   * builder is passed to streaming. `opts.chunkSize` to `stream()` still wins
   * over the builder-side hint.
   */
  withStreamChunk(size: number): this {
    if (!Number.isInteger(size) || size <= 0) {
      throw new ValidationError(`withStreamChunk() requires a positive integer, got ${size}`, 'withStreamChunk', { value: size })
    }

    this._state.streamChunkSize = size

    return this
  }
}

// Verifies that the distinct `$N` placeholders referenced in a CTE body line up
// with the params array — catches both missing params (likely an injection via
// string interpolation when the caller meant to use $N) and extra params (a
// silent reindex bug at assembly time).
function validateCtePlaceholders(sql: string, params: unknown[], context: string): void {
  const seen = new Set<number>()
  let max = 0

  for (const n of placeholderNumbers(sql)) {
    seen.add(n)

    if (n > max)
      max = n
  }

  if (max !== params.length || seen.size !== params.length) {
    throw new ValidationError(
      `${context}(): SQL references ${seen.size} distinct placeholder(s) (max $${max}) but ${params.length} param(s) were provided. `
      + 'Use positional $N placeholders and pass values via params; never interpolate user input into the SQL string.',
      context,
      { value: { distinctPlaceholders: seen.size, maxPlaceholder: max, paramsLength: params.length } },
    )
  }
}
