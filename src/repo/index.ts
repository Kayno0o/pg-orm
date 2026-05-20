import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { Database, Executable, SavepointClient, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, InferInsert, InferPrimaryKey, InferSelect, InferUpdate, InferVirtuals, WithVirtuals } from '../types/index'
import { DeleteBuilder, InsertBuilder, MergeBuilder, rawSql, SelectBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH, DEFAULT_PRIMARY_KEY, DEFAULT_STREAM_CHUNK_SIZE } from '../constants'
import { NotFoundError, StaleRecordError } from '../errors/index'
import { hasHooks, runHooksAsync } from '../hooks/index'
import { getOrCompileMapper, mapChunk } from '../mapper/index'
import { quote } from '../sql/utils'
import { HookOrchestrator } from './hooks'
import { RelationLoader } from './relation-loader'
import { applySoftDeleteFilter, getOptimisticLockColumn, getSoftDeleteColumn, requireSoftDeleteColumn } from './traits'
import { applyVirtuals, clearVirtualEntriesCache } from './virtuals'

export { clearVirtualEntriesCache }

/**
 * Type-safe repository for a table definition.
 * Provides CRUD operations, relation loading, streaming, pagination, and query building.
 *
 * Create via `db.repo(table)` — the repository inherits the database connection
 * and table registry for relation resolution.
 *
 * @example
 * ```ts
 * const UserRepo = db.repo(users)
 * const alice = await UserRepo.insertOne({ name: 'Alice', email: 'a@test.com' })
 * const all = await UserRepo.findMany(q => q.where(e => e.eq('status', 'active')))
 * ```
 */
