import type { OptionalWhere, SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, InferSelect, InferVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { PaginateCursorOptions, PaginateOptions, PaginateResult, TrashedOptions } from './read-pipeline'
import type { RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { ReadPipeline } from './read-pipeline'

type SelectCb<TC extends AnyColumns, TR extends AnyRelations, TResult = any> = (q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, TResult>

/** Read coordinator — binds deps and delegates to `ReadPipeline`. */
export class ReadSuite<TColumns extends AnyColumns, TRelations extends AnyRelations = {}, TVirtuals extends AnyVirtuals = {}> {
  private _pipeline: ReadPipeline<TColumns, TRelations, TVirtuals>
  private _defaultLimit?: number

  constructor(
    exec: Executable,
    rt: TableRuntime,
    rel: RelationResolver,
    map: MapperFactory,
    defaultLimit?: number,
    tableRegistry?: ReadonlyMap<string, AnyTableDef>,
  ) {
    this._pipeline = new ReadPipeline<TColumns, TRelations, TVirtuals>({
      executor: exec,
      runtime: rt,
      relations: rel,
      mapper: map,
      tableRegistry,
    })
    this._defaultLimit = defaultLimit
  }

  async findMany(): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async findMany<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<(TResult & InferVirtuals<TVirtuals>)[]>
  async findMany(cb?: SelectCb<TColumns, TRelations>): Promise<any[]> {
    return this._pipeline.findMany(cb, { defaultLimit: this._defaultLimit })
  }

  async findOne(): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async findOne<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals> | null>
  async findOne(cb?: SelectCb<TColumns, TRelations>): Promise<any | null> {
    return cb ? this._pipeline.findOne(cb) : this._pipeline.findOne()
  }

  async findOneOrThrow(): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findOneOrThrow<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals>>
  async findOneOrThrow(cb?: SelectCb<TColumns, TRelations>): Promise<unknown> {
    return cb ? this._pipeline.findOneOrThrow(cb) : this._pipeline.findOneOrThrow()
  }

  /** `findMany` with nothing but a WHERE — the shape `count`, `exists` and `deleteMany` already take. */
  async findManyBy(where: OptionalWhere<TColumns>): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.findManyBy(where)
  }

  /** `findOne` with nothing but a WHERE. */
  async findOneBy(where: OptionalWhere<TColumns>): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.findOneBy(where)
  }

  /** Load one row by primary key. A composite key takes an object holding each part. */
  async findById(id: unknown): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async findById<TResult>(id: unknown, cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals> | null>
  async findById(id: unknown, cb?: SelectCb<TColumns, TRelations>): Promise<any | null> {
    return this._pipeline.findById(id, cb)
  }

  /** `findById`, throwing `NotFoundError` instead of returning null. */
  async findByIdOrThrow(id: unknown): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findByIdOrThrow<TResult>(id: unknown, cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals>>
  async findByIdOrThrow(id: unknown, cb?: SelectCb<TColumns, TRelations>): Promise<any> {
    return this._pipeline.findByIdOrThrow(id, cb)
  }

  async existsById(id: unknown): Promise<boolean> {
    return this._pipeline.existsById(id)
  }

  async count(where?: OptionalWhere<TColumns>, opts?: TrashedOptions): Promise<number> {
    return this._pipeline.count(where, opts)
  }

  async exists(where?: OptionalWhere<TColumns>, opts?: TrashedOptions): Promise<boolean> {
    return this._pipeline.exists(where, opts)
  }

  /** Offset pagination. The optional callback shapes the page (`pick`, `orderBy`, `include`, …) and any filter it adds is reflected in `total`. */
  async paginate(opts: PaginateOptions<TColumns>): Promise<PaginateResult<TColumns, TVirtuals>>
  async paginate<TResult>(opts: PaginateOptions<TColumns>, cb: SelectCb<TColumns, TRelations, TResult>): Promise<Omit<PaginateResult<TColumns, TVirtuals>, 'data'> & { data: (TResult & InferVirtuals<TVirtuals>)[] }>
  async paginate(opts: PaginateOptions<TColumns>, cb?: SelectCb<TColumns, TRelations>): Promise<any> {
    return this._pipeline.paginate(opts, cb)
  }

  async paginateCursor<K extends keyof TColumns & string>(
    opts: PaginateCursorOptions<TColumns, K>,
  ): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], nextCursor: InferSelect<TColumns>[K] | null }> {
    return this._pipeline.paginateCursor(opts)
  }

  /** Builder accessor for advanced SELECT. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    return this._pipeline.select()
  }
}
