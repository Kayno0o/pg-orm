import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { AnyColumns, AnyRelations, AnyVirtuals, InferInsert, InferPrimaryKey, InferUpdate, WithVirtuals } from '../types/index'
import type { RepositoryCtx } from './context'
import { DeleteBuilder, InsertBuilder, MergeBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { StaleRecordError, ValidationError } from '../errors/index'
import { requireSoftDeleteColumn } from './traits'
import { applyVirtuals } from './virtuals'

/**
 * Write operations — `insert*`, `update*`, `delete*`, `upsertMany`, `findOrCreate`,
 * `restore`, `forceDelete`, plus the `insert()`/`update()`/`delete()`/`merge()`/
 * `upsert()` builder accessors. Created lazily on first access via `repo.write`.
 */
export class WriteSuite<
  TColumns extends AnyColumns,
  _TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  constructor(private _ctx: RepositoryCtx) {}

  /** Insert a single row and return the primary key of the inserted record. */
  async insertOne(values: InferInsert<TColumns>): Promise<InferPrimaryKey<TColumns>> {
    const v = await this._ctx.hooks.runBefore('beforeInsert', values)

    const pk = this._ctx.getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._ctx.table.name)
      .values(v)
      .returning(pk)
    const { sql, params } = b.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterInsert', rows)

    return rows[0]![pk] as InferPrimaryKey<TColumns>
  }

  /** Insert multiple rows in a single query and return the primary keys of the inserted records. */
  async insertMany(values: InferInsert<TColumns>[]): Promise<InferPrimaryKey<TColumns>[]> {
    if (values.length === 0)
      return []

    const v = await this._ctx.hooks.runBeforeMany('beforeInsert', values)

    const pk = this._ctx.getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._ctx.table.name)
      .many(v)
      .returning(pk)
    const { sql, params } = b.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterInsert', rows)

    return rows.map(r => r[pk]) as InferPrimaryKey<TColumns>[]
  }

  /** Update all rows matching `where` and return the updated records. */
  async updateMany(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const s = await this._ctx.hooks.runBefore('beforeUpdate', set)

    const b = new UpdateBuilder<TColumns>(this._ctx.table.name)
      .set(s)
      .where(where)
      .returning()

    // `applyPreUpdate` runs trait middleware (e.g. optimistic-lock version bump
    // via `setRaw()`) AFTER `.set()`'s `validateValues` check, so user payloads
    // can't smuggle `__raw` through and the version bump itself bypasses validation.
    this._ctx.traits.applyPreUpdate(b)

    const { sql, params } = b.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterUpdate', rows)

    const withVirtuals = applyVirtuals(this._ctx.table, rows, this._ctx.virtualsCache)

    return withVirtuals as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Update the first matching row and return it, or `null` if none matched. */
  async updateOne(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.updateMany(set, where)

    return rows[0] ?? null
  }

  /** Optimistic-lock update — adds WHERE version = $current, throws StaleRecordError if 0 rows affected. */
  async updateWithLock(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
    currentVersion: number,
  ): Promise<WithVirtuals<TColumns, TVirtuals>> {
    const lockCol = this._ctx.traits.getOptimisticLockColumn()

    if (!lockCol) {
      throw new ValidationError(
        'updateWithLock requires optimisticLock trait on table',
        'updateWithLock',
        { field: this._ctx.table.name },
      )
    }

    const rows = await this.updateMany(set, e =>
      e.and(where(e), e.eq(lockCol, currentVersion)))

    if (rows.length === 0) {
      throw new StaleRecordError(this._ctx.table.name, currentVersion)
    }

    return rows[0] as WithVirtuals<TColumns, TVirtuals>
  }

  /** Delete all rows matching `where`. Uses soft-delete if the trait is applied. Returns deleted records. */
  async deleteMany(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    await this._ctx.hooks.runBefore('beforeDelete', undefined)

    const b = this._ctx.traits.rewriteDelete<TColumns>(where)
      ?? new DeleteBuilder<TColumns>(this._ctx.table.name).where(where).returning()
    const { sql, params } = b.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterDelete', rows)

    return applyVirtuals(this._ctx.table, rows, this._ctx.virtualsCache) as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Delete the first matching row. Returns the deleted record or `null`. */
  async deleteOne(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.deleteMany(where)

    return rows[0] ?? null
  }

  /** Bulk upsert: insert rows, update on conflict. Returns all affected records. */
  async upsertMany(
    values: InferInsert<TColumns>[],
    conflictTarget: (keyof TColumns & string)[],
    updateColumns?: (keyof TColumns & string)[],
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    const v = await this._ctx.hooks.runBeforeMany('beforeUpsert', values)

    const ib = new InsertBuilder<TColumns>(this._ctx.table.name).many(v)
    const conflict = ib.onConflict(conflictTarget)
    const resolved = updateColumns?.length ? conflict.doUpdate(...updateColumns) : conflict.doUpdate()
    const final = resolved.returning()
    const { sql, params } = final.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterInsert', rows)

    applyVirtuals(this._ctx.table, rows, this._ctx.virtualsCache)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Insert a row or return the existing one if conflict target matches. */
  async findOrCreate(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
  ): Promise<WithVirtuals<TColumns, TVirtuals>> {
    const v = await this._ctx.hooks.runBefore('beforeUpsert', values)

    const pk = this._ctx.getPrimaryKey()
    const b = new InsertBuilder<TColumns>(this._ctx.table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdate(pk as keyof TColumns & string)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterInsert', rows)

    return applyVirtuals(this._ctx.table, rows, this._ctx.virtualsCache)[0] as WithVirtuals<TColumns, TVirtuals>
  }

  /** Restore soft-deleted records: sets the soft-delete column to NULL. */
  async restore(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const sdCol = requireSoftDeleteColumn(this._ctx.table, 'restore()')

    const s = await this._ctx.hooks.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>)

    const b = new UpdateBuilder<TColumns>(this._ctx.table.name)
      .set(s)
      .where((e: ExprBuilder<TColumns>) =>
        e.and(where(e), e.isNotNull(sdCol)))
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterUpdate', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  /** Force-delete: bypass soft-delete and run a real DELETE. */
  async forceDelete(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    await this._ctx.hooks.runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._ctx.table.name)
      .where(where)
      .returning()
    const { sql, params } = b.toSQL()
    const rows = await this._ctx.query(sql, params)

    await this._ctx.hooks.runAfter('afterDelete', rows)

    return rows as WithVirtuals<TColumns, TVirtuals>[]
  }

  // Builder accessors for advanced usage — skip the convenience hooks/trait dispatch
  // applied by the methods above. Use when you need fine-grained control over the
  // emitted SQL (e.g. RETURNING columns, ON CONFLICT clauses, MERGE branches).

  /** Builder accessor for advanced INSERT (custom RETURNING, ON CONFLICT, …). */
  insert(): InsertBuilder<TColumns> {
    return new InsertBuilder<TColumns>(this._ctx.table.name)
  }

  /** Builder accessor for advanced UPDATE (custom RETURNING, FROM, …). */
  update(): UpdateBuilder<TColumns> {
    return new UpdateBuilder<TColumns>(this._ctx.table.name)
  }

  /** Builder accessor for advanced DELETE (custom USING, RETURNING, …). */
  delete(): DeleteBuilder<TColumns> {
    return new DeleteBuilder<TColumns>(this._ctx.table.name)
  }

  /** Builder accessor for `MERGE INTO` (`WHEN MATCHED` / `WHEN NOT MATCHED` branches). */
  merge(): MergeBuilder<TColumns> {
    return new MergeBuilder<TColumns>(this._ctx.table.name)
  }

  /** Builder accessor for explicit upsert (`INSERT ... ON CONFLICT ... DO UPDATE`). */
  upsert(): UpsertBuilder<TColumns> {
    return new UpsertBuilder<TColumns>(this._ctx.table.name)
  }
}