export class Repository<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  private static _streamWarned = false

  private _table: AnyTableDef
  private _executor: Executable
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>
  private _maxIncludeDepth: number
  private _batchChunkSize: number
  private _defaultLimit?: number
  private _relationLoader: RelationLoader
  private _hooks: HookOrchestrator

  constructor(
    table: AnyTableDef,
    executor: Executable,
    tableRegistry?: ReadonlyMap<string, AnyTableDef>,
    maxIncludeDepth?: number,
    defaultLimit?: number,
    batchChunkSize?: number,
  ) {
    this._table = table
    this._executor = executor
    this._tableRegistry = tableRegistry
    this._maxIncludeDepth = maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    this._batchChunkSize = batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE
    this._defaultLimit = defaultLimit
    this._relationLoader = new RelationLoader(table, executor, this._maxIncludeDepth, this._batchChunkSize, tableRegistry)
    this._hooks = new HookOrchestrator(table)
  }

  using(tx: TransactionClient | SavepointClient | Database): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>(this._table, tx as Executable, this._tableRegistry, this._maxIncludeDepth, this._defaultLimit, this._batchChunkSize)
  }

  // --- Primary key helper ---

  private _getPrimaryKey(): string {
    return this._table.primaryKey ?? DEFAULT_PRIMARY_KEY
  }

  // --- Query methods (callback-style) ---

  /**
   * Find all rows matching the query. Soft-deleted rows are excluded by default.
   * @example
   * ```ts
   * const users = await repo.findMany(q => q.where(e => e.eq('role', 'admin')).orderBy('name'))
   * ```
   */
  async findMany(): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async findMany<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<(TResult & InferVirtuals<TVirtuals>)[]>
  async findMany(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<any[]> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
    const finalBuilder = cb ? cb(builder) : builder

    // Auto-filter soft-deleted rows
    applySoftDeleteFilter(this._table, finalBuilder)

    // Apply default limit if no explicit limit was set
    const state = finalBuilder.getState()

    if (this._defaultLimit != null && state.limit == null) {
      state.limit = this._defaultLimit
    }

    const { sql, params } = finalBuilder.toSQL()
    const rows = await this._query(sql, params)

    // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
    const hasOnlyComputed = state.columns?.length === 0 && state.computedColumns.length > 0
    const mapper = hasOnlyComputed ? null : this._getMapper(finalBuilder)
    let mapped = mapper ? mapChunk(mapper, rows) : rows

    if (hasHooks(this._table, 'afterSelect')) {
      mapped = await runHooksAsync(this._table, 'afterSelect', mapped)
    }

    // Apply virtuals
    mapped = applyVirtuals(this._table, mapped)

    // Handle .include() — batched relation loading (no N+1)
    if (state.includes.length > 0) {
      mapped = await this._relationLoader.loadIncludes(mapped, state.includes)
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
      throw new NotFoundError(this._table.name)
    }

    return row
  }

  /** Insert a single row and return the primary key of the inserted record. */
  async insertOne(values: InferInsert<TColumns>): Promise<InferPrimaryKey<TColumns>> {
    const v = await this._hooks.runBefore('beforeInsert', values)

    const pk = this._getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .returning(pk)
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterInsert', rows)

    return rows[0]![pk] as InferPrimaryKey<TColumns>
  }

  /** Insert multiple rows in a single query and return the primary keys of the inserted records. */
  async insertMany(values: InferInsert<TColumns>[]): Promise<InferPrimaryKey<TColumns>[]> {
    if (values.length === 0)
      return []

    const v = await this._hooks.runBeforeMany('beforeInsert', values)

    const pk = this._getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._table.name)
      .many(v)
      .returning(pk)
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterInsert', rows)

    return rows.map(r => r[pk]) as InferPrimaryKey<TColumns>[]
  }

  /** Update all rows matching `where` and return the updated records. */
  async updateMany(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const s = await this._hooks.runBefore('beforeUpdate', set)
    const lockCol = getOptimisticLockColumn(this._table)

    const b = new UpdateBuilder<TColumns>(this._table.name)
      .set(s)
      .where(where)
      .returning()

    // Auto-increment version column for optimistic locking (after validation)
    if (lockCol !== null) {
      b.getState().setValues![lockCol] = rawSql(`${quote(lockCol)} + 1`)
    }

    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterUpdate', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Delete all rows matching `where`. Uses soft-delete if the trait is applied. Returns deleted records. */
  async deleteMany(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    // Soft-delete: convert DELETE to UPDATE but fire delete hooks
    const sdCol = getSoftDeleteColumn(this._table)

    if (sdCol) {
      await this._hooks.runBefore('beforeDelete', undefined)

      const b = new UpdateBuilder<TColumns>(this._table.name)
        .set({ [sdCol]: new Date() } as InferUpdate<TColumns>)
        .where(where)
        .returning()
      const { sql, params } = b.toSQL()
      const rows = await this._query(sql, params)

      await this._hooks.runAfter('afterDelete', rows)

      return rows as WithVirtuals<TColumns, TVirtuals>[]
    }

    await this._hooks.runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterDelete', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  // --- Convenience methods ---

  /** Find a row by primary key. Supports composite PKs when `id` is an object. */
  async findById(id: unknown): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    const pk = this._getPrimaryKey()

    // Composite primary key: pk is comma-separated, id should be an object
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
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name).count()

    if (where) {
      builder.where(where)
    }

    applySoftDeleteFilter(this._table, builder)

    const { sql, params } = builder.toSQL()
    const rows = await this._query(sql, params)

    return Number(rows[0]?.count ?? 0)
  }

  /** Check if any row matches `where` (excludes soft-deleted by default). */
  async exists(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<boolean> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
      .where(where)
      .limit(1)

    applySoftDeleteFilter(this._table, builder)

    const existsState = builder.getState()

    existsState.columns = []
    existsState.computedColumns = [{ expr: '1', alias: '_exists' }]
    const { sql, params } = builder.toSQL()
    const rows = await this._query(sql, params)

    return rows.length > 0
  }

  /** Update the first matching row and return it, or `null` if none matched. */
  async updateOne(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.updateMany(set, where)

    return rows[0] ?? null
  }

  // Optimistic lock update — adds WHERE version = $current, throws StaleRecordError if 0 rows affected
  async updateWithLock(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
    currentVersion: number,
  ): Promise<WithVirtuals<TColumns, TVirtuals>> {
    const lockCol = getOptimisticLockColumn(this._table)

    if (!lockCol) {
      throw new Error('updateWithLock requires optimisticLock trait on table')
    }

    const rows = await this.updateMany(set, e =>
      e.and(where(e), e.eq(lockCol, currentVersion)))

    if (rows.length === 0) {
      throw new StaleRecordError(this._table.name, currentVersion)
    }

    return rows[0] as WithVirtuals<TColumns, TVirtuals>
  }

  /** Delete the first matching row. Returns the deleted record or `null`. */
  async deleteOne(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.deleteMany(where)

    return rows[0] ?? null
  }

  /** Bulk upsert: insert rows, update on conflict. Returns all affected records. */
  async upsertMany(
    values: InferInsert<TColumns>[],
    conflictTarget: (keyof TColumns & string)[],
    updateColumns?: (keyof TColumns & string)[],
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    const v = await this._hooks.runBeforeMany('beforeUpsert', values)

    const ib = new InsertBuilder<TColumns>(this._table.name).many(v)
    const conflict = ib.onConflict(conflictTarget)
    const resolved = updateColumns?.length ? conflict.doUpdate(...updateColumns) : conflict.doUpdate()
    const final = resolved.returning()
    const { sql, params } = final.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterInsert', rows)

    // Apply virtuals
    applyVirtuals(this._table, rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Insert a row or return the existing one if conflict target matches. */
  async findOrCreate(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
  ): Promise<WithVirtuals<TColumns, TVirtuals>> {
    const v = await this._hooks.runBefore('beforeUpsert', values)

    // Use ON CONFLICT DO UPDATE with a no-op SET so RETURNING always returns the row
    const pk = this._getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdate(pk as keyof TColumns & string)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterInsert', rows)

    return rows[0] as WithVirtuals<TColumns, TVirtuals>
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

  // Cursor-based pagination — efficient for large datasets
  async paginateCursor<K extends keyof TColumns & string>(opts: {
    take: number
    column?: K
    cursor?: InferSelect<TColumns>[K] | null
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], nextCursor: InferSelect<TColumns>[K] | null }> {
    const { take, cursor, direction = 'forward', where: whereFn } = opts
    const col = (opts.column ?? this._getPrimaryKey()) as keyof TColumns & string
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

    // Reverse backward results to maintain consistent ordering
    if (!isForward)
      data.reverse()

    const lastRow = data.at(-1) as Record<string, unknown> | undefined
    const nextCursor = hasMore && lastRow ? lastRow[col] : null

    return { data, nextCursor }
  }

  // Restore soft-deleted records: sets the soft-delete column to NULL
  async restore(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const sdCol = requireSoftDeleteColumn(this._table, 'restore()')

    const s = await this._hooks.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>)

    const b = new UpdateBuilder<TColumns>(this._table.name)
      .set(s)
      .where((e: ExprBuilder<TColumns>) =>
        e.and(where(e), e.isNotNull(sdCol)))
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterUpdate', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  // Force-delete: bypass soft-delete and run a real DELETE
  async forceDelete(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    await this._hooks.runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._hooks.runAfter('afterDelete', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  /**
   * Streaming via async iterator — JIT mapper applied per chunk, not per row.
   *
   * **WARNING:** Uses LIMIT/OFFSET chunking. If rows are inserted or deleted during
   * iteration, rows may be skipped or duplicated. For correctness on mutable data,
   * use `paginateCursor()` or run inside a REPEATABLE READ transaction.
   *
   * Pass `{ unsafe: true }` to acknowledge this behavior and suppress the warning.
   */
  async* stream(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
    opts: { chunkSize?: number, unsafe?: boolean } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    if (!opts.unsafe && !Repository._streamWarned) {
      Repository._streamWarned = true
      console.warn(
        '[pg-orm] stream() uses LIMIT/OFFSET chunking — rows may be skipped or duplicated if data changes during iteration. '
        + 'Use paginateCursor() or a REPEATABLE READ transaction for correctness. '
        + 'Pass { unsafe: true } to suppress this warning.',
      )
    }

    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
    const finalBuilder = cb ? cb(builder) : builder
    const chunkSize = opts.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
    let offset = 0
    const mapper = this._getMapper(finalBuilder)

    applySoftDeleteFilter(this._table, finalBuilder)

    while (true) {
      const chunkBuilder = finalBuilder.branch()

      const chunkState = chunkBuilder.getState()

      chunkState.limit = chunkSize
      chunkState.offset = offset
      const { sql, params } = chunkBuilder.toSQL()
      const rows = await this._query(sql, params)

      if (rows.length === 0)
        break

      let mapped = mapChunk(mapper, rows) as WithVirtuals<TColumns, TVirtuals>[]

      if (hasHooks(this._table, 'afterSelect')) {
        mapped = await runHooksAsync(this._table, 'afterSelect', mapped)
      }

      mapped = applyVirtuals(this._table, mapped)

      for (const row of mapped) {
        yield row
      }

      if (rows.length < chunkSize)
        break

      offset += chunkSize
    }
  }

  /**
   * Cursor-based streaming via async iterator — uses keyset pagination internally.
   * Unlike `stream()`, this is safe for mutable data (no skipped/duplicated rows).
   *
   * Requires an ordered column (defaults to the primary key).
   *
   * @example
   * ```ts
   * for await (const row of repo.streamCursor({ chunkSize: 100 })) {
   *   console.log(row)
   * }
   * ```
   */
  async* streamCursor(
    opts: {
      chunkSize?: number
      column?: keyof TColumns & string
      direction?: 'forward' | 'backward'
      where?: (e: ExprBuilder<TColumns>) => ExprTape
    } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    const chunkSize = opts.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
    const col = opts.column ?? (this._getPrimaryKey() as keyof TColumns & string)
    const direction = opts.direction ?? 'forward'
    let cursor: unknown

    while (true) {
      const result = await this.paginateCursor({
        take: chunkSize,
        column: col,
        cursor: cursor as never,
        direction,
        where: opts.where,
      })

      for (const row of result.data) {
        yield row
      }

      if (result.nextCursor == null)
        break

      cursor = result.nextCursor
    }
  }

  // Builder accessors for advanced usage
  select(): SelectBuilder<TColumns, TRelations> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)

    // Auto-apply soft-delete filter (use .withTrashed() to bypass)
    applySoftDeleteFilter(this._table, builder)

    return builder
  }

  insert(): InsertBuilder<TColumns> {
    return new InsertBuilder<TColumns>(this._table.name)
  }

  update(): UpdateBuilder<TColumns> {
    return new UpdateBuilder<TColumns>(this._table.name)
  }

  delete(): DeleteBuilder<TColumns> {
    return new DeleteBuilder<TColumns>(this._table.name)
  }

  merge(): MergeBuilder<TColumns> {
    return new MergeBuilder<TColumns>(this._table.name)
  }

  upsert(): UpsertBuilder<TColumns> {
    return new UpsertBuilder<TColumns>(this._table.name)
  }

  // --- Private helpers ---

  private async _query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this._executor.query(sql, params)
  }

  // Get or compile mapper from a select builder's state
  private _getMapper(builder: SelectBuilder<TColumns, TRelations, any>) {
    const s = builder.getState()

    return getOrCompileMapper(
      this._table.name,
      this._table.columns,
      s.columns ?? undefined,
      s.omitColumns.length ? s.omitColumns : undefined,
    )
  }
}
