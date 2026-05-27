import type { AnyColumns, AnyRelations, AnyTableDef, InferRelationResult, InferSelect, RelationDef } from '../types/index'
import type { AggResult, ExprBuilder, ExprOp, ExprTape } from './expr'
import type { IncludeCallback, OrderDir, OrderEntry } from './state'
import { ValidationError } from '../errors/index'
import { validateIdentifier, validateRawSqlFragment } from '../schema/validate'
import { BaseBuilder } from './base'
import { createExprBuilder, OP_AND } from './expr'
import { PLACEHOLDER_RE } from './state'

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
 */
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
   */
  computedRaw<TComputed = unknown>(
    expr: string,
    alias: string,
  ): SelectBuilder<TColumns, TRelations, TResult & Record<typeof alias, TComputed>> {
    validateIdentifier(alias, 'computed alias')

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
    validateIdentifier(table, 'join table')
    validateIdentifier(alias, 'join alias')
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'inner', table, alias, on: on(builder) })

    return this
  }

  /** LEFT JOIN another table. */
  leftJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    validateIdentifier(table, 'leftJoin table')
    validateIdentifier(alias, 'leftJoin alias')
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'left', table, alias, on: on(builder) })

    return this
  }

  /** RIGHT JOIN another table. */
  rightJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    validateIdentifier(table, 'rightJoin table')
    validateIdentifier(alias, 'rightJoin alias')
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'right', table, alias, on: on(builder) })

    return this
  }

  /** FULL OUTER JOIN another table. */
  fullJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    validateIdentifier(table, 'fullJoin table')
    validateIdentifier(alias, 'fullJoin alias')
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

  /** GROUP BY one or more columns. */
  groupBy(...cols: (keyof TColumns & string)[]): this {
    this._state.groupBy = cols as string[]

    return this
  }

  /** Filter aggregated groups (`HAVING`). Replaces any existing HAVING clause. */
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

  /** Combine with `forUpdate`/`forShare` to skip rows that are already locked. */
  skipLocked(): this {
    this._state.skipLocked = true

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
  with(name: string, sql: string, params: unknown[] = [], materialized?: boolean): this {
    validateIdentifier(name, 'with CTE name')
    validateCtePlaceholders(sql, params, 'with')
    this._state.ctes.push({ name, sql, params, materialized })

    return this
  }

  /**
   * Attach a recursive CTE (`WITH RECURSIVE name AS (sql)`).
   *
   * @trusted Same safety contract as {@link with}: the `sql` body is
   * interpolated unparameterized. Use `$N` placeholders + `params` only;
   * never interpolate user input.
   */
  withRecursive(name: string, sql: string, params: unknown[] = [], materialized?: boolean): this {
    validateIdentifier(name, 'withRecursive CTE name')
    validateCtePlaceholders(sql, params, 'withRecursive')
    this._state.ctes.push({ name, sql, params, materialized, recursive: true })

    return this
  }

  /** Alias the SELECT for use as a subquery (`(SELECT ...) AS alias`). */
  as(_alias: string): this {
    this._state.alias = _alias

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
    _table?: AnyTableDef,
    callback?: IncludeCallback,
  ): SelectBuilder<TColumns, TRelations, any> {
    this._state.includes.push({ relation, strategy: 'batch', callback })

    return this as never
  }

  /**
   * Replace the column list with one or more aggregate expressions.
   * The returned `TResult` is reshaped to the aggregate aliases.
   *
   * @example
   * ```ts
   * .aggregate(e => ({ total: e.sum('amount'), avg: e.avg('price') }))
   * ```
   */
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

  /** Reshape to `SELECT count(*) AS count`. Used by `repo.count()`. */
  count(): SelectBuilder<TColumns, TRelations, { count: number }> {
    this._state.op = 'count'

    return this as never
  }

  /** Include soft-deleted rows in the result. */
  withTrashed(): this {
    this._state.withTrashed = true

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
   * Hint for `repo.stream()` — overrides the default chunk size when this
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

  for (const m of sql.matchAll(PLACEHOLDER_RE)) {
    const n = Number(m[1])

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
