import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, InferSelect, InferVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
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

  async findById(id: unknown): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.findById(id)
  }

  async count(where?: (e: ExprBuilder<TColumns>) => ExprTape): Promise<number> {
    return this._pipeline.count(where)
  }

  async exists(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<boolean> {
    return this._pipeline.exists(where)
  }

  async paginate(opts: { page: number, perPage: number, where?: (e: ExprBuilder<TColumns>) => ExprTape }): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], total: number, page: number, perPage: number, totalPages: number }> {
    return this._pipeline.paginate(opts)
  }

  async paginateCursor<K extends keyof TColumns & string>(opts: {
    take: number
    column?: K
    cursor?: InferSelect<TColumns>[K] | null
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], nextCursor: InferSelect<TColumns>[K] | null }> {
    return this._pipeline.paginateCursor(opts)
  }

  /** Builder accessor for advanced SELECT. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    return this._pipeline.select()
  }
}
