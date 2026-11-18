import type { VectorMetric } from '../builder/_tape'
import type { TypedExpr, VectorType, VectorValue } from '../builder/expr'
import type { OptionalWhere, OptionalWhereObject, SelectBuilder, WhereInput } from '../builder/query'
import type { BuilderState, IncludeEntry } from '../builder/state'
import type { Dialect } from '../dialect'
import type { RowMapper } from '../mapper/index'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, HookContext, ScopeOptions, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { PageLimits, PaginateCursorOptions, PaginateCursorResult, SelectCb } from './pagination'
import type { RelationProcessor, RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { OP_SCALAR } from '../builder/_tape'
import { createExprBuilder } from '../builder/expr'
import { SelectBuilder as SelectBuilderCtor } from '../builder/query'
import { selectedColumns } from '../builder/state'
import { vectorSearchSettings } from '../builder/vector-search'
import { DEFAULT_STREAM_CHUNK_SIZE } from '../constants'
import { dialectOf, requirePostgres } from '../dialect'
import { messageValue, NotFoundError, ValidationError } from '../errors/index'
import { mapChunk } from '../mapper/index'
import { columnBaseType, tableMeta } from '../schema/inspect'
import { createMapperFactory } from './_mapper'
import { checkPageSize, paginateCursor } from './pagination'
import { resolveRelationAggregates, resolveRelationFilters } from './relation-filter'
import { liftedScopes } from './table-behavior'
import { buildTableRuntime } from './table-runtime'

export type { CursorOf, PageLimits, PaginateCursorOptions, PaginateCursorResult } from './pagination'

// The column a page carries its total in.
const PAGE_TOTAL = '__pgorm_total'

interface ChildTable {
  table: AnyTableDef
  version: number
  runtime: TableRuntime
  mappers: MapperFactory
}

type Where<TC extends AnyColumns> = WhereInput<TC>
/** What a find takes: a select callback, or a WHERE object (falsy for no filter). */
type FindArg<TC extends AnyColumns, TR extends AnyRelations> = SelectCb<TC, TR> | OptionalWhereObject<TC>

function asSelectCb<TC extends AnyColumns, TR extends AnyRelations>(arg: FindArg<TC, TR> | undefined): SelectCb<TC, TR> {
  return typeof arg === 'function' ? arg : q => q.where(arg) as SelectBuilder<TC, TR, any>
}

export interface CopyToOptions<TColumns extends AnyColumns> extends ScopeOptions {
  where?: OptionalWhere<TColumns>
  /** The columns to export, in this order; every column by default. */
  pick?: (keyof TColumns & string)[]
  /** Write the column names as the first line, true by default. */
  header?: boolean
}

export interface ReadPipelineContext {
  executor: Executable
  runtime: TableRuntime
  relations: RelationResolver
  mapper: MapperFactory
  hooks: HookContext
  tableRegistry?: ReadonlyMap<string, AnyTableDef>
}

export interface SelectOptions extends ScopeOptions {
  defaultLimit?: number
}

/** What `nearest()` takes: how many rows, an optional filter and distance cap, the metric, and the vector column when the table has no `embedding()` trait naming it. */
export interface NearestOptions<TColumns extends AnyColumns> extends ScopeOptions {
  k: number
  where?: OptionalWhere<TColumns>
  /** Leave out rows farther than this, in the metric's own unit. */
  maxDistance?: number
  /** `cosine` by default, `hamming` on a `bit` column. */
  metric?: VectorMetric
  column?: keyof TColumns & string
}

const e = createExprBuilder<AnyColumns>()

const NEAREST_DISTANCES: Record<VectorMetric, (column: string, vec: VectorValue, type: string) => TypedExpr<number>> = {
  cosine: (column, vec, type) => e.vectorCosineDistance(column, vec, type as VectorType),
  l2: (column, vec, type) => e.vectorL2Distance(column, vec, type as VectorType),
  inner: (column, vec, type) => e.vectorInnerProduct(column, vec, type as VectorType),
  l1: (column, vec, type) => e.vectorL1Distance(column, vec, type as VectorType),
  hamming: (column, vec) => e.bitHammingDistance(column, vec as string),
  jaccard: (column, vec) => e.bitJaccardDistance(column, vec as string),
}

export interface PaginateOptions<TColumns extends AnyColumns> extends ScopeOptions {
  page: number
  perPage: number
  where?: OptionalWhere<TColumns>
  /** `false` skips counting the matching rows: the page then says whether another follows, through `hasNext`, but has no `total` or `totalPages`. */
  withTotal?: boolean
}

/** A page read with `withTotal: false`. */
export interface PaginatePage<TColumns extends AnyColumns, TVirtuals extends AnyVirtuals> {
  data: WithVirtuals<TColumns, TVirtuals>[]
  page: number
  perPage: number
  hasNext: boolean
}

export interface PaginateResult<TColumns extends AnyColumns, TVirtuals extends AnyVirtuals> extends PaginatePage<TColumns, TVirtuals> {
  total: number
  totalPages: number
}

export interface StreamCursorOptions<TColumns extends AnyColumns> extends ScopeOptions {
  chunkSize?: number
  column?: keyof TColumns & string
  direction?: 'forward' | 'backward'
  where?: OptionalWhere<TColumns>
}

const STREAM_OFFSET_NOTICE = 'stream.offset'

export interface StreamOffsetOptions extends ScopeOptions {
  chunkSize?: number
  /** `false` silences the warning that `stream.offset()` may skip or repeat rows and costs quadratic time; it is given once per `Database` otherwise. */
  warn?: boolean
}

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
  private _dialect: Dialect
  private _runtime: TableRuntime
  private _relations: RelationResolver
  private _mapper: MapperFactory
  private _hooks: HookContext
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>
  private _children = new Map<string, ChildTable>()

  constructor(ctx: ReadPipelineContext) {
    this._executor = ctx.executor
    this._dialect = dialectOf(ctx.executor)
    this._runtime = ctx.runtime
    this._relations = ctx.relations
    this._mapper = ctx.mapper
    this._hooks = ctx.hooks
    this._tableRegistry = ctx.tableRegistry
  }

  /** Builder accessor for advanced SELECT. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    const builder = new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table)

    this._prepare(builder)

    return builder
  }

  async findMany(arg?: FindArg<TColumns, TRelations>, opts?: SelectOptions): Promise<any[]> {
    const { rows } = await this._select(asSelectCb(arg)(new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table)).withoutScope(...liftedScopes(opts)), opts)

    return rows
  }

  // `countQuery` rides along as a scalar subquery, which the database runs once, its result read off the first row and dropped before mapping: a page and its total in one round trip, the page still stopping at its LIMIT. The total is unknown when the page is empty.
  private async _select(finalBuilder: SelectBuilder<TColumns, TRelations, any>, opts?: SelectOptions, countQuery?: SelectBuilder<TColumns, any, any>): Promise<{ rows: any[], total?: number }> {
    this._prepare(finalBuilder)
    this._resolveAggregates(finalBuilder)

    const state = finalBuilder.getState()

    if (opts?.defaultLimit != null && state.limit == null) {
      state.limit = opts.defaultLimit
    }

    if (countQuery) {
      this._prepare(countQuery)
      state.computedColumns.push({ expr: '', alias: PAGE_TOTAL, tape: [{ op: OP_SCALAR, subquery: countQuery }] })
    }

    const { sql, params } = finalBuilder.toSQL(this._dialect)

    if (countQuery)
      state.computedColumns.pop()

    const rows = await this._query(state, sql, params)
    let total: number | undefined

    if (countQuery && rows.length > 0) {
      total = Number(rows[0]![PAGE_TOTAL])

      for (const row of rows) delete row[PAGE_TOTAL]
    }

    // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
    const hasOnlyComputed = selectedColumns(state)?.length === 0 && state.computedColumns.length > 0

    const processed = await this.processRows(rows, this._runtime.table.name, {
      mapper: this._mapper(finalBuilder),
      includes: state.includes,
      skipMapper: hasOnlyComputed,
    })

    return { rows: processed, total }
  }

  // A statement with pgvector search settings sets them in the transaction it runs in, opened for it unless the executor is one already.
  private async _query(state: BuilderState, sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (!state.vectorSearch)
      return this._executor.query(sql, params)

    requirePostgres(this._dialect, 'vectorSearch()')

    const settings = vectorSearchSettings(state.vectorSearch)
    const run = async (exec: Executable): Promise<Record<string, unknown>[]> => {
      if (settings.length)
        await exec.query(`SELECT ${settings.map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`).join(', ')}`, settings.flat())

      return exec.query(sql, params)
    }

    return this._executor.atomic ? this._executor.atomic(run) : run(this._executor)
  }

  async findOne(arg?: FindArg<TColumns, TRelations>, opts?: ScopeOptions): Promise<any | null> {
    const cb = asSelectCb(arg)
    const rows = await this.findMany(q => cb(q).limit(1), opts)

    return rows[0] ?? null
  }

  async findOneOrThrow(arg?: FindArg<TColumns, TRelations>, opts?: ScopeOptions): Promise<unknown> {
    const row = await this.findOne(arg, opts)

    if (row === null)
      throw new NotFoundError(this._runtime.table.name)

    return row
  }

  /** What the by-id finds take after the key: a select callback, or the scopes to lift. */
  async findById(id: unknown, shape?: SelectCb<TColumns, TRelations> | ScopeOptions): Promise<any | null> {
    const where = this._runtime.pkWhere(id) as Where<TColumns>
    const cb = typeof shape === 'function' ? shape : undefined
    const opts = typeof shape === 'function' ? undefined : shape

    return this.findOne(q => (cb ? cb(q) : q).andWhere(where) as SelectBuilder<TColumns, TRelations, any>, opts)
  }

  async findByIdOrThrow(id: unknown, shape?: SelectCb<TColumns, TRelations> | ScopeOptions): Promise<any> {
    const row = await this.findById(id, shape)

    if (row === null)
      throw new NotFoundError(this._runtime.table.name)

    return row
  }

  async existsById(id: unknown, opts?: ScopeOptions): Promise<boolean> {
    return this.exists(this._runtime.pkWhere(id) as Where<TColumns>, opts)
  }

  async count(where?: OptionalWhere<TColumns>, opts?: ScopeOptions): Promise<number> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).count().where(where)

    builder.withoutScope(...liftedScopes(opts))

    return this._runCount(builder)
  }

  private async _runCount(builder: SelectBuilder<TColumns, any, any>): Promise<number> {
    this._prepare(builder)

    const { sql, params } = builder.toSQL(this._dialect)
    const rows = await this._executor.query(sql, params)

    return Number(rows[0]?.count ?? 0)
  }

  async exists(where?: OptionalWhere<TColumns>, opts?: ScopeOptions): Promise<boolean> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).asExists().limit(1).where(where)

    builder.withoutScope(...liftedScopes(opts))

    this._prepare(builder)

    const { sql, params } = builder.toSQL(this._dialect)
    const rows = await this._executor.query(sql, params)

    return rows.length > 0
  }

  // The k rows closest to `vec` by the column's distance, each with its `distance`, through findMany so scopes and virtuals apply.
  async nearest(vec: VectorValue, opts: NearestOptions<TColumns>, limits?: PageLimits): Promise<any[]> {
    const { table } = this._runtime
    const column = opts.column ?? tableMeta(table).embedding?.column

    checkPageSize('nearest', 'k', opts.k, limits)

    if (!column)
      throw new ValidationError('nearest(): name the vector column in `column`, or give the table the embedding() trait.', 'nearest')

    const col = (table.columns as AnyColumns)[column]

    if (!col)
      throw new ValidationError(`nearest(): "${table.name}" has no column "${column}".`, 'nearest', { field: column })

    const { base } = columnBaseType(col)
    const metric = opts.metric ?? (base === 'bit' ? 'hamming' : 'cosine')

    if (!Object.hasOwn(NEAREST_DISTANCES, metric))
      throw new ValidationError(`nearest(): unknown metric "${String(metric)}": use ${Object.keys(NEAREST_DISTANCES).join(', ')}.`, 'nearest', { value: metric })

    const distance = NEAREST_DISTANCES[metric](column, vec, base)
    const { maxDistance } = opts

    return this.findMany(q => q
      .where(opts.where)
      .andWhere(maxDistance != null && (w => w.lte(distance, maxDistance)))
      .withoutScope(...liftedScopes(opts))
      .computed(() => distance, 'distance')
      .orderBy(() => distance)
      .limit(opts.k))
  }

  async paginate(opts: PaginateOptions<TColumns> & { withTotal: false }, cb?: SelectCb<TColumns, TRelations>, limits?: PageLimits): Promise<PaginatePage<TColumns, TVirtuals>>
  async paginate(opts: PaginateOptions<TColumns>, cb?: SelectCb<TColumns, TRelations>, limits?: PageLimits): Promise<PaginateResult<TColumns, TVirtuals>>
  async paginate(opts: PaginateOptions<TColumns>, cb?: SelectCb<TColumns, TRelations>, limits?: PageLimits): Promise<PaginateResult<TColumns, TVirtuals> | PaginatePage<TColumns, TVirtuals>> {
    const { page, perPage, where, withTotal = true } = opts

    if (!Number.isInteger(page) || page < 1)
      throw new ValidationError(`paginate() requires page >= 1, got ${messageValue(page)}`, 'paginate', { value: page })

    checkPageSize('paginate', 'perPage', perPage, limits)

    // Past this the offset is no longer an exact integer, which Postgres refuses.
    if (page * perPage > Number.MAX_SAFE_INTEGER)
      throw new ValidationError(`paginate(): page ${messageValue(page)} of ${perPage} rows reaches past the largest offset`, 'paginate', { value: page })

    const base = new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table)
    const rows = (cb ? cb(base) : base).andWhere(where).withoutScope(...liftedScopes(opts))

    this._orderByKeyIfUnordered(rows)

    // Without a count, one row past the page tells whether another follows.
    if (!withTotal) {
      rows.limit(perPage + 1).offset((page - 1) * perPage)

      const { rows: read } = await this._select(rows as SelectBuilder<TColumns, TRelations, any>)

      return { data: read.slice(0, perPage), page, perPage, hasNext: read.length > perPage }
    }

    // Branch before paging so `total` counts the same rows the page is drawn from, including any filter the callback added.
    const countQuery = rows.branch().count() as SelectBuilder<TColumns, any, any>
    const countState = countQuery.getState()

    countState.orderBy = []
    countState.limit = null
    countState.offset = null
    countState.includes = []

    rows.limit(perPage).offset((page - 1) * perPage)

    const { rows: data, total: pageTotal } = await this._select(rows as SelectBuilder<TColumns, TRelations, any>, undefined, countQuery)
    // An empty page past the first may still follow rows, which only a count can tell.
    const total = pageTotal ?? (page === 1 ? 0 : await this._runCount(countQuery))

    return { data, total, page, perPage, totalPages: Math.ceil(total / perPage), hasNext: page * perPage < total }
  }

  async paginateCursor(opts: PaginateCursorOptions<TColumns, any>, cb?: SelectCb<TColumns, TRelations>, limits?: PageLimits): Promise<PaginateCursorResult<any, unknown>> {
    return paginateCursor({ runtime: this._runtime, findMany: cursorCb => this.findMany(cursorCb), prepare: builder => this._prepare(builder) }, opts, cb, limits)
  }

  // OFFSET pages are only disjoint over a total order, so an unordered read walks what makes its rows unique: the group columns of a grouped read, the picked columns of a DISTINCT one, else the primary key.
  // A table without a key stays unordered, and so do groupByExpr groups: their bound parameters would not match the GROUP BY's.
  private _orderByKeyIfUnordered(builder: SelectBuilder<TColumns, TRelations, any>): void {
    const { orderBy, groupBy, groupByExprs, distinct, distinctOn, columns } = builder.getState()

    if (orderBy.length > 0)
      return

    const grouped = groupBy.length > 0 || (groupByExprs?.length ?? 0) > 0
    const keys = grouped ? groupBy : distinct && columns ? columns : [...distinctOn, ...this._runtime.pkColumns]

    for (const col of keys)
      builder.orderBy(col as keyof TColumns & string)
  }

  copyTo(opts: CopyToOptions<TColumns> = {}): ReadableStream<Uint8Array> {
    requirePostgres(this._dialect, 'copyTo')

    if (!this._executor.copyOut)
      throw new ValidationError('copyTo needs an executor that runs COPY', 'copyTo')

    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).where(opts.where)

    if (opts.pick)
      builder.pick(...opts.pick)

    builder.withoutScope(...liftedScopes(opts))

    this._prepare(builder)

    const { sql, params } = builder.toSQL(this._dialect)

    return this._executor.copyOut(`COPY (${sql}) TO STDOUT WITH (FORMAT csv, HEADER ${opts.header !== false})`, params)
  }

  stream(
    arg?: FindArg<TColumns, TRelations>,
    opts: StreamOffsetOptions = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._stream(asSelectCb(arg), opts)
  }

  private async* _stream(
    cb: SelectCb<TColumns, TRelations>,
    opts: StreamOffsetOptions,
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    const exec = this._executor as { _notices?: Set<string>, _onCallbackError?: (event: { kind: 'streamWarning', error: unknown }) => void }

    // The set is shared by a Database and its transactions, so the warning comes once per Database; an executor without one warns each time.
    if (opts.warn !== false && (!exec._notices || !exec._notices.has(STREAM_OFFSET_NOTICE))) {
      exec._notices?.add(STREAM_OFFSET_NOTICE)
      const msg = '[pg-orm] stream.offset() uses LIMIT/OFFSET chunking: rows may be skipped or duplicated if data changes during iteration, and each chunk rescans the rows before it, so a large table costs quadratic time. '
        + 'Use stream.cursor() for large or changing tables, or a REPEATABLE READ transaction for correctness. '
        + 'Pass { warn: false } to suppress this warning.'

      if (exec._onCallbackError)
        exec._onCallbackError({ kind: 'streamWarning', error: new Error(msg) })
      else
        console.warn(msg)
    }

    const finalBuilder = cb(new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table)).withoutScope(...liftedScopes(opts))

    this._orderByKeyIfUnordered(finalBuilder)

    this._resolveAggregates(finalBuilder)
    this._prepare(finalBuilder)

    const chunkSize = opts.chunkSize ?? finalBuilder.getState().streamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE

    checkPageSize('stream.offset', 'chunkSize', chunkSize)

    const mapperFn = this._mapper(finalBuilder)
    // A limit or offset the callback set bounds the whole stream, read in chunks within it.
    const { limit, offset: start } = finalBuilder.getState()
    const end = limit == null ? Infinity : (start ?? 0) + limit

    let offset = start ?? 0

    while (offset < end) {
      const chunkBuilder = finalBuilder.branch()
      const chunkState = chunkBuilder.getState()
      const take = Math.min(chunkSize, end - offset)

      chunkState.limit = take
      chunkState.offset = offset

      const { sql, params } = chunkBuilder.toSQL(this._dialect)
      const rows = await this._query(chunkState, sql, params)

      if (rows.length === 0)
        break

      // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
      const hasOnlyComputed = selectedColumns(chunkState)?.length === 0 && chunkState.computedColumns.length > 0

      const mapped = await this.processRows(rows, this._runtime.table.name, {
        mapper: mapperFn,
        includes: chunkState.includes,
        skipMapper: hasOnlyComputed,
      })

      for (const row of mapped)
        yield row as WithVirtuals<TColumns, TVirtuals>

      if (rows.length < take)
        break

      offset += take
    }
  }

  streamCursor(opts: StreamCursorOptions<TColumns> = {}, cb?: SelectCb<TColumns, TRelations>): AsyncGenerator<any, void, undefined> {
    return this._streamCursor(opts, cb)
  }

  // Rows come out in the stream's direction, a backward page read back in descending order.
  private async* _streamCursor(opts: StreamCursorOptions<TColumns>, cb?: SelectCb<TColumns, TRelations>): AsyncGenerator<any, void, undefined> {
    const { chunkSize = DEFAULT_STREAM_CHUNK_SIZE, direction = 'forward', ...rest } = opts
    let cursor: unknown

    while (true) {
      const result = await this.paginateCursor({ ...rest, take: chunkSize, cursor: cursor as never, direction }, cb)

      for (const row of direction === 'backward' ? result.data.reverse() : result.data)
        yield row

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
    opts?: {
      skipMapper?: boolean
      mapper?: RowMapper<Record<string, unknown>>
      builder?: SelectBuilder<any, any, any>
      includes?: IncludeEntry[]
    },
  ): Promise<Record<string, unknown>[]> {
    const runtime = this._runtimeFor(tableName)

    let mapped = rows

    if (!opts?.skipMapper) {
      const mapper = opts?.mapper ?? this._mapperForTable(tableName, opts?.builder)

      mapped = mapChunk(mapper, rows)
    }

    mapped = await runtime.runAfter('afterSelect', mapped, this._hooks)

    mapped = runtime.applyVirtuals(mapped)

    if (opts?.includes && opts.includes.length > 0) {
      mapped = await this._relations.loadIncludes(mapped, opts.includes, this)
    }

    return mapped
  }

  // An included table's runtime and mapper factory, built once per definition and version rather than per include per query.
  private _child(tableName: string): ChildTable {
    const table = this._tableRegistry?.get(tableName)

    if (!table)
      throw new ValidationError(`"${tableName}" is not in the database's tables: list it in config.tables.`, 'include', { field: tableName })

    const cached = this._children.get(tableName)

    if (cached?.table === table && cached.version === table._version)
      return cached

    const child = { table, version: table._version, runtime: buildTableRuntime(table, this._tableRegistry), mappers: createMapperFactory(table, this._dialect) }

    this._children.set(tableName, child)

    return child
  }

  private _runtimeFor(tableName: string): TableRuntime {
    return tableName === this._runtime.table.name ? this._runtime : this._child(tableName).runtime
  }

  // `builder`, an include callback's, shapes the mapper with its pick, omit and computed columns.
  private _mapperForTable(tableName: string, builder: SelectBuilder<any, any, any> = new SelectBuilderCtor<any, any>(tableName)): RowMapper<Record<string, unknown>> {
    return tableName === this._runtime.table.name ? this._mapper(builder) : this._child(tableName).mappers(builder)
  }

  // The relation filters in the WHERE need the registry, which the builder lacks.
  private _prepare(builder: SelectBuilder<any, any, any>): void {
    this._runtime.behavior.prepareSelect(builder)

    const state = builder.getState()

    state.whereTape &&= resolveRelationFilters(state.whereTape, this._runtime.table, state.alias ?? this._runtime.table.name, this._tableRegistry)
  }

  private _resolveAggregates(builder: SelectBuilder<any, any, any>): void {
    resolveRelationAggregates(builder, this._runtime.table, this._tableRegistry, this._dialect)
  }
}
