import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyVirtuals, InferSelect, InferVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './ops/_mapper'
import type { RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { SelectBuilder } from '../builder/query'
import { count } from './ops/count'
import { exists } from './ops/exists'
import { findMany } from './ops/find-many'
import { findById, findOne, findOneOrThrow } from './ops/find-one'
import { paginate, paginateCursor } from './ops/paginate'

type SelectCb<TC extends AnyColumns, TR extends AnyRelations, TResult = any> = (q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, TResult>

/** Read coordinator — binds deps and delegates to `./ops/*`. */
export class ReadSuite<TColumns extends AnyColumns, TRelations extends AnyRelations = {}, TVirtuals extends AnyVirtuals = {}> {
  constructor(
    private _exec: Executable,
    private _rt: TableRuntime,
    private _rel: RelationResolver,
    private _map: MapperFactory,
    private _defaultLimit?: number,
  ) {}

  async findMany(): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async findMany<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<(TResult & InferVirtuals<TVirtuals>)[]>
  async findMany(cb?: SelectCb<TColumns, TRelations>): Promise<any[]> {
    return findMany<TColumns, TRelations>(this._exec, this._rt, this._rel, this._map, cb, this._defaultLimit)
  }

  async findOne(): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async findOne<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals> | null>
  async findOne(cb?: SelectCb<TColumns, TRelations>): Promise<any | null> {
    return findOne<TColumns, TRelations>(this._exec, this._rt, this._rel, this._map, cb)
  }

  async findOneOrThrow(): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findOneOrThrow<TResult>(cb: SelectCb<TColumns, TRelations, TResult>): Promise<TResult & InferVirtuals<TVirtuals>>
  async findOneOrThrow(cb?: SelectCb<TColumns, TRelations>): Promise<unknown> {
    return findOneOrThrow<TColumns, TRelations>(this._exec, this._rt, this._rel, this._map, cb)
  }

  async findById(id: unknown): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    return findById<TColumns, TRelations>(this._exec, this._rt, this._rel, this._map, id)
  }

  async count(where?: (e: ExprBuilder<TColumns>) => ExprTape): Promise<number> {
    return count<TColumns>(this._exec, this._rt, where)
  }

  async exists(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<boolean> {
    return exists<TColumns>(this._exec, this._rt, where)
  }

  async paginate(opts: { page: number, perPage: number, where?: (e: ExprBuilder<TColumns>) => ExprTape }): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], total: number, page: number, perPage: number, totalPages: number }> {
    return paginate<TColumns, TRelations>(this._exec, this._rt, this._rel, this._map, opts)
  }

  async paginateCursor<K extends keyof TColumns & string>(opts: {
    take: number
    column?: K
    cursor?: InferSelect<TColumns>[K] | null
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: WithVirtuals<TColumns, TVirtuals>[], nextCursor: InferSelect<TColumns>[K] | null }> {
    return paginateCursor<TColumns, TRelations, K>(this._exec, this._rt, this._rel, this._map, opts)
  }

  /** Builder accessor for advanced SELECT. Auto-applies the soft-delete filter. */
  select(): SelectBuilder<TColumns, TRelations> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._rt.table.name)

    this._rt.applyPreSelect(builder)

    return builder
  }
}
