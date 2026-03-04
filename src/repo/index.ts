import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { IncludeCallback, IncludeEntry } from '../builder/query'
import type { Database, Executable, SavepointClient, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelationDef, AnyRelations, AnyTableDef, AnyVirtuals, HookEvent, InferInsert, InferSelect, InferUpdate } from '../types/index'
import { DeleteBuilder, getBuilderState, InsertBuilder, MergeBuilder, SelectBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { AfterHookError, NotFoundError, OrmError, StaleRecordError } from '../errors/index'
import { hasHooks, runHooksAsync } from '../hooks/index'
import { getOrCompileMapper, mapChunk } from '../mapper/index'
import { quote } from '../sql/utils'

// Cache virtual entries per table to avoid Object.entries on every call
let _virtualEntriesCache = new WeakMap<AnyTableDef, [string, { compute: (r: unknown) => unknown }][]>()

export function clearVirtualEntriesCache(): void {
  _virtualEntriesCache = new WeakMap()
}

function getVirtualEntries(table: AnyTableDef): [string, { compute: (r: unknown) => unknown }][] {
  let entries = _virtualEntriesCache.get(table)

  if (!entries) {
    const virtuals = table.virtuals

    entries = virtuals ? Object.entries(virtuals) as [string, { compute: (r: unknown) => unknown }][] : []
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
  static MAX_INCLUDE_DEPTH = 5
  private static _streamWarned = false

  private _table: AnyTableDef
  private _executor: Executable
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>
  private _maxIncludeDepth: number
  private _defaultLimit?: number

  constructor(
    table: AnyTableDef,
    executor: Executable,
    tableRegistry?: ReadonlyMap<string, AnyTableDef>,
    maxIncludeDepth?: number,
    defaultLimit?: number,
  ) {
    this._table = table
    this._executor = executor
    this._tableRegistry = tableRegistry
    this._maxIncludeDepth = maxIncludeDepth ?? Repository.MAX_INCLUDE_DEPTH
    this._defaultLimit = defaultLimit
  }

  using(tx: TransactionClient | SavepointClient | Database): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>(this._table, tx as Executable, this._tableRegistry, this._maxIncludeDepth, this._defaultLimit)
  }

  // --- Hook helpers ---

  private async _runBefore<T>(event: HookEvent, value: T): Promise<T> {
    if (hasHooks(this._table, event)) {
      return await runHooksAsync(this._table, event, value)
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

  private _applySoftDeleteFilter(builder: SelectBuilder<TColumns, TRelations, any>): void {
    const col = this._getSoftDeleteColumn()

    if (col && !getBuilderState(builder).withTrashed) {
      builder.andWhere(e => e.isNull(col as any))
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
  async findMany(): Promise<InferSelect<TColumns>[]>
  async findMany<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<TResult[]>
  async findMany(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<any[]> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
    const finalBuilder = cb ? cb(builder) : builder

    // Auto-filter soft-deleted rows
    this._applySoftDeleteFilter(finalBuilder)

    // Apply default limit if no explicit limit was set
    const state = getBuilderState(finalBuilder)

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
      mapped = await this._loadIncludes(mapped, state.includes)
    }

    return mapped
  }

  /** Find the first row matching the query, or `null` if none found. */
  async findOne(): Promise<InferSelect<TColumns> | null>
  async findOne<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<TResult | null>
  async findOne(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<any | null> {
    const wrappedCb = cb
      ? (q: SelectBuilder<TColumns, TRelations>) => cb(q).limit(1) as SelectBuilder<TColumns, TRelations, any>
      : (q: SelectBuilder<TColumns, TRelations>) => q.limit(1) as SelectBuilder<TColumns, TRelations, any>
    const rows = await this.findMany(wrappedCb)

    return rows[0] ?? null
  }

  /**
   * Like `findOne()`, but throws `NotFoundError` if no row matches.
   * Useful for distinguishing "not found" from query errors.
   */
  async findOneOrThrow(): Promise<InferSelect<TColumns>>
  async findOneOrThrow<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<TResult>
  async findOneOrThrow(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<unknown> {
    const row = cb ? await this.findOne(cb) : await this.findOne()

    if (row === null) {
      throw new NotFoundError(this._table.name)
    }

    return row
  }

  /** Insert a single row and return the inserted record with all columns. */
  async insertOne(values: InferInsert<TColumns>): Promise<InferSelect<TColumns>>
  async insertOne(
    values: InferInsert<TColumns>,
    opts: { include: (keyof TRelations & string)[] },
  ): Promise<InferSelect<TColumns>>
  async insertOne(
    values: InferInsert<TColumns>,
    opts?: { include?: (keyof TRelations & string)[] },
  ): Promise<InferSelect<TColumns>> {
    const v = await this._runBefore('beforeInsert', values)

    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    // Apply virtuals
    this._applyVirtuals(rows)

    // Load requested relations on the returned row
    if (opts?.include?.length) {
      const includes: IncludeEntry[] = opts.include.map(r => ({ relation: r, strategy: 'batch' }))

      await this._loadIncludes(rows, includes)
    }

    return rows[0] as InferSelect<TColumns>
  }

  /** Insert multiple rows in a single query and return all inserted records. */
  async insertMany(values: InferInsert<TColumns>[]): Promise<InferSelect<TColumns>[]> {
    if (values.length === 0)
      return []

    let v = values

    if (hasHooks(this._table, 'beforeInsert')) {
      v = await Promise.all(v.map(row => runHooksAsync(this._table, 'beforeInsert', row)))
    }

    const b = new InsertBuilder<TColumns>(this._table.name)
      .many(v)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    // Apply virtuals
    this._applyVirtuals(rows)

    return rows as InferSelect<TColumns>[]
  }

  /** Update all rows matching `where` and return the updated records. */
  async updateMany(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    const s = await this._runBefore('beforeUpdate', set)
    const lockCol = this._getOptimisticLockColumn()

    const b = new UpdateBuilder<TColumns>(this._table.name)
      .set(s)
      .where(where)
      .returning() as UpdateBuilder<TColumns, InferSelect<TColumns>>

    // Auto-increment version column for optimistic locking (after validation)
    if (lockCol) {
      getBuilderState(b).setValues![lockCol] = { __raw: `${quote(lockCol)} + 1` }
    }

    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterUpdate', rows)

    return rows as InferSelect<TColumns>[]
  }

  /** Delete all rows matching `where`. Uses soft-delete if the trait is applied. Returns deleted records. */
  async deleteMany(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    // Soft-delete: convert DELETE to UPDATE but fire delete hooks
    const sdCol = this._getSoftDeleteColumn()

    if (sdCol) {
      await this._runBefore('beforeDelete', undefined)

      const b = new UpdateBuilder<TColumns>(this._table.name)
        .set({ [sdCol]: new Date() } as InferUpdate<TColumns>)
        .where(where)
        .returning() as UpdateBuilder<TColumns, InferSelect<TColumns>>
      const { sql, params } = b.toSQL()
      const rows = await this._query(sql, params)

      await this._runAfter('afterDelete', rows)

      return rows as InferSelect<TColumns>[]
    }

    await this._runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning() as DeleteBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterDelete', rows)

    return rows as InferSelect<TColumns>[]
  }

  // --- Convenience methods ---

  /** Find a row by primary key. Supports composite PKs when `id` is an object. */
  async findById(id: unknown): Promise<InferSelect<TColumns> | null> {
    const pk = this._table.primaryKey ?? 'id'

    // Composite primary key: pk is comma-separated, id should be an object
    if (pk.includes(',')) {
      const pkCols = pk.split(',')

      return this.findOne(q => q.where((e) => {
        const conditions = pkCols.map(col =>
          e.eq(col.trim() as any, (id as Record<string, unknown>)[col.trim()!] as any),
        )

        return e.and(...conditions)
      }) as any)
    }

    return this.findOne(q => q.where(e => e.eq(pk as any, id as any)) as any)
  }

  /** Count rows matching `where` (excludes soft-deleted by default). */
  async count(where?: (e: ExprBuilder<TColumns>) => ExprTape): Promise<number> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name).count()

    if (where) {
      builder.where(where as any)
    }

    this._applySoftDeleteFilter(builder as any)

    const { sql, params } = builder.toSQL()
    const rows = await this._query(sql, params)

    return Number((rows[0] as any)?.count ?? 0)
  }

  /** Check if any row matches `where` (excludes soft-deleted by default). */
  async exists(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<boolean> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
      .where(where as any)
      .limit(1)

    this._applySoftDeleteFilter(builder as any)

    const existsState = getBuilderState(builder)

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
  ): Promise<InferSelect<TColumns> | null> {
    const rows = await this.updateMany(set, where)

    return rows[0] ?? null
  }

  // Optimistic lock update — adds WHERE version = $current, throws StaleRecordError if 0 rows affected
  async updateWithLock(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
    currentVersion: number,
  ): Promise<InferSelect<TColumns>> {
    const lockCol = this._getOptimisticLockColumn()

    if (!lockCol) {
      throw new Error('updateWithLock requires optimisticLock trait on table')
    }

    const rows = await this.updateMany(set, e =>
      e.and(where(e), e.eq(lockCol as any, currentVersion as any)))

    if (rows.length === 0) {
      throw new StaleRecordError(this._table.name, currentVersion)
    }

    return rows[0] as InferSelect<TColumns>
  }

  /** Delete the first matching row. Returns the deleted record or `null`. */
  async deleteOne(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns> | null> {
    const rows = await this.deleteMany(where)

    return rows[0] ?? null
  }

  /** Bulk upsert: insert rows, update on conflict. Returns all affected records. */
  async upsertMany(
    values: InferInsert<TColumns>[],
    conflictTarget: (keyof TColumns & string)[],
    updateColumns?: (keyof TColumns & string)[],
  ): Promise<InferSelect<TColumns>[]> {
    if (values.length === 0)
      return []

    let v = values

    if (hasHooks(this._table, 'beforeUpsert')) {
      v = await Promise.all(v.map(row => runHooksAsync(this._table, 'beforeUpsert', row)))
    }

    const ib = new InsertBuilder<TColumns>(this._table.name).many(v)
    const conflict = ib.onConflict(conflictTarget)
    const resolved = updateColumns?.length ? conflict.doUpdate(...updateColumns) : conflict.doUpdate()
    const final = resolved.returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = final.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    // Apply virtuals
    this._applyVirtuals(rows as any)

    return rows as InferSelect<TColumns>[]
  }

  /** Insert a row or return the existing one if conflict target matches. */
  async findOrCreate(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
  ): Promise<InferSelect<TColumns>> {
    const v = await this._runBefore('beforeUpsert', values)

    // Use ON CONFLICT DO UPDATE with a no-op SET so RETURNING always returns the row
    const pk = this._table.primaryKey ?? 'id'
    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdate(pk as keyof TColumns & string)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    return rows[0] as InferSelect<TColumns>
  }

  /** Offset-based pagination with total count. Returns `{ data, total, page, perPage, totalPages }`. */
  async paginate(opts: {
    page: number
    perPage: number
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: InferSelect<TColumns>[], total: number, page: number, perPage: number, totalPages: number }> {
    const { page, perPage, where: whereFn } = opts

    const [data, total] = await Promise.all([
      this.findMany((q) => {
        let b = q.limit(perPage).offset((page - 1) * perPage)

        if (whereFn)
          b = b.where(whereFn as any) as any

        return b as any
      }) as Promise<InferSelect<TColumns>[]>,
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
  async paginateCursor(opts: {
    take: number
    cursor?: { column: keyof TColumns & string, value: unknown }
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: InferSelect<TColumns>[], nextCursor: unknown | null }> {
    const { take, cursor, direction = 'forward', where: whereFn } = opts
    const col = cursor?.column ?? (this._table.primaryKey ?? 'id') as keyof TColumns & string
    const isForward = direction === 'forward'

    const data = await this.findMany((q) => {
      let b = q.limit(take + 1).orderBy(col, isForward ? 'asc' : 'desc')

      if (whereFn)
        b = b.where(whereFn as any) as any

      if (cursor?.value != null) {
        b = b.andWhere(e =>
          isForward ? e.gt(col as any, cursor.value as any) : e.lt(col as any, cursor.value as any),
        ) as any
      }

      return b as any
    }) as InferSelect<TColumns>[]

    const hasMore = data.length > take

    if (hasMore)
      data.pop()

    // Reverse backward results to maintain consistent ordering
    if (!isForward)
      data.reverse()

    const lastRow = data[data.length - 1] as Record<string, unknown> | undefined
    const nextCursor = hasMore && lastRow ? lastRow[col as string] : null

    return { data, nextCursor }
  }

  // Restore soft-deleted records: sets the soft-delete column to NULL
  async restore(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    const sdCol = this._getSoftDeleteColumn()

    if (!sdCol) {
      throw new OrmError('restore() requires softDelete trait on table')
    }

    const s = await this._runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>)

    const b = new UpdateBuilder<TColumns>(this._table.name)
      .set(s)
      .where((e: ExprBuilder<TColumns>) =>
        e.and(where(e), e.isNotNull(sdCol as any)))
      .returning() as UpdateBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterUpdate', rows)

    return rows as InferSelect<TColumns>[]
  }

  // Force-delete: bypass soft-delete and run a real DELETE
  async forceDelete(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    await this._runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning() as DeleteBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterDelete', rows)

    return rows as InferSelect<TColumns>[]
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
  ): AsyncGenerator<InferSelect<TColumns>, void, undefined> {
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
    const chunkSize = opts.chunkSize ?? 500
    let offset = 0
    const mapper = this._getMapper(finalBuilder)

    this._applySoftDeleteFilter(finalBuilder)

    while (true) {
      const chunkBuilder = finalBuilder.clone()

      const chunkState = getBuilderState(chunkBuilder)

      chunkState.limit = chunkSize
      chunkState.offset = offset
      const { sql, params } = chunkBuilder.toSQL()
      const rows = await this._query(sql, params)

      if (rows.length === 0)
        break

      let mapped = mapChunk(mapper, rows) as InferSelect<TColumns>[]

      if (hasHooks(this._table, 'afterSelect')) {
        mapped = await runHooksAsync(this._table, 'afterSelect', mapped) as InferSelect<TColumns>[]
      }

      mapped = this._applyVirtuals(mapped) as InferSelect<TColumns>[]

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
  ): AsyncGenerator<InferSelect<TColumns>, void, undefined> {
    const chunkSize = opts.chunkSize ?? 500
    const col = opts.column ?? (this._table.primaryKey ?? 'id') as keyof TColumns & string
    const direction = opts.direction ?? 'forward'
    let cursor: unknown | null = null

    while (true) {
      const result = await this.paginateCursor({
        take: chunkSize,
        cursor: cursor != null ? { column: col, value: cursor } : undefined,
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
    return await this._executor.query(sql, params)
  }

  // Get or compile mapper from a select builder's state
  private _getMapper(builder: SelectBuilder<TColumns, TRelations, any>) {
    const s = getBuilderState(builder)

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

  // Resolve a target table by name from the registry
  private _resolveTable(name: string): AnyTableDef | undefined {
    return this._tableRegistry?.get(name)
  }

  // Find primary key column name for a table — uses cached value
  private _findPrimaryKey(table: AnyTableDef): string {
    return table.primaryKey ?? 'id'
  }

  // Batched query helper — SELECT * FROM "table" WHERE "col" IN ($1, $2, ...)
  // Chunks IDs to avoid exceeding PG parameter limits (65535 params)
  private static readonly BATCH_CHUNK_SIZE = 5000

  private async _batchQuery(tableName: string, column: string, ids: unknown[]): Promise<Record<string, unknown>[]> {
    if (ids.length <= Repository.BATCH_CHUNK_SIZE) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')

      return this._query(
        `SELECT * FROM ${quote(tableName)} WHERE ${quote(column)} IN (${placeholders})`,
        ids,
      )
    }

    // Chunk large ID sets
    const results: Record<string, unknown>[] = []

    for (let i = 0; i < ids.length; i += Repository.BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + Repository.BATCH_CHUNK_SIZE)
      const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ')
      const rows = await this._query(
        `SELECT * FROM ${quote(tableName)} WHERE ${quote(column)} IN (${placeholders})`,
        chunk,
      )

      results.push(...rows)
    }

    return results
  }

  // Batched through-query helper with chunking
  private async _batchThroughQuery(rel: AnyRelationDef, targetPk: string, ids: unknown[]): Promise<Record<string, unknown>[]> {
    const buildSql = (chunk: unknown[]) => {
      const placeholders = chunk.map((_, i) => `$${i + 1}`).join(', ')

      return `SELECT t.*, j.${quote(rel.throughFrom!)} AS "__pgorm_pivot_fk__"
       FROM ${quote(rel.throughTable!)} j
       JOIN ${quote(rel.targetTable)} t ON t.${quote(targetPk)} = j.${quote(rel.throughTo!)}
       WHERE j.${quote(rel.throughFrom!)} IN (${placeholders})`
    }

    if (ids.length <= Repository.BATCH_CHUNK_SIZE) {
      return this._query(buildSql(ids), ids)
    }

    const results: Record<string, unknown>[] = []

    for (let i = 0; i < ids.length; i += Repository.BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + Repository.BATCH_CHUNK_SIZE)

      results.push(...await this._query(buildSql(chunk), chunk))
    }

    return results
  }

  // --- Relation loading strategies ---

  // Build a filtered query for a relation using callback, or fall back to batch query
  private async _filteredBatchQuery(
    tableName: string,
    column: string,
    ids: unknown[],
    callback?: IncludeCallback,
  ): Promise<Record<string, unknown>[]> {
    if (!callback) {
      return this._batchQuery(tableName, column, ids)
    }

    // Apply callback to a select builder, then inject the IN filter
    const builder = new SelectBuilder<any, any>(tableName)
    const filtered = callback(builder)

    filtered.andWhere(e => e.in(column as any, ids as any))
    const { sql, params } = filtered.toSQL()

    return this._query(sql, params)
  }

  private async _loadBelongsTo(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    relationName: string,
    callback?: IncludeCallback,
  ): Promise<void> {
    const fk = rel.foreignKey
    const parentIds = [...new Set(parentRows.map(r => r[fk]).filter(v => v != null))]

    if (parentIds.length === 0) {
      for (const row of parentRows) row[relationName] = null

      return
    }

    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    const childRows = await this._filteredBatchQuery(rel.targetTable, targetPk, parentIds, callback)

    const indexed = new Map<unknown, Record<string, unknown>>()

    for (const child of childRows) indexed.set(child[targetPk], child)

    for (const parent of parentRows) {
      parent[relationName] = indexed.get(parent[fk]) ?? null
    }
  }

  private async _loadHasOneOrMany(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    relationName: string,
    callback?: IncludeCallback,
  ): Promise<void> {
    const sourcePk = this._findPrimaryKey(this._table)
    const targetFk = rel.foreignKey
    const parentIds = [...new Set(parentRows.map(r => r[sourcePk]).filter(v => v != null))]
    const isMany = rel.type === 'hasMany'

    if (parentIds.length === 0) {
      for (const row of parentRows) {
        row[relationName] = isMany ? [] : null
      }

      return
    }

    const childRows = await this._filteredBatchQuery(rel.targetTable, targetFk, parentIds, callback)

    if (isMany) {
      const grouped = new Map<unknown, Record<string, unknown>[]>()

      for (const child of childRows) {
        const fk = child[targetFk]

        if (!grouped.has(fk))
          grouped.set(fk, [])

        grouped.get(fk)!.push(child)
      }

      for (const parent of parentRows) {
        parent[relationName] = grouped.get(parent[sourcePk]) ?? []
      }
    }
    else {
      const indexed = new Map<unknown, Record<string, unknown>>()

      for (const child of childRows) indexed.set(child[targetFk], child)

      for (const parent of parentRows) {
        parent[relationName] = indexed.get(parent[sourcePk]) ?? null
      }
    }
  }

  private async _loadHasManyThrough(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    relationName: string,
  ): Promise<void> {
    const sourcePk = this._findPrimaryKey(this._table)
    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    const parentIds = [...new Set(parentRows.map(r => r[sourcePk]).filter(v => v != null))]

    if (parentIds.length === 0) {
      for (const row of parentRows) row[relationName] = []

      return
    }

    const rows = await this._batchThroughQuery(rel, targetPk, parentIds)

    const grouped = new Map<unknown, Record<string, unknown>[]>()

    for (const row of rows) {
      const fk = row.__pgorm_pivot_fk__

      if (!grouped.has(fk))
        grouped.set(fk, [])

      grouped.get(fk)!.push(row)
      delete row.__pgorm_pivot_fk__
    }

    for (const parent of parentRows) {
      parent[relationName] = grouped.get(parent[sourcePk]) ?? []
    }
  }

  // Split dotted include paths into top-level and nested entries
  private _splitIncludes(includes: IncludeEntry[]): { topLevel: IncludeEntry[], nested: Map<string, IncludeEntry[]> } {
    const topLevel: IncludeEntry[] = []
    const nested = new Map<string, IncludeEntry[]>()

    for (const inc of includes) {
      const dotIdx = inc.relation.indexOf('.')

      if (dotIdx === -1) {
        topLevel.push(inc)
      }
      else {
        const parent = inc.relation.slice(0, dotIdx)
        const child = inc.relation.slice(dotIdx + 1)

        if (!nested.has(parent))
          nested.set(parent, [])

        nested.get(parent)!.push({ relation: child, strategy: 'batch', callback: inc.callback })

        if (!topLevel.some(t => t.relation === parent)) {
          topLevel.push({ relation: parent, strategy: 'batch' })
        }
      }
    }

    return { topLevel, nested }
  }

  // Recursively load nested includes on child rows after parent relation is loaded
  private async _loadNestedIncludes(
    parentRows: Record<string, unknown>[],
    ctx: { relationName: string, rel: AnyRelationDef, includes: IncludeEntry[], seen: Set<string>, depth: number },
  ): Promise<void> {
    const targetTableDef = this._resolveTable(ctx.rel.targetTable)

    if (!targetTableDef)
      return

    const childRows: Record<string, unknown>[] = []

    for (const parent of parentRows) {
      const val = parent[ctx.relationName]

      if (Array.isArray(val))
        childRows.push(...val)
      else if (val != null)
        childRows.push(val as Record<string, unknown>)
    }

    if (childRows.length > 0) {
      const childRepo = new Repository(targetTableDef, this._executor, this._tableRegistry, this._maxIncludeDepth)
      const childVisited = new Set(ctx.seen)

      childVisited.add(`${this._table.name}.${ctx.relationName}`)
      await childRepo._loadIncludes(childRows, ctx.includes, ctx.depth + 1, childVisited)
    }
  }

  // Batched relation loading — single query per relation, all relations in parallel.
  // Supports nested includes via dotted paths: 'posts.comments'
  private async _loadIncludes(
    parentRows: Record<string, unknown>[],
    includes: IncludeEntry[],
    depth = 0,
    visited?: Set<string>,
  ): Promise<any[]> {
    if (depth > this._maxIncludeDepth) {
      throw new OrmError(
        `Maximum include depth of ${this._maxIncludeDepth} exceeded. Check for circular includes or increase maxIncludeDepth.`,
      )
    }

    const relations = this._table.relations

    if (!relations)
      return parentRows

    const seen = visited ?? new Set<string>()

    for (const inc of includes) {
      const key = `${this._table.name}.${inc.relation.split('.')[0]!}`

      if (seen.has(key)) {
        throw new OrmError(
          `Circular include detected: "${key}" was already loaded in this include chain. `
          + `Break the cycle by removing the redundant .include().`,
        )
      }
    }

    const { topLevel, nested } = this._splitIncludes(includes)
    const tasks: Promise<void>[] = []

    for (const inc of topLevel) {
      const rel = relations[inc.relation] as AnyRelationDef | undefined

      if (!rel)
        continue

      tasks.push((async () => {
        if (rel.type === 'belongsTo')
          await this._loadBelongsTo(parentRows, rel, inc.relation, inc.callback)
        else if (rel.type === 'hasOne' || rel.type === 'hasMany')
          await this._loadHasOneOrMany(parentRows, rel, inc.relation, inc.callback)
        else if (rel.type === 'hasManyThrough' && rel.throughTable)
          await this._loadHasManyThrough(parentRows, rel, inc.relation)

        const nestedIncludes = nested.get(inc.relation)

        if (nestedIncludes?.length)
          await this._loadNestedIncludes(parentRows, { relationName: inc.relation, rel, includes: nestedIncludes, seen, depth })
      })())
    }

    await Promise.all(tasks)

    return parentRows
  }
}
