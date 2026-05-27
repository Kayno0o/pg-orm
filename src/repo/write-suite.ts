import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyVirtuals, InferInsert, InferPrimaryKey, InferUpdate, WithVirtuals } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { DeleteBuilder, InsertBuilder, MergeBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { deleteMany, deleteOne } from './ops/delete-many'
import { findOrCreate } from './ops/find-or-create'
import { forceDelete } from './ops/force-delete'
import { insertMany } from './ops/insert-many'
import { insertOne } from './ops/insert-one'
import { restore } from './ops/restore'
import { updateMany, updateOne } from './ops/update-many'
import { updateWithLock } from './ops/update-with-lock'
import { upsertMany } from './ops/upsert'

/** Write coordinator — binds deps and delegates to `./ops/*`. */
export class WriteSuite<
  TColumns extends AnyColumns,
  _TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  constructor(
    private _exec: Executable,
    private _rt: TableRuntime,
  ) {}

  async insertOne(values: InferInsert<TColumns>): Promise<InferPrimaryKey<TColumns>> {
    return insertOne<TColumns>(this._exec, this._rt, values)
  }

  async insertMany(values: InferInsert<TColumns>[]): Promise<InferPrimaryKey<TColumns>[]> {
    return insertMany<TColumns>(this._exec, this._rt, values)
  }

  async updateMany(set: InferUpdate<TColumns>, where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    return updateMany<TColumns>(this._exec, this._rt, set, where)
  }

  async updateOne(set: InferUpdate<TColumns>, where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    return updateOne<TColumns>(this._exec, this._rt, set, where)
  }

  async updateWithLock(set: InferUpdate<TColumns>, where: (e: ExprBuilder<TColumns>) => ExprTape, currentVersion: number): Promise<WithVirtuals<TColumns, TVirtuals>> {
    return updateWithLock<TColumns>(this._exec, this._rt, set, where, currentVersion)
  }

  async deleteMany(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    return deleteMany<TColumns>(this._exec, this._rt, where)
  }

  async deleteOne(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    return deleteOne<TColumns>(this._exec, this._rt, where)
  }

  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], updateColumns?: (keyof TColumns & string)[]): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    return upsertMany<TColumns>(this._exec, this._rt, values, conflictTarget, updateColumns)
  }

  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[]): Promise<WithVirtuals<TColumns, TVirtuals>> {
    return findOrCreate<TColumns>(this._exec, this._rt, values, conflictTarget)
  }

  async restore(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    return restore<TColumns>(this._exec, this._rt, where)
  }

  async forceDelete(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    return forceDelete<TColumns>(this._exec, this._rt, where)
  }

  // Builder accessors — skip the hook/trait dispatch applied by the methods above.
  insert(): InsertBuilder<TColumns> { return new InsertBuilder<TColumns>(this._rt.table.name) }
  update(): UpdateBuilder<TColumns> { return new UpdateBuilder<TColumns>(this._rt.table.name) }
  delete(): DeleteBuilder<TColumns> { return new DeleteBuilder<TColumns>(this._rt.table.name) }
  merge(): MergeBuilder<TColumns> { return new MergeBuilder<TColumns>(this._rt.table.name) }
  upsert(): UpsertBuilder<TColumns> { return new UpsertBuilder<TColumns>(this._rt.table.name) }
}
