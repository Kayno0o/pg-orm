import type { ConflictUpdate } from '../builder/insert'
import type { WhereInput } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, HookContext, InferInsert, InferPrimaryKey, InferUpdate, InferUpdateById, InsertOptions, ScopedWriteOptions, SingleRowOptions, UpdateOptions, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import type { UpsertUpdate } from './write-pipeline'
import { DeleteBuilder, InsertBuilder, MergeBuilder, UpdateBuilder } from '../builder/query'
import { WritePipeline } from './write-pipeline'

type Where<TColumns extends AnyColumns, TRelations extends AnyRelations = AnyRelations> = WhereInput<TColumns, TRelations>
type GuardedUpsert<TColumns extends AnyColumns> = ConflictUpdate<TColumns> & { where: Where<TColumns> }
interface Unreturned { returning: false }

// `returning: false` resolves to nothing, whatever the pipeline read for the after-write hooks.
function unreturned<T>(opts: WriteReturnOptions | undefined, result: T): T | undefined {
  return opts?.returning === false ? undefined : result
}

type UnguardedUpsert<TColumns extends AnyColumns> = (keyof TColumns & string)[] | Omit<ConflictUpdate<TColumns>, 'where'>

/** Write coordinator — delegates to the deep `WritePipeline`. */
export class WriteSuite<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  private _pipeline: WritePipeline<TColumns, TVirtuals>
  private _rt: TableRuntime

  constructor(
    _exec: Executable,
    _rt: TableRuntime,
    hooks: HookContext,
    tableRegistry?: ReadonlyMap<string, AnyTableDef>,
  ) {
    this._pipeline = new WritePipeline<TColumns, TVirtuals>({ executor: _exec, runtime: _rt, hooks, tableRegistry })
    this._rt = _rt
  }

  /** `skipConflicts` answers `null` when the row clashed with an existing one and was skipped. */
  async insertOne(values: InferInsert<TColumns>, opts: InsertOptions<TColumns> & { skipConflicts: (keyof TColumns & string)[], pk: true }): Promise<InferPrimaryKey<TColumns> | null>
  async insertOne(values: InferInsert<TColumns>, opts: InsertOptions<TColumns> & { skipConflicts: (keyof TColumns & string)[], pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async insertOne(values: InferInsert<TColumns>): Promise<WithVirtuals<TColumns, TVirtuals>>
  async insertOne(values: InferInsert<TColumns>, opts: { pk: true }): Promise<InferPrimaryKey<TColumns>>
  async insertOne(values: InferInsert<TColumns>, opts?: InsertOptions<TColumns>): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.insertOne(values, opts)
  }

  /** `skipConflicts` leaves out the rows clashing with existing ones, answering only those inserted. */
  async insertMany(values: InferInsert<TColumns>[], opts: InsertOptions<TColumns> & Unreturned): Promise<void>
  async insertMany(values: InferInsert<TColumns>[], opts?: InsertOptions<TColumns> & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async insertMany(values: InferInsert<TColumns>[], opts: InsertOptions<TColumns> & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async insertMany(values: InferInsert<TColumns>[], opts?: InsertOptions<TColumns>): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.insertMany(values, opts))
  }

  /**
   * Load rows through Postgres `COPY ... FROM STDIN`, far faster than `insertMany` for a bulk load, streaming an async iterable without holding it in memory; resolves to the row count.
   * Skips hooks like the statement builders, and returns no rows. Every row sets the columns the first one sets, the others taking their DEFAULT.
   */
  async copyFrom(rows: Iterable<InferInsert<TColumns>> | AsyncIterable<InferInsert<TColumns>>): Promise<number> {
    return this._pipeline.copyFrom(rows)
  }

  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, opts: UpdateOptions & Unreturned): Promise<void>
  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, opts?: UpdateOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, opts: UpdateOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.updateMany(set, where, opts))
  }

  /** Update the first row the WHERE matches, by primary key; `onMany: 'throw'` throws `MultipleRowsError` instead when several match. */
  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, opts?: UpdateOptions & SingleRowOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, opts: UpdateOptions & SingleRowOptions & { pk: true }): Promise<InferPrimaryKey<TColumns> | null>
  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, opts?: UpdateOptions & SingleRowOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.updateOne(set, where, opts)
  }

  /** Update the row with this primary key. A composite key takes an object holding each part. */
  async updateById(id: unknown, set: InferUpdate<TColumns>, opts?: UpdateOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async updateById(id: unknown, set: InferUpdate<TColumns>, opts: UpdateOptions & { pk: true }): Promise<InferPrimaryKey<TColumns> | null>
  async updateById(id: unknown, set: InferUpdate<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.updateById(set, this._rt.pkWhere(id) as Where<TColumns>, opts)
  }

  /** Update many rows in one statement, each with its own values: `updateManyById([{ id: 1, position: 0 }, { id: 2, position: 1 }])`. Rows may write different columns; a row whose key matches nothing is skipped. */
  async updateManyById(rows: InferUpdateById<TColumns>[], opts?: UpdateOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async updateManyById(rows: InferUpdateById<TColumns>[], opts: UpdateOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async updateManyById(rows: InferUpdateById<TColumns>[], opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._pipeline.updateManyById(rows as Record<string, unknown>[], opts)
  }

  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, currentVersion: number, opts?: UpdateOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>>
  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, currentVersion: number, opts: UpdateOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>>
  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns, TRelations>, currentVersion: number, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    return this._pipeline.updateWithLock(set, where, currentVersion, opts)
  }

  async deleteMany(where: Where<TColumns, TRelations>, opts: ScopedWriteOptions & Unreturned): Promise<void>
  async deleteMany(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async deleteMany(where: Where<TColumns, TRelations>, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async deleteMany(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.deleteMany(where, opts))
  }

  /** Delete the first row the WHERE matches, by primary key; `onMany: 'throw'` throws `MultipleRowsError` instead when several match. */
  async deleteOne(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions & SingleRowOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async deleteOne(where: Where<TColumns, TRelations>, opts: ScopedWriteOptions & SingleRowOptions & { pk: true }): Promise<InferPrimaryKey<TColumns> | null>
  async deleteOne(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions & SingleRowOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.deleteOne(where, opts)
  }

  /** Delete the row with this primary key. A composite key takes an object holding each part. */
  async deleteById(id: unknown, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async deleteById(id: unknown, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns> | null>
  async deleteById(id: unknown, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.deleteById(this._rt.pkWhere(id) as Where<TColumns>, opts)
  }

  /**
   * Insert rows, updating each one that conflicts on `conflictTarget`. `update` lists the columns to copy from the incoming row (default: all of them), or is a `ConflictUpdate`:
   * `set` computes columns from the existing row (`u => ({ visits: u.add(u.existing('visits'), 1) })`) and `where` guards the update, a row it skips being left out of the result.
   */
  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], update: UpsertUpdate<TColumns> | undefined, opts: ScopedWriteOptions & Unreturned): Promise<void>
  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], update?: UpsertUpdate<TColumns>, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], update: UpsertUpdate<TColumns> | undefined, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async upsertMany(values: InferInsert<TColumns>[], conflictTarget: (keyof TColumns & string)[], update?: UpsertUpdate<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.upsertMany(values, conflictTarget, update, opts))
  }

  /** Single-row `upsertMany`. With a `where` guard it returns `null` when the guard skipped the update. */
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update: GuardedUpsert<TColumns>, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals> | null>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update: GuardedUpsert<TColumns>, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns> | null>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update?: UnguardedUpsert<TColumns>, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update: UnguardedUpsert<TColumns> | undefined, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>>
  async upsertOne(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], update?: UpsertUpdate<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    return this._pipeline.upsertOne(values, conflictTarget, update, opts)
  }

  /** The row holding `values`' conflict key, inserted when missing; `created` says which. A trashed row is restored. */
  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[]): Promise<{ row: WithVirtuals<TColumns, TVirtuals>, created: boolean }> {
    return this._pipeline.findOrCreate(values, conflictTarget)
  }

  async restore(where: Where<TColumns, TRelations>, opts: ScopedWriteOptions & Unreturned): Promise<void>
  async restore(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async restore(where: Where<TColumns, TRelations>, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async restore(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.restore(where, opts))
  }

  /** Delete every row, trashing them on a soft-delete table. `deleteMany` refuses a missing WHERE, so clearing a table is spelled out. */
  async deleteAll(opts: ScopedWriteOptions & Unreturned): Promise<void>
  async deleteAll(opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async deleteAll(opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async deleteAll(opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.deleteAll(opts))
  }

  async forceDelete(where: Where<TColumns, TRelations>, opts: ScopedWriteOptions & Unreturned): Promise<void>
  async forceDelete(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async forceDelete(where: Where<TColumns, TRelations>, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async forceDelete(where: Where<TColumns, TRelations>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.forceDelete(where, opts))
  }

  /** Hard-delete the trashed rows of a soft-delete table whose trait column is older than `olderThan`, leaving live rows alone: how trashed rows expire. */
  async purgeTrashed(olderThan: Date, opts: ScopedWriteOptions & Unreturned): Promise<void>
  async purgeTrashed(olderThan: Date, opts?: ScopedWriteOptions & { pk?: false }): Promise<WithVirtuals<TColumns, TVirtuals>[]>
  async purgeTrashed(olderThan: Date, opts: ScopedWriteOptions & { pk: true }): Promise<InferPrimaryKey<TColumns>[]>
  async purgeTrashed(olderThan: Date, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[] | void> {
    return unreturned(opts, await this._pipeline.purgeTrashed(olderThan, opts))
  }

  // Builder accessors — skip the hook/trait dispatch applied by the methods above.
  insert(): InsertBuilder<TColumns> { return new InsertBuilder<TColumns>(this._rt.table) }
  update(): UpdateBuilder<TColumns> { return new UpdateBuilder<TColumns>(this._rt.table) }
  delete(): DeleteBuilder<TColumns> { return new DeleteBuilder<TColumns>(this._rt.table) }
  merge(): MergeBuilder<TColumns> { return new MergeBuilder<TColumns>(this._rt.table) }
}
