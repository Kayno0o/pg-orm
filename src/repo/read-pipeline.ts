import type { OptionalWhere, OptionalWhereObject, SelectBuilder, WhereFn, WhereInput } from '../builder/query'
import type { IncludeEntry } from '../builder/state'
import type { Dialect } from '../dialect'
import type { RowMapper } from '../mapper/index'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, ColumnConstraint, InferPrimaryKey, InferSelect, PrimaryKeyColumn, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { RelationProcessor, RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { OP_SCALAR } from '../builder/_tape'
import { SelectBuilder as SelectBuilderCtor } from '../builder/query'
import { selectedColumns } from '../builder/state'
import { DEFAULT_PRIMARY_KEY, DEFAULT_STREAM_CHUNK_SIZE } from '../constants'
import { dialectOf, requirePostgres } from '../dialect'
import { NotFoundError, OrmError, ValidationError } from '../errors/index'
import { mapChunk } from '../mapper/index'
import { tableMeta } from '../schema/inspect'
import { inlineParams } from '../sql/copy'
import { quote } from '../sql/utils'
import { createMapperFactory } from './_mapper'
import { buildTableRuntime } from './table-runtime'

// The column a page carries its total in.
const PAGE_TOTAL = '__pgorm_total'

interface ChildTable {
  table: AnyTableDef
  version: number
  runtime: TableRuntime
  mappers: MapperFactory
}

type SelectCb<TC extends AnyColumns, TR extends AnyRelations, TResult = any> = (q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, TResult, any, any>
type Where<TC extends AnyColumns> = WhereInput<TC>
/** What a find takes: a select callback, or a WHERE object (falsy for no filter). */
type FindArg<TC extends AnyColumns, TR extends AnyRelations> = SelectCb<TC, TR> | OptionalWhereObject<TC>

function asSelectCb<TC extends AnyColumns, TR extends AnyRelations>(arg: FindArg<TC, TR> | undefined): SelectCb<TC, TR> {
  return typeof arg === 'function' ? arg : q => q.where(arg) as SelectBuilder<TC, TR, any>
}

/** Opt in to rows the softDelete trait has hidden. */
export interface TrashedOptions {
  withTrashed?: boolean
}

export interface CopyToOptions<TColumns extends AnyColumns> extends TrashedOptions {
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
  tableRegistry?: ReadonlyMap<string, AnyTableDef>
}

export interface SelectOptions {
  defaultLimit?: number
}

export interface PaginateOptions<TColumns extends AnyColumns> extends TrashedOptions {
  page: number
  perPage: number
  where?: OptionalWhere<TColumns>
}

export interface PaginateResult<TColumns extends AnyColumns, TVirtuals extends AnyVirtuals> {
  data: WithVirtuals<TColumns, TVirtuals>[]
  total: number
  page: number
  perPage: number
  totalPages: number
}

/** Where a cursor page resumes: the primary key when ordering by it, else the column's value and the key that breaks its ties. */
export type CursorOf<TColumns extends AnyColumns, K extends keyof TColumns & string>
  = [K] extends [PrimaryKeyColumn<TColumns>]
    ? InferPrimaryKey<TColumns>
    : { value: InferSelect<TColumns>[K], key: InferPrimaryKey<TColumns> }

export interface PaginateCursorOptions<TColumns extends AnyColumns, K extends keyof TColumns & string> extends TrashedOptions {
  take: number
  /** The column to order by, the primary key by default. Ties are broken by the primary key; a nullable column is refused. */
  column?: K
  cursor?: CursorOf<TColumns, K> | null
  direction?: 'forward' | 'backward'
  where?: OptionalWhere<TColumns>
}

export interface StreamCursorOptions<TColumns extends AnyColumns> extends TrashedOptions {
  chunkSize?: number
  column?: keyof TColumns & string
  direction?: 'forward' | 'backward'
  where?: OptionalWhere<TColumns>
}

export interface PaginateCursorResult<TRow, TCursor> {
  data: TRow[]
  nextCursor: TCursor | null
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
  private _dialect: Dialect
  private _runtime: TableRuntime
  private _relations: RelationResolver
  private _mapper: MapperFactory
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>
  private _children = new Map<string, ChildTable>()

  constructor(ctx: ReadPipelineContext) {
    this._executor = ctx.executor
    this._dialect = dialectOf(ctx.executor)
    this._runtime = ctx.runtime
    this._relations = ctx.relations
    this._mapper = ctx.mapper
    this._tableRegistry = ctx.tableRegistry
  }

  /** Builder accessor for advanced SELECT. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    const builder = new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table)

    this._runtime.behavior.prepareSelect(builder)

    return builder
  }

  async findMany(arg?: FindArg<TColumns, TRelations>, opts?: SelectOptions): Promise<any[]> {
    const { rows } = await this._select(asSelectCb(arg)(new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table)), opts)

    return rows
  }

  // `countQuery` rides along as a scalar subquery, which the database runs once, its result read off the first row and dropped before mapping: a page and its total in one round trip, the page still stopping at its LIMIT. The total is unknown when the page is empty.
  private async _select(finalBuilder: SelectBuilder<TColumns, TRelations, any>, opts?: SelectOptions, countQuery?: SelectBuilder<TColumns, any, any>): Promise<{ rows: any[], total?: number }> {
    this._runtime.behavior.prepareSelect(finalBuilder)
    this._resolveCounts(finalBuilder)

    const state = finalBuilder.getState()

    if (opts?.defaultLimit != null && state.limit == null) {
      state.limit = opts.defaultLimit
    }

    if (countQuery) {
      this._runtime.behavior.prepareSelect(countQuery)
      state.computedColumns.push({ expr: '', alias: PAGE_TOTAL, tape: [{ op: OP_SCALAR, subquery: countQuery }] })
    }

    const { sql, params } = finalBuilder.toSQL(this._dialect)

    if (countQuery)
      state.computedColumns.pop()

    const rows = await this._executor.query(sql, params)
    let total: number | undefined

    if (countQuery && rows.length > 0) {
      total = Number(rows[0]![PAGE_TOTAL])

      for (const row of rows) delete row[PAGE_TOTAL]
    }

    // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
    const hasOnlyComputed = selectedColumns(state)?.length === 0 && state.computedColumns.length > 0

    const processed = await this.processRows(rows, this._runtime.table.name, 'select', {
      mapper: this._mapper(finalBuilder),
      includes: state.includes,
      skipMapper: hasOnlyComputed,
    })

    return { rows: processed, total }
  }

  async findOne(arg?: FindArg<TColumns, TRelations>): Promise<any | null> {
    const cb = asSelectCb(arg)
    const rows = await this.findMany(q => cb(q).limit(1))

    return rows[0] ?? null
  }

  async findOneOrThrow(arg?: FindArg<TColumns, TRelations>): Promise<unknown> {
    const row = await this.findOne(arg)

    if (row === null)
      throw new NotFoundError(this._runtime.table.name)

    return row
  }

  async findById(id: unknown, cb?: SelectCb<TColumns, TRelations>): Promise<any | null> {
    const where = this._runtime.pkWhere(id) as Where<TColumns>

    return this.findOne(q => (cb ? cb(q) : q).where(where) as SelectBuilder<TColumns, TRelations, any>)
  }

  async findByIdOrThrow(id: unknown, cb?: SelectCb<TColumns, TRelations>): Promise<any> {
    const row = await this.findById(id, cb)

    if (row === null)
      throw new NotFoundError(this._runtime.table.name)

    return row
  }

  async existsById(id: unknown, opts?: TrashedOptions): Promise<boolean> {
    return this.exists(this._runtime.pkWhere(id) as Where<TColumns>, opts)
  }

  async count(where?: OptionalWhere<TColumns>, opts?: TrashedOptions): Promise<number> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).count().where(where)

    if (opts?.withTrashed)
      builder.withTrashed()

    return this._runCount(builder)
  }

  private async _runCount(builder: SelectBuilder<TColumns, any, any>): Promise<number> {
    this._runtime.behavior.prepareSelect(builder)

    const { sql, params } = builder.toSQL(this._dialect)
    const rows = await this._executor.query(sql, params)

    return Number(rows[0]?.count ?? 0)
  }

  async exists(where?: OptionalWhere<TColumns>, opts?: TrashedOptions): Promise<boolean> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).asExists().limit(1).where(where)

    if (opts?.withTrashed)
      builder.withTrashed()

    this._runtime.behavior.prepareSelect(builder)

    const { sql, params } = builder.toSQL(this._dialect)
    const rows = await this._executor.query(sql, params)

    return rows.length > 0
  }

  async paginate(opts: PaginateOptions<TColumns>, cb?: SelectCb<TColumns, TRelations>): Promise<PaginateResult<TColumns, TVirtuals>> {
    const { page, perPage, where, withTrashed } = opts

    if (!Number.isInteger(page) || page < 1)
      throw new ValidationError(`paginate() requires page >= 1, got ${page}`, 'paginate', { value: page })

    if (!Number.isInteger(perPage) || perPage < 1)
      throw new ValidationError(`paginate() requires perPage >= 1, got ${perPage}`, 'paginate', { value: perPage })

    const base = new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table)
    const rows = (cb ? cb(base) : base).andWhere(where)

    if (withTrashed)
      rows.withTrashed()

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

    return { data, total, page, perPage, totalPages: Math.ceil(total / perPage) }
  }

  // Keyset paging on (column, primary key): a row-value comparison resumes after the cursor, so tied values are neither skipped nor repeated. A backward page is read descending, its cursor taken from the last row read, then reversed.
  async paginateCursor(opts: PaginateCursorOptions<TColumns, any>, cb?: SelectCb<TColumns, TRelations>): Promise<PaginateCursorResult<any, unknown>> {
    const { take, cursor, direction = 'forward', where, withTrashed } = opts
    const { keys, byKey } = this._cursorKeys(opts.column)
    const isForward = direction === 'forward'

    if (!Number.isInteger(take) || take < 1)
      throw new ValidationError(`paginateCursor() requires take >= 1, got ${take}`, 'paginateCursor', { value: take })

    const data = await this.findMany((q) => {
      const b = cb ? cb(q) : q
      const state = b.getState()

      if (state.orderBy.length > 0 || state.limit != null || state.offset != null)
        throw new ValidationError('paginateCursor(): the callback must not set orderBy, limit or offset, which the cursor owns.', 'paginateCursor')

      this._runtime.behavior.prepareSelect(b)

      const picked = selectedColumns(state)

      if (picked && keys.some(k => !picked.includes(k)))
        throw new ValidationError(`paginateCursor(): the callback's pick() or omit() leaves out a cursor column (${keys.join(', ')}).`, 'paginateCursor')

      b.andWhere(where).limit(take + 1)

      if (withTrashed)
        b.withTrashed()

      for (const key of keys)
        b.orderBy(key, isForward ? 'asc' : 'desc')

      if (cursor != null)
        b.andWhere(this._afterCursor(keys, this._cursorValues(cursor, keys, byKey), isForward))

      return b
    })

    const hasMore = data.length > take

    if (hasMore)
      data.pop()

    const boundary = data.at(-1) as Record<string, unknown> | undefined
    const nextCursor = hasMore && boundary ? this._cursorOf(boundary, keys, byKey) : null

    if (!isForward)
      data.reverse()

    return { data, nextCursor }
  }

  // The ordering columns: the primary key (led by `column` when it is part of it), or `column` then the key.
  private _cursorKeys(column: string | undefined): { keys: string[], byKey: boolean } {
    const { pkColumns, table } = this._runtime
    const byKey = column === undefined || pkColumns.includes(column)
    const keys = byKey ? [...column ? [column] : [], ...pkColumns.filter(c => c !== column)] : [column, ...pkColumns]
    const nullable = keys.find(k => !table.columns[k]?.constraints.some((c: ColumnConstraint) => c.type === 'not_null' || c.type === 'primary_key'))

    if (nullable !== undefined)
      throw new ValidationError(`paginateCursor(): "${table.name}"."${nullable}" is nullable, and a cursor cannot order past its NULLs.`, 'paginateCursor', { field: nullable })

    return { keys, byKey }
  }

  private _cursorOf(row: Record<string, unknown>, keys: string[], byKey: boolean): unknown {
    const { pkColumns } = this._runtime
    const pk = pkColumns.length === 1 ? row[pkColumns[0]!] : Object.fromEntries(pkColumns.map(c => [c, row[c]]))

    return byKey ? pk : { value: row[keys[0]!], key: pk }
  }

  private _cursorValues(cursor: unknown, keys: string[], byKey: boolean): unknown[] {
    const { pkColumns } = this._runtime
    const parts = (byKey ? cursor : (cursor as { key: unknown }).key) as Record<string, unknown>
    const pk = (col: string) => pkColumns.length === 1 ? parts : parts[col]

    return keys.map(k => pkColumns.includes(k) ? pk(k) : (cursor as { value: unknown }).value)
  }

  private _afterCursor(keys: string[], values: unknown[], isForward: boolean): WhereFn<TColumns> {
    const op = isForward ? '>' : '<'

    if (keys.length === 1)
      return e => isForward ? e.gt(keys[0]! as keyof TColumns & string, values[0] as never) : e.lt(keys[0]! as keyof TColumns & string, values[0] as never)

    return e => e.raw(`(${keys.map(quote).join(', ')}) ${op} (${keys.map(() => '?').join(', ')})`, ...values)
  }

  copyTo(opts: CopyToOptions<TColumns> = {}): ReadableStream<Uint8Array> {
    requirePostgres(this._dialect, 'copyTo')

    if (!this._executor.copyOut)
      throw new OrmError('copyTo needs an executor that runs COPY')

    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).where(opts.where)

    if (opts.pick)
      builder.pick(...opts.pick)

    if (opts.withTrashed)
      builder.withTrashed()

    this._runtime.behavior.prepareSelect(builder)

    const { sql, params } = builder.toSQL(this._dialect)

    return this._executor.copyOut(`COPY (${inlineParams(sql, params)}) TO STDOUT WITH (FORMAT csv, HEADER ${opts.header !== false})`)
  }

  stream(
    arg?: FindArg<TColumns, TRelations>,
    opts: { chunkSize?: number, unsafe?: boolean } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._stream(asSelectCb(arg), opts)
  }

  private async* _stream(
    cb: SelectCb<TColumns, TRelations>,
    opts: { chunkSize?: number, unsafe?: boolean },
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    if (!opts.unsafe && !_streamWarned) {
      _streamWarned = true
      const msg = '[pg-orm] stream.offset() uses LIMIT/OFFSET chunking, rows may be skipped or duplicated if data changes during iteration. '
        + 'Use stream.cursor() or a REPEATABLE READ transaction for correctness. '
        + 'Pass { unsafe: true } to suppress this warning.'
      const exec = this._executor as { _onCallbackError?: (event: { kind: 'streamWarning', error: unknown }) => void }

      if (exec._onCallbackError)
        exec._onCallbackError({ kind: 'streamWarning', error: new Error(msg) })
      else
        console.warn(msg)
    }

    const finalBuilder = cb(new SelectBuilderCtor<TColumns, TRelations>(this._runtime.table))

    // OFFSET pages are only disjoint over a total order, so an unordered stream walks the primary key.
    if (finalBuilder.getState().orderBy.length === 0) {
      for (const col of this._runtime.pkColumns)
        finalBuilder.orderBy(col as keyof TColumns & string)
    }

    this._resolveCounts(finalBuilder)
    this._runtime.behavior.prepareSelect(finalBuilder)

    const chunkSize = opts.chunkSize ?? finalBuilder.getState().streamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
    const mapperFn = this._mapper(finalBuilder)

    let offset = 0

    while (true) {
      const chunkBuilder = finalBuilder.branch()
      const chunkState = chunkBuilder.getState()

      chunkState.limit = chunkSize
      chunkState.offset = offset

      const { sql, params } = chunkBuilder.toSQL(this._dialect)
      const rows = await this._executor.query(sql, params)

      if (rows.length === 0)
        break

      // Skip JIT mapper for aggregate/computed-only queries (no table columns selected)
      const hasOnlyComputed = selectedColumns(chunkState)?.length === 0 && chunkState.computedColumns.length > 0

      const mapped = await this.processRows(rows, this._runtime.table.name, 'select', {
        mapper: mapperFn,
        includes: chunkState.includes,
        skipMapper: hasOnlyComputed,
      })

      for (const row of mapped)
        yield row as WithVirtuals<TColumns, TVirtuals>

      if (rows.length < chunkSize)
        break

      offset += chunkSize
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
    source: 'select',
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

    await runtime.runAfter('afterSelect', mapped)

    mapped = runtime.applyVirtuals(mapped)

    if (source === 'select' && opts?.includes && opts.includes.length > 0) {
      mapped = await this._relations.loadIncludes(mapped, opts.includes, this)
    }

    return mapped
  }

  // An included table's runtime and mapper factory, built once per definition and version rather than per include per query.
  private _child(tableName: string): ChildTable | undefined {
    const table = this._tableRegistry?.get(tableName)

    if (!table)
      return undefined

    const cached = this._children.get(tableName)

    if (cached?.table === table && cached.version === table._version)
      return cached

    const child = { table, version: table._version, runtime: buildTableRuntime(table), mappers: createMapperFactory(table, this._dialect) }

    this._children.set(tableName, child)

    return child
  }

  private _runtimeFor(tableName: string): TableRuntime {
    if (tableName === this._runtime.table.name)
      return this._runtime

    return this._child(tableName)?.runtime ?? this._runtime
  }

  // `builder`, an include callback's, shapes the mapper with its pick, omit and computed columns.
  private _mapperForTable(tableName: string, builder: SelectBuilder<any, any, any> = new SelectBuilderCtor<any, any>(tableName)): RowMapper<Record<string, unknown>> {
    if (tableName === this._runtime.table.name)
      return this._mapper(builder)

    const child = this._child(tableName)

    return child ? child.mappers(builder) : (row: Record<string, unknown>) => row
  }

  // Each `withCount` becomes a correlated COUNT subquery; it needs the registry for the target's key and soft-delete column, which the builder does not have.
  private _resolveCounts(builder: SelectBuilder<any, any, any>): void {
    const state = builder.getState()
    const { table, pkColumns } = this._runtime

    for (const { relation, alias, where, withDeleted } of state.relationCounts.splice(0)) {
      const rel = (table.relations as AnyRelations)[relation]

      if (!rel || (rel.type !== 'hasMany' && rel.type !== 'hasManyThrough'))
        throw new ValidationError(`withCount(): "${relation}" is not a hasMany or hasManyThrough relation of "${table.name}".`, 'withCount', { field: relation })

      if (pkColumns.length !== 1)
        throw new ValidationError(`withCount(): "${table.name}" has a composite primary key, which a relation count cannot join on.`, 'withCount', { field: relation })

      const parentKey = `${quote(state.alias ?? table.name)}.${quote(pkColumns[0]!)}`
      const target = this._tableRegistry?.get(rel.targetTable)
      const trashed = target && !withDeleted ? tableMeta(target).softDelete?.column : undefined
      const child = '"__count"'
      const live = trashed ? ` AND ${child}.${quote(trashed)} IS NULL` : ''
      const from = rel.type === 'hasMany'
        ? `FROM ${quote(rel.targetTable)} AS ${child} WHERE ${child}.${quote(rel.foreignKey)} = ${parentKey}`
        : `FROM ${quote(rel.throughTable!)} AS "__pivot" JOIN ${quote(rel.targetTable)} AS ${child} ON ${child}.${quote(target?.primaryKey ?? DEFAULT_PRIMARY_KEY)} = "__pivot".${quote(rel.throughTo!)} WHERE "__pivot".${quote(rel.throughFrom!)} = ${parentKey}`
      const expr = `SELECT count(*)${this._dialect === 'postgres' ? '::int' : ''} ${from}${live}`

      state.computedColumns.push(where ? { expr, alias, filter: { tape: where, qualifier: '__count' } } : { expr: `(${expr})`, alias })
    }
  }
}
