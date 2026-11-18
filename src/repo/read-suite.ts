import type { VectorValue } from '../builder/expr'
import type { OptionalWhere, OptionalWhereObject, SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, HookContext, InferVirtuals, PrimaryKeyColumn, ScopeOptions, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { CursorOf, NearestOptions, PageLimits, PaginateCursorOptions, PaginateCursorResult, PaginateOptions, PaginatePage, PaginateResult } from './read-pipeline'
import type { RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { ReadPipeline } from './read-pipeline'

type SelectCb<TC extends AnyColumns, TR extends AnyRelations, TResult = any> = (q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, TResult, any, any>

/** Read coordinator — binds deps and delegates to `ReadPipeline`. */
export class ReadSuite<TColumns extends AnyColumns, TRelations extends AnyRelations = {}, TVirtuals extends AnyVirtuals = {}> {
  private _pipeline: ReadPipeline<TColumns, TRelations, TVirtuals>
  private _defaultLimit?: number
  private _limits: PageLimits

  constructor(
    exec: Executable,
    rt: TableRuntime,
    rel: RelationResolver,
    map: MapperFactory,
    defaultLimit: number | undefined,
    tableRegistry: ReadonlyMap<string, AnyTableDef> | undefined,
    maxPageSize: number | undefined,
    hooks: HookContext,
  ) {
    this._pipeline = new ReadPipeline<TColumns, TRelations, TVirtuals>({
      executor: exec,
      runtime: rt,
      relations: rel,
      mapper: map,
      hooks,
      tableRegistry,
    })
    this._defaultLimit = defaultLimit
    this._limits = { maxPageSize }
  }

  /** Rows matching a WHERE object, or shaped by a select callback (`pick`, `include`, `orderBy`, a callback WHERE). The object form takes `ScopeOptions` as `count` does; the callback has `withoutScope()` and `withTrashed()` on its builder. */
  async findMany<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<(TResult & InferVirtuals<TVirtuals>)[]>
  async findMany(where?: OptionalWhereObject<TColumns>, opts?: ScopeOptions): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async findMany(arg?: SelectCb<TColumns, TRelations> | OptionalWhereObject<TColumns>, opts?: ScopeOptions): Promise<any[]> {
    return this._pipeline.findMany(arg, { ...opts, defaultLimit: this._defaultLimit })
  }

  /** @internal */
  async _findAll<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<(TResult & InferVirtuals<TVirtuals>)[]> {
    return this._pipeline.findMany(cb)
  }

  async findOne<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals> | null>
  async findOne(where?: OptionalWhereObject<TColumns>, opts?: ScopeOptions): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async findOne(arg?: SelectCb<TColumns, TRelations> | OptionalWhereObject<TColumns>, opts?: ScopeOptions): Promise<any | null> {
    return this._pipeline.findOne(arg, opts)
  }

  async findOneOrThrow<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals>>
  async findOneOrThrow(where?: OptionalWhereObject<TColumns>, opts?: ScopeOptions): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findOneOrThrow(arg?: SelectCb<TColumns, TRelations> | OptionalWhereObject<TColumns>, opts?: ScopeOptions): Promise<unknown> {
    return this._pipeline.findOneOrThrow(arg, opts)
  }

  /** Load one row by primary key. A composite key takes an object holding each part. After the key goes a select callback, or `ScopeOptions` as `existsById` takes. */
  async findById(id: unknown, opts?: ScopeOptions): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async findById<TResult>(id: unknown, cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals> | null>
  async findById(id: unknown, shape?: SelectCb<TColumns, TRelations> | ScopeOptions): Promise<any | null> {
    return this._pipeline.findById(id, shape)
  }

  /** `findById`, throwing `NotFoundError` instead of returning null. */
  async findByIdOrThrow(id: unknown, opts?: ScopeOptions): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findByIdOrThrow<TResult>(id: unknown, cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals>>
  async findByIdOrThrow(id: unknown, shape?: SelectCb<TColumns, TRelations> | ScopeOptions): Promise<any> {
    return this._pipeline.findByIdOrThrow(id, shape)
  }

  async existsById(id: unknown, opts?: ScopeOptions): Promise<boolean> {
    return this._pipeline.existsById(id, opts)
  }

  async count(where?: OptionalWhere<TColumns, TRelations>, opts?: ScopeOptions): Promise<number> {
    return this._pipeline.count(where, opts)
  }

  async exists(where?: OptionalWhere<TColumns, TRelations>, opts?: ScopeOptions): Promise<boolean> {
    return this._pipeline.exists(where, opts)
  }

  /** The `k` rows closest to `vec`, nearest first, each with its `distance`: the column the `embedding()` trait names unless `column` says another, cosine unless `metric` says another. Scopes apply. */
  async nearest(vec: VectorValue, opts: NearestOptions<TColumns>): Promise<(WithVirtuals<TColumns, TVirtuals> & { distance: number })[]> {
    return this._pipeline.nearest(vec, opts, this._limits)
  }

  /** Offset pagination. The optional callback shapes the page (`pick`, `orderBy`, `include`, …) and any filter it adds is reflected in `total`. */
  async paginate(opts: PaginateOptions<TColumns> & { withTotal: false }): Promise<PaginatePage<TColumns, TVirtuals>>
  async paginate<TResult>(opts: PaginateOptions<TColumns> & { withTotal: false }, cb: SelectCb<TColumns, TRelations, TResult>): Promise<Omit<PaginatePage<TColumns, TVirtuals>, 'data'> & { data: (TResult & InferVirtuals<TVirtuals>)[] }>
  async paginate(opts: PaginateOptions<TColumns>): Promise<PaginateResult<TColumns, TVirtuals>>
  async paginate<TResult>(opts: PaginateOptions<TColumns>, cb: SelectCb<TColumns, TRelations, TResult>): Promise<Omit<PaginateResult<TColumns, TVirtuals>, 'data'> & { data: (TResult & InferVirtuals<TVirtuals>)[] }>
  async paginate(opts: PaginateOptions<TColumns>, cb?: SelectCb<TColumns, TRelations>): Promise<any> {
    return this._pipeline.paginate(opts, cb, this._limits)
  }

  /** Keyset pagination ordered by `column` then the primary key. Pass `nextCursor` back as `cursor` for the next page; the optional callback shapes rows (`pick`, `include`, a WHERE) but leaves order and limit to the cursor. */
  async paginateCursor<K extends keyof TColumns & string = PrimaryKeyColumn<TColumns> & string>(
    opts: PaginateCursorOptions<TColumns, K>,
  ): Promise<PaginateCursorResult<WithVirtuals<TColumns, TVirtuals>, CursorOf<TColumns, K>>>
  async paginateCursor<TResult, K extends keyof TColumns & string = PrimaryKeyColumn<TColumns> & string>(
    opts: PaginateCursorOptions<TColumns, K>,
    cb: SelectCb<TColumns, TRelations, TResult>,
  ): Promise<PaginateCursorResult<TResult & InferVirtuals<TVirtuals>, CursorOf<TColumns, K>>>
  async paginateCursor(opts: PaginateCursorOptions<TColumns, any>, cb?: SelectCb<TColumns, TRelations>): Promise<PaginateCursorResult<any, any>> {
    return this._pipeline.paginateCursor(opts, cb, this._limits)
  }

  /** Builder accessor for advanced SELECT. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    return this._pipeline.select()
  }
}
