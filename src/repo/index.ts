import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { Database, Executable, SavepointClient, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, HookEvent, InferInsert, InferPrimaryKey, InferSelect, InferUpdate, InferVirtuals, WithVirtuals } from '../types/index'
import { DeleteBuilder, InsertBuilder, MergeBuilder, rawSql, SelectBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH, DEFAULT_PRIMARY_KEY, DEFAULT_STREAM_CHUNK_SIZE } from '../constants'
import { AfterHookError, NotFoundError, OrmError, StaleRecordError } from '../errors/index'
import { hasHooks, runHooksAsync } from '../hooks/index'
import { getOrCompileMapper, mapChunk } from '../mapper/index'
import { quote } from '../sql/utils'
import { RelationLoader } from './relation-loader'

// Cache virtual entries per table to avoid Object.entries on every call
let _virtualEntriesCache = new WeakMap<AnyTableDef, [string, { compute: (r: unknown) => unknown }][]>()

export function clearVirtualEntriesCache(): void {
  _virtualEntriesCache = new WeakMap()
}

function getVirtualEntries(table: AnyTableDef): [string, { compute: (r: unknown) => unknown }][] {
  let entries = _virtualEntriesCache.get(table)

  if (!entries) {
    const virtuals = table.virtuals

    entries = virtuals ? Object.entries(virtuals) : []
    _virtualEntriesCache.set(table, entries)
  }

  return entries
}

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
  }

  using(tx: TransactionClient | SavepointClient | Database): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>(this._table, tx as Executable, this._tableRegistry, this._maxIncludeDepth, this._defaultLimit, this._batchChunkSize)
  }

  // --- Hook helpers ---

  private async _runBefore<T>(event: HookEvent, value: T): Promise<T> {
    if (hasHooks(this._table, event)) {
      return runHooksAsync(this._table, event, value)
    }

    return value
  }

  private async _runAfter(event: HookEvent, rows?: unknown[]): Promise<void> {
    if (hasHooks(this._table, event)) {
      try {
        await runHooksAsync(this._table, event, rows)
      }
      catch (err) {
        throw new AfterHookError(this._table.name, event, err)
      }
    }
  }

  // --- Optimistic lock helpers ---

  private _getOptimisticLockColumn(): string | null {
    const ol = this._table.meta?.optimisticLock as { column: string } | undefined

    return ol?.column ?? null
  }

  // --- Soft-delete helpers ---

  private _getSoftDeleteColumn(): string | null {
    const sd = this._table.meta?.softDelete as { column: string } | undefined

    return sd?.column ?? null
  }

  private _requireSoftDelete(operation: string): string {
    const col = this._getSoftDeleteColumn()

    if (col === null) {
      throw new OrmError(`${operation} requires softDelete trait on table`)
    }

    return col
  }

  // --- Primary key helper ---

  private _getPrimaryKey(): string {
    return this._table.primaryKey ?? DEFAULT_PRIMARY_KEY
  }

  private _applySoftDeleteFilter(builder: SelectBuilder<TColumns, TRelations, any>): void {
    const col = this._getSoftDeleteColumn()

    if (col && !builder.getState().withTrashed) {
      builder.andWhere(e => e.isNull(col))
    }
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
    this._applySoftDeleteFilter(finalBuilder)

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
    mapped = this._applyVirtuals(mapped)

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
    const v = await this._runBefore('beforeInsert', values)

    const pk = this._getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .returning(pk)
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    return rows[0]![pk] as InferPrimaryKey<TColumns>
  }

  /** Insert multiple rows in a single query and return the primary keys of the inserted records. */
  async insertMany(values: InferInsert<TColumns>[]): Promise<InferPrimaryKey<TColumns>[]> {
    if (values.length === 0)
      return []

    let v = values

    if (hasHooks(this._table, 'beforeInsert')) {
      v = await Promise.all(v.map(async row => runHooksAsync(this._table, 'beforeInsert', row)))
    }

    const pk = this._getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._table.name)
      .many(v)
      .returning(pk)
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    return rows.map(r => r[pk]) as InferPrimaryKey<TColumns>[]
  }

  /** Update all rows matching `where` and return the updated records. */
  async updateMany(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const s = await this._runBefore('beforeUpdate', set)
    const lockCol = this._getOptimisticLockColumn()

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

    await this._runAfter('afterUpdate', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Delete all rows matching `where`. Uses soft-delete if the trait is applied. Returns deleted records. */
  async deleteMany(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    // Soft-delete: convert DELETE to UPDATE but fire delete hooks
    const sdCol = this._getSoftDeleteColumn()

    if (sdCol) {
      await this._runBefore('beforeDelete', undefined)

      const b = new UpdateBuilder<TColumns>(this._table.name)
        .set({ [sdCol]: new Date() } as InferUpdate<TColumns>)
        .where(where)
        .returning()
      const { sql, params } = b.toSQL()
      const rows = await this._query(sql, params)

      await this._runAfter('afterDelete', rows)

      return rows as WithVirtuals<TColumns, TVirtuals>[]
    }

    await this._runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterDelete', rows)

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

    this._applySoftDeleteFilter(builder)

    const { sql, params } = builder.toSQL()
    const rows = await this._query(sql, params)

    return Number(rows[0]?.count ?? 0)
  }

  /** Check if any row matches `where` (excludes soft-deleted by default). */
  async exists(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<boolean> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
      .where(where)
      .limit(1)

    this._applySoftDeleteFilter(builder)

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
    const lockCol = this._getOptimisticLockColumn()

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

    let v = values

    if (hasHooks(this._table, 'beforeUpsert')) {
      v = await Promise.all(v.map(async row => runHooksAsync(this._table, 'beforeUpsert', row)))
    }

    const ib = new InsertBuilder<TColumns>(this._table.name).many(v)
    const conflict = ib.onConflict(conflictTarget)
    const resolved = updateColumns?.length ? conflict.doUpdate(...updateColumns) : conflict.doUpdate()
    const final = resolved.returning()
    const { sql, params } = final.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    // Apply virtuals
    this._applyVirtuals(rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Insert a row or return the existing one if conflict target matches. */
  async findOrCreate(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
  ): Promise<WithVirtuals<TColumns, TVirtuals>> {
    const v = await this._runBefore('beforeUpsert', values)

    // Use ON CONFLICT DO UPDATE with a no-op SET so RETURNING always returns the row
    const pk = this._getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdate(pk as keyof TColumns & string)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

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
    const sdCol = this._requireSoftDelete('restore()')

    const s = await this._runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>)

    const b = new UpdateBuilder<TColumns>(this._table.name)
      .set(s)
      .where((e: ExprBuilder<TColumns>) =>
        e.and(where(e), e.isNotNull(sdCol)))
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterUpdate', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  // Force-delete: bypass soft-delete and run a real DELETE
  async forceDelete(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    await this._runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterDelete', rows)

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

    this._applySoftDeleteFilter(finalBuilder)

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

      mapped = this._applyVirtuals(mapped)

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
    this._applySoftDeleteFilter(builder)

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

  // Apply virtual fields to mapped rows — lazy evaluation via getters
  private _applyVirtuals<T extends Record<string, unknown>>(rows: T[]): T[] {
    const entries = getVirtualEntries(this._table)

    if (entries.length === 0)
      return rows

    const tableName = this._table.name

    for (const row of rows) {
      for (const [key, virt] of entries) {
        Object.defineProperty(row, key, {
          get() {
            let value: unknown

            try {
              value = virt.compute(row)
            }
            catch (err) {
              throw new OrmError(
                `Virtual field "${key}" on table "${tableName}" threw during computation: ${err instanceof Error ? err.message : String(err)}`,
                err,
              )
            }

            // Replace getter with computed value on first access
            Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true })

            return value
          },
          enumerable: true,
          configurable: true,
        })
      }
    }

    return rows
  }
}
