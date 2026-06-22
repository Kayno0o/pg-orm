import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { SelectBuilder } from '../builder/query'
import type { IncludeEntry } from '../builder/state'
import type { RowMapper } from '../mapper/index'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, InferSelect, InferVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { RelationProcessor, RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { SelectBuilder as SelectBuilderCtor } from '../builder/query'
import { DEFAULT_STREAM_CHUNK_SIZE } from '../constants'
import { NotFoundError } from '../errors/index'
import { mapChunk } from '../mapper/index'
import { createMapperFactory } from './_mapper'
import { buildTableRuntime } from './table-runtime'

type SelectCb<TC extends AnyColumns, TR extends AnyRelations, TResult = any> = (q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, TResult>
type Where<TC extends AnyColumns> = (e: ExprBuilder<TC>) => ExprTape

export interface ReadPipelineContext {
  executor: Executable
  runtime: TableRuntime
  relations: RelationResolver
  mapper: MapperFactory
  tableRegistry?: ReadonlyMap<string, AnyTableDef>
}

export interface SelectOptions {
  defaultLimit?: number
}

export interface PaginateOptions<TColumns extends AnyColumns> {
  page: number
  perPage: number
  where?: Where<TColumns>
}

export interface PaginateResult<TColumns extends AnyColumns, TVirtuals extends AnyVirtuals> {
  data: WithVirtuals<TColumns, TVirtuals>[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

export interface PaginateCursorOptions<TColumns extends AnyColumns, K extends keyof TColumns & string> {
  take: number
  column?: K
  cursor?: InferSelect<TColumns>[K] | null
  direction?: 'forward' | 'backward'
  where?: Where<TColumns>
}

export interface PaginateCursorResult<TColumns extends AnyColumns, TVirtuals extends AnyVirtuals, K extends keyof TColumns & string> {
  data: WithVirtuals<TColumns, TVirtuals>[]
  nextCursor: InferSelect<TColumns>[K] | null
}

let _streamWarned = false

/**
 * Deep module owning the full read-result lifecycle for a single table:
 * builder construction, soft-delete pre-filter, execution, JIT mapper coercion,
 * afterSelect hooks, virtual installation, and eager relation loading with
 * recursive post-processing of child rows.
 *
 * Mirrors the `WritePipeline` pattern so `ReadSuite` and `StreamSuite` can be
 * thin façades that only adapt the public type signatures.
 */
export class ReadPipeline<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> implements RelationProcessor {
  private _executor: Executable
  private _runtime: TableRuntime
  private _relations: RelationResolver
  private _mapper: MapperFactory
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>

  constructor(ctx: ReadPipelineContext) {
    this._executor = ctx.executor
    this._runtime = ctx.runtime
    this._relations = ctx.relations
    this._mapper = ctx.mapper
    this._tableRegistry = ctx.tableRegistry
  }

  /** Builder accessor for advanced SELECT. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    const builder = new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table.name)

    this._runtime.behavior.prepareSelect(builder)

    return builder
  }

  async findMany(cb?: SelectCb<TColumns, TRelations>, opts?: SelectOptions): Promise<any[]> {
    const builder = new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table.name)
    const finalBuilder = cb ? cb(builder) : builder

    this._runtime.behavior.prepareSelect(finalBuilder)

    const state = finalBuilder.getState()

    if (opts?.defaultLimit != null && state.limit == null) {
      state.limit = opts.defaultLimit
    }

    const { sql, params } = finalBuilder.toSQL()
    const rows = await this._executor.query(sql, params)

    // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
    const hasOnlyComputed = state.columns?.length === 0 && state.computedColumns.length > 0

    return this.processRows(rows, this._runtime.table.name, 'select', {
      mapper: this._mapper(finalBuilder),
      includes: state.includes,
      skipMapper: hasOnlyComputed,
    })
  }

  async findOne(): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async findOne<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals> | null>
  async findOne(cb?: SelectCb<TColumns, TRelations>): Promise<any | null> {
    const wrapped = cb
      ? (q: SelectBuilder<TColumns, TRelations>) => cb(q).limit(1)
      : (q: SelectBuilder<TColumns, TRelations>) => q.limit(1) as SelectBuilder<TColumns, TRelations, any>
    const rows = await this.findMany(wrapped)

    return rows[0] ?? null
  }

  async findOneOrThrow(): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findOneOrThrow<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals>>
  async findOneOrThrow(cb?: SelectCb<TColumns, TRelations>): Promise<unknown> {
    const row = cb ? await this.findOne(cb) : await this.findOne()

    if (row === null)
      throw new NotFoundError(this._runtime.table.name)

    return row
  }

  async findById(id: unknown): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    const pk = this._runtime.primaryKey

    if (pk.includes(',')) {
      const pkCols = pk.split(',')

      return this.findOne(q =>
        q.where((e) => {
          const conditions = pkCols.map(col =>
            e.eq(col.trim(), (id as Record<string, unknown>)[col.trim()]),
          )

          return e.and(...conditions)
        }))
    }

    return this.findOne(q => q.where(e => e.eq(pk, id)))
  }

  async count(where?: Where<TColumns>): Promise<number> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table.name).count()

    if (where)
      builder.where(where)

    this._runtime.behavior.prepareSelect(builder)

    const { sql, params } = builder.toSQL()
    const rows = await this._executor.query(sql, params)

    return Number(rows[0]?.count ?? 0)
  }

  async exists(where: Where<TColumns>): Promise<boolean> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table.name).asExists().limit(1)

    if (where)
      builder.where(where)

    this._runtime.behavior.prepareSelect(builder)

    const { sql, params } = builder.toSQL()
    const rows = await this._executor.query(sql, params)

    return rows.length > 0
  }

  async paginate(opts: PaginateOptions<TColumns>): Promise<PaginateResult<TColumns, TVirtuals>> {
    const { page, perPage, where } = opts

    const [data, total] = await Promise.all([
      this.findMany((q) => {
        let b = q.limit(perPage).offset((page - 1) * perPage)

        if (where)
          b = b.where(where)

        return b
      }),
      this.count(where),
    ])

    return { data, total, page, perPage, totalPages: Math.ceil(total / perPage) }
  }

  async paginateCursor<K extends keyof TColumns & string>(
    opts: PaginateCursorOptions<TColumns, K>,
  ): Promise<PaginateCursorResult<TColumns, TVirtuals, K>> {
    const { take, cursor, direction = 'forward', where } = opts
    const col = (opts.column ?? this._runtime.primaryKey) as K
    const isForward = direction === 'forward'

    const data = await this.findMany((q) => {
      let b = q.limit(take + 1).orderBy(col, isForward ? 'asc' : 'desc')

      if (where)
        b = b.where(where)

      if (cursor != null) {
        b = b.andWhere(e => isForward ? e.gt(col, cursor) : e.lt(col, cursor))
      }

      return b
    })

    const hasMore = data.length > take

    if (hasMore)
      data.pop()

    if (!isForward)
      data.reverse()

    const lastRow = data.at(-1) as Record<string, unknown> | undefined
    const nextCursor = (hasMore && lastRow ? lastRow[col] : null) as InferSelect<TColumns>[K] | null

    return { data, nextCursor }
  }

  stream(
    cb?: SelectCb<TColumns, TRelations>,
    opts: { chunkSize?: number, unsafe?: boolean } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._stream(cb, opts)
  }

  private async* _stream(
    cb: SelectCb<TColumns, TRelations> | undefined,
    opts: { chunkSize?: number, unsafe?: boolean },
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    if (!opts.unsafe && !_streamWarned) {
      _streamWarned = true
      const msg = '[pg-orm] stream() uses LIMIT/OFFSET chunking — rows may be skipped or duplicated if data changes during iteration. '
        + 'Use streamCursor() or a REPEATABLE READ transaction for correctness. '
        + 'Pass { unsafe: true } to suppress this warning.'
      const exec = this._executor as { _onCallbackError?: (event: { kind: 'streamWarning', error: unknown }) => void }

      if (exec._onCallbackError)
        exec._onCallbackError({ kind: 'streamWarning', error: new Error(msg) })
      else
        console.warn(msg)
    }

    const builder = new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table.name)
    const finalBuilder = cb ? cb(builder) : builder
    const chunkSize = opts.chunkSize ?? finalBuilder.getState().streamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
    const mapperFn = this._mapper(finalBuilder)

    this._runtime.behavior.prepareSelect(finalBuilder)

    let offset = 0

    while (true) {
      const chunkBuilder = finalBuilder.branch()
      const chunkState = chunkBuilder.getState()

      chunkState.limit = chunkSize
      chunkState.offset = offset

      const { sql, params } = chunkBuilder.toSQL()
      const rows = await this._executor.query(sql, params)

      if (rows.length === 0)
        break

      // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
      const hasOnlyComputed = chunkState.columns?.length === 0 && chunkState.computedColumns.length > 0

      const mapped = await this.processRows(rows, this._runtime.table.name, 'select', {
        mapper: mapperFn,
        skipMapper: hasOnlyComputed,
      })

      for (const row of mapped)
        yield row as WithVirtuals<TColumns, TVirtuals>

      if (rows.length < chunkSize)
        break

      offset += chunkSize
    }
  }

  streamCursor(opts: {
    chunkSize?: number
    column?: keyof TColumns & string
    direction?: 'forward' | 'backward'
    where?: Where<TColumns>
  } = {}): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._streamCursor(opts)
  }

  private async* _streamCursor(opts: {
    chunkSize?: number
    column?: keyof TColumns & string
    direction?: 'forward' | 'backward'
    where?: Where<TColumns>
  }): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    const chunkSize = opts.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
    const col = opts.column ?? (this._runtime.primaryKey as keyof TColumns & string)
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

      for (const row of result.data)
        yield row as WithVirtuals<TColumns, TVirtuals>

      if (result.nextCursor == null)
        break

      cursor = result.nextCursor
    }
  }

  /**
   * Post-process a raw row set: coerce column types via the JIT mapper, run
   * afterSelect hooks, install virtuals, and load includes. Called for top-level
   * query results and recursively for eager-loaded child rows.
   *
   * `tableName` lets the pipeline process rows from included child tables by
   * resolving the correct table definition from the registry.
   */
  async processRows(
    rows: Record<string, unknown>[],
    tableName: string,
    source: 'select',
    opts?: {
      skipMapper?: boolean
      mapper?: RowMapper<Record<string, unknown>>
      includes?: IncludeEntry[]
    },
  ): Promise<Record<string, unknown>[]> {
    const runtime = this._runtimeFor(tableName)

    let mapped = rows

    if (!opts?.skipMapper) {
      const mapper = opts?.mapper ?? this._mapperForTable(tableName)

      mapped = mapChunk(mapper, rows)
    }

    await runtime.runAfter('afterSelect', mapped)

    mapped = runtime.applyVirtuals(mapped)

    if (source === 'select' && opts?.includes && opts.includes.length > 0) {
      mapped = await this._relations.loadIncludes(mapped, opts.includes, this)
    }

    return mapped
  }

  private _runtimeFor(tableName: string): TableRuntime {
    if (tableName === this._runtime.table.name)
      return this._runtime

    const table = this._tableRegistry?.get(tableName)

    if (!table)
      return this._runtime

    return buildTableRuntime(table)
  }

  private _mapperForTable(tableName: string): RowMapper<Record<string, unknown>> {
    if (tableName === this._runtime.table.name)
      return this._mapper(new SelectBuilderCtor<any, any>(tableName))

    const table = this._tableRegistry?.get(tableName)

    if (!table)
      return (row: Record<string, unknown>) => row

    return createMapperFactory(table)(new SelectBuilderCtor<any, any>(tableName))
  }
}
