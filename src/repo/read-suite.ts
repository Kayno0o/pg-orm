import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { AnyColumns, AnyRelations, AnyVirtuals, InferSelect, InferVirtuals, WithVirtuals } from '../types/index'
import type { RepositoryCtx } from './context'
import { SelectBuilder } from '../builder/query'
import { NotFoundError } from '../errors/index'
import { hasHooks, runHooksAsync } from '../hooks/index'
import { mapChunk } from '../mapper/index'
import { applyVirtuals } from './virtuals'

/**
 * Read operations — `find*`, `count`, `exists`, `paginate*`, and the `select()`
 * builder accessor. Created lazily on first access via `repo.read`.
 *
 * Builder accessors for write operations live on `repo.write` (`insert()`,
 * `update()`, `delete()`, `merge()`, `upsert()`). `select()` stays here because
 * it's the read-shaped query builder.
 */
export class ReadSuite<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  constructor(private _ctx: RepositoryCtx) {}

  /**
   * Find all rows matching the query. Soft-deleted rows are excluded by default.
   * @example
   * ```ts
   * const users = await repo.read.findMany(q => q.where(e => e.eq('role', 'admin')).orderBy('name'))
   * ```
   */
  async findMany(): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async findMany<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<(TResult & InferVirtuals<TVirtuals>)[]>
  async findMany(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<any[]> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._ctx.table.name)
    const finalBuilder = cb ? cb(builder) : builder

    this._ctx.traits.applyPreSelect(finalBuilder)

    const state = finalBuilder.getState()

    if (this._ctx.defaultLimit != null && state.limit == null) {
      state.limit = this._ctx.defaultLimit
    }

    const { sql, params } = finalBuilder.toSQL()
    const rows = await this._ctx.query(sql, params)

    // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
    const hasOnlyComputed = state.columns?.length === 0 && state.computedColumns.length > 0
    const mapper = hasOnlyComputed ? null : this._ctx.getMapper(finalBuilder)
    let mapped = mapper ? mapChunk(mapper, rows) : rows

    if (hasHooks(this._ctx.table, 'afterSelect')) {
      mapped = await runHooksAsync(this._ctx.table, 'afterSelect', mapped)
    }

    mapped = applyVirtuals(this._ctx.table, mapped)

    if (state.includes.length > 0) {
      mapped = await this._ctx.relationLoader.loadIncludes(mapped, state.includes)
    }

    return mapped
  }

  /** Find the first row matching the query, or `null` if none found. */
  async findOne(): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async findOne<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<TResult & InferVirtuals<TVirtuals> | null>
  async findOne(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<any | null> {
    const wrappedCb = cb
      ? (q: SelectBuilder<TColumns, TRelations>) => cb(q).limit(1)
      : (q: SelectBuilder<TColumns, TRelations>) => q.limit(1) as SelectBuilder<TColumns, TRelations, any>
    const rows = await this.findMany(wrappedCb)

    return rows[0] ?? null
  }

  /**
   * Like `findOne()`, but throws `NotFoundError` if no row matches.
   * Useful for distinguishing "not found" from query errors.
   */
  async findOneOrThrow(): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findOneOrThrow<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<TResult & InferVirtuals<TVirtuals>>
  async findOneOrThrow(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<unknown> {
    const row = cb ? await this.findOne(cb) : await this.findOne()

    if (row === null) {
      throw new NotFoundError(this._ctx.table.name)
    }

    return row
  }

  /** Find a row by primary key. Supports composite PKs when `id` is an object. */
  async findById(id: unknown): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    const pk = this._ctx.getPrimaryKey()

    if (pk.includes(',')) {
      const pkCols = pk.split(',')

      return this.findOne(q => q.where((e) => {
        const conditions = pkCols.map(col =>
          e.eq(col.trim(), (id as Record<string, unknown>)[col.trim()]),
        )

        return e.and(...conditions)
      }))
    }

    return this.findOne(q => q.where(e => e.eq(pk, id)))
  }

  /** Count rows matching `where` (excludes soft-deleted by default). */
  async count(where?: (e: ExprBuilder<TColumns>) => ExprTape): Promise<number> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._ctx.table.name).count()

    if (where) {
      builder.where(where)
    }

    this._ctx.traits.applyPreSelect(builder)

    const { sql, params } = builder.toSQL()
    const rows = await this._ctx.query(sql, params)

    return Number(rows[0]?.count ?? 0)
  }

  /** Check if any row matches `where` (excludes soft-deleted by default). */
  async exists(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<boolean> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._ctx.table.name)
      .where(where)
      .limit(1)

    this._ctx.traits.applyPreSelect(builder)
    builder.asExists()

    const { sql, params } = builder.toSQL()
    const rows = await this._ctx.query(sql, params)

    return rows.length > 0
  }

  /** Offset-based pagination with total count. Returns `{ data, total, page, perPage, totalPages }`. */
  async paginate(opts: {
    page: number
    perPage: number
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], total: number, page: number, perPage: number, totalPages: number }> {
    const { page, perPage, where: whereFn } = opts

    const [data, total] = await Promise.all([
      this.findMany((q) => {
        let b = q.limit(perPage).offset((page - 1) * perPage)

        if (whereFn)
          b = b.where(whereFn)

        return b
      }),
      this.count(whereFn),
    ])

    return {
      data,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    }
  }

  /** Cursor-based pagination — efficient for large datasets. */
  async paginateCursor<K extends keyof TColumns & string>(opts: {
    take: number
    column?: K
    cursor?: InferSelect<TColumns>[K] | null
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], nextCursor: InferSelect<TColumns>[K] | null }> {
    const { take, cursor, direction = 'forward', where: whereFn } = opts
    const col = (opts.column ?? this._ctx.getPrimaryKey()) as keyof TColumns & string
    const isForward = direction === 'forward'

    const data = await this.findMany((q) => {
      let b = q.limit(take + 1).orderBy(col, isForward ? 'asc' : 'desc')

      if (whereFn)
        b = b.where(whereFn)

      if (cursor != null) {
        b = b.andWhere(e =>
          isForward ? e.gt(col, cursor) : e.lt(col, cursor),
        )
      }

      return b
    })

    const hasMore = data.length > take

    if (hasMore)
      data.pop()

    if (!isForward)
      data.reverse()

    const lastRow = data.at(-1) as Record<string, unknown> | undefined
    const nextCursor = hasMore && lastRow ? lastRow[col] : null

    return { data, nextCursor }
  }

  /** Builder accessor for advanced SELECT usage. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._ctx.table.name)

    this._ctx.traits.applyPreSelect(builder)

    return builder
  }
}
