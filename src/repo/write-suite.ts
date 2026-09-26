import type { ConflictUpdate } from '../builder/insert'
import type { WhereInput } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyVirtuals, InferInsert, InferPrimaryKey, InferUpdate, InferUpdateById, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import type { UpsertUpdate } from './write-pipeline'
import { DeleteBuilder, InsertBuilder, MergeBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { WritePipeline } from './write-pipeline'

type Where<TColumns extends AnyColumns> = WhereInput<TColumns>
type GuardedUpsert<TColumns extends AnyColumns> = ConflictUpdate<TColumns> & { where: Where<TColumns> }
type UnguardedUpsert<TColumns extends AnyColumns> = (keyof TColumns & string)[] | Omit<ConflictUpdate<TColumns>, 'where'>

/** Write coordinator — delegates to the deep `WritePipeline`. */
export class WriteSuite<
  TColumns extends AnyColumns,
  _TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  private _pipeline: WritePipeline<TColumns, TVirtuals>
  private _rt: TableRuntime

  constructor(
    _exec: Executable,
    _rt: TableRuntime,
  ) {
    this._pipeline = new WritePipeline<TColumns, TVirtuals>({ executor: _exec, runtime: _rt })
    this._rt = _rt
  }

  async insertOne(values: InferInsert<TColumns>): Promise<InferPrimaryKey<TColumns>>
  async insertOne(values: InferInsert<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>>
  async insertOne(values: InferInsert<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    return this._pipeline.insertOne(values, opts)
  }

  async insertMany(values: InferInsert<TColumns>[]): Promise<InferPrimaryKey<TColumns>[]>
  async insertMany(values: InferInsert<TColumns>[], opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async insertMany(values: InferInsert<TColumns>[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.insertMany(values, opts)
  }

  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>): Promise<InferPrimaryKey<TColumns>[]>
  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.updateMany(set, where, opts)
  }

  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns>): Promise<InferPrimaryKey<TColumns> | null>
  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.updateOne(set, where, opts)
  }

  /** Update the row with this primary key. A composite key takes an object holding each part. */
  async updateById(id: unknown, set: InferUpdate<TColumns>): Promise<InferPrimaryKey<TColumns> | null>
  async updateById(id: unknown, set: InferUpdate<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async updateById(id: unknown, set: InferUpdate<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.updateOne(set, this._rt.pkWhere(id) as Where<TColumns>, opts)
  }

  /** Update many rows in one statement, each with its own values: `updateManyById([{ id: 1, position: 0 }, { id: 2, position: 1 }])`. Rows may write different columns; a row whose key matches nothing is skipped. */
  async updateManyById(rows: InferUpdateById<TColumns>[]): Promise<InferPrimaryKey<TColumns>[]>
  async updateManyById(rows: InferUpdateById<TColumns>[], opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async updateManyById(rows: InferUpdateById<TColumns>[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.updateManyById(rows as Record<string, unknown>[], opts)
  }

  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns>, currentVersion: number): Promise<InferPrimaryKey<TColumns>>
  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns>, currentVersion: number, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>>
  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns>, currentVersion: number, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    return this._pipeline.updateWithLock(set, where, currentVersion, opts)
  }

  async deleteMany(where: Where<TColumns>): Promise<InferPrimaryKey<TColumns>[]>
  async deleteMany(where: Where<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async deleteMany(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.deleteMany(where, opts)
  }

  async deleteOne(where: Where<TColumns>): Promise<InferPrimaryKey<TColumns> | null>
  async deleteOne(where: Where<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async deleteOne(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.deleteOne(where, opts)
  }

  /** Delete the row with this primary key. A composite key takes an object holding each part. */
  async deleteById(id: unknown): Promise<InferPrimaryKey<TColumns> | null>
  async deleteById(id: unknown, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async deleteById(id: unknown, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.deleteOne(this._rt.pkWhere(id) as Where<TColumns>, opts)
  }

  /**
   * Insert rows, updating each one that conflicts on `conflictTarget`. `update` lists the columns to copy from the incoming row (default: all of them), or is a `ConflictUpdate`:
   * `set` computes columns from the existing row (`u => ({ visits: u.add(u.existing('visits'), 1) })`) and `where` guards the update, a row it skips being left out of the result.
   */
  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], update?: UpsertUpdate<TColumns>): Promise<InferPrimaryKey<TColumns>[]>
  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], update: UpsertUpdate<TColumns> | undefined, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], update?: UpsertUpdate<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.upsertMany(values, conflictTarget, update, opts)
  }

  /** Single-row `upsertMany`. With a `where` guard it returns `null` when the guard skipped the update. */
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update: GuardedUpsert<TColumns>): Promise<InferPrimaryKey<TColumns> | null>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update: GuardedUpsert<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update?: UnguardedUpsert<TColumns>): Promise<InferPrimaryKey<TColumns>>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update: UnguardedUpsert<TColumns> | undefined, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update?: UpsertUpdate<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.upsertOne(values, conflictTarget, update, opts)
  }

  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[]): Promise<InferPrimaryKey<TColumns>>
  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>>
  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    return this._pipeline.findOrCreate(values, conflictTarget, opts)
  }

  async restore(where: Where<TColumns>): Promise<InferPrimaryKey<TColumns>[]>
  async restore(where: Where<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async restore(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.restore(where, opts)
  }

  async forceDelete(where: Where<TColumns>): Promise<InferPrimaryKey<TColumns>[]>
  async forceDelete(where: Where<TColumns>, opts: { full: true }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async forceDelete(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.forceDelete(where, opts)
  }

  // Builder accessors — skip the hook/trait dispatch applied by the methods above.
  insert(): InsertBuilder<TColumns> { return new InsertBuilder<TColumns>(this._rt.table.name) }
  update(): UpdateBuilder<TColumns> { return new UpdateBuilder<TColumns>(this._rt.table.name) }
  delete(): DeleteBuilder<TColumns> { return new DeleteBuilder<TColumns>(this._rt.table.name) }
  merge(): MergeBuilder<TColumns> { return new MergeBuilder<TColumns>(this._rt.table.name) }
  upsert(): UpsertBuilder<TColumns> { return new UpsertBuilder<TColumns>(this._rt.table.name) }
}
