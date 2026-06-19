import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyVirtuals, InferInsert, InferPrimaryKey, InferUpdate, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { DeleteBuilder as DeleteBuilderCtor, InsertBuilder as InsertBuilderCtor, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { StaleRecordError, ValidationError } from '../errors/index'

type Where<TColumns extends AnyColumns> = (e: ExprBuilder<TColumns>) => ExprTape

/** Builder surface the pipeline needs to set RETURNING and compile. */
interface ReturnableBuilder {
  returning: (...cols: string[]) => this
  toSQL: () => { sql: string, params: unknown[] }
}

/** Frozen dependencies for a single write pipeline. */
export interface WritePipelineContext {
  executor: Executable
  runtime: TableRuntime
}

/**
 * Deep module that owns the entire write-operation lifecycle.
 *
 * One pipeline per repository/table hides: hook selection and timing, RETURNING
 * projection, builder construction, trait-transform ordering, soft-delete rewrite,
 * execution, virtual installation, and primary-key extraction.
 */
export class WritePipeline<
  TColumns extends AnyColumns,
  TVirtuals extends AnyVirtuals = {},
> {
  private _executor: Executable
  private _runtime: TableRuntime

  constructor(ctx: WritePipelineContext) {
    this._executor = ctx.executor
    this._runtime = ctx.runtime
  }

  // --- Insert ---

  async insertOne(values: InferInsert<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    const v = await this._runtime.runBefore('beforeInsert', values)
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table.name).values(v)

    return this._execute({
      builder,
      afterEvent: 'afterInsert',
      project: rows => this._projectOne(rows, opts),
      opts,
    })
  }

  async insertMany(values: InferInsert<TColumns>[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    const v = await this._runtime.runBeforeMany('beforeInsert', values)
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table.name).many(v)

    return this._execute({
      builder,
      afterEvent: 'afterInsert',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  // --- Update ---

  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const s = await this._runtime.runBefore('beforeUpdate', set)
    const builder = new UpdateBuilderCtor<TColumns>(this._runtime.table.name)
      .set(s)
      .where(where)

    // Trait middleware MUST run after `.set()` so user payloads can't smuggle
    // `__raw` through and the version bump itself bypasses validation.
    this._runtime.applyPreUpdate(builder)

    return this._execute({
      builder,
      afterEvent: 'afterUpdate',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.updateMany(set, where, opts)

    return rows[0] ?? null
  }

  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns>, currentVersion: number, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    const lockCol = this._runtime.optimisticLockColumn

    if (!lockCol) {
      throw new ValidationError(
        'updateWithLock requires optimisticLock trait on table',
        'updateWithLock',
        { field: this._runtime.table.name },
      )
    }

    const rows = await this.updateMany(
      set,
      e => e.and(where(e), e.eq(lockCol, currentVersion)),
      opts,
    )

    if (rows.length === 0)
      throw new StaleRecordError(this._runtime.table.name, currentVersion)

    return rows[0]!
  }

  // --- Delete ---

  async deleteMany(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    await this._runtime.runBefore('beforeDelete', undefined)

    const rewritten = this._runtime.rewriteDelete(where)
    const builder = rewritten ?? new DeleteBuilderCtor<TColumns>(this._runtime.table.name).where(where)

    return this._execute({
      builder,
      afterEvent: 'afterDelete',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  async deleteOne(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.deleteMany(where, opts)

    return rows[0] ?? null
  }

  async forceDelete(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    await this._runtime.runBefore('beforeDelete', undefined)

    const builder = new DeleteBuilderCtor<TColumns>(this._runtime.table.name).where(where)

    return this._execute({
      builder,
      afterEvent: 'afterDelete',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  // --- Upsert ---

  async upsertMany(
    values: InferInsert<TColumns>[],
    conflictTarget: (keyof TColumns & string)[],
    updateColumns?: (keyof TColumns & string)[],
    opts?: WriteReturnOptions,
  ): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    const v = await this._runtime.runBeforeMany('beforeUpsert', values)
    const ib = new InsertBuilderCtor<TColumns>(this._runtime.table.name).many(v)
    const conflict = ib.onConflict(conflictTarget)
    const builder = updateColumns?.length
      ? conflict.doUpdate(...updateColumns)
      : conflict.doUpdate()

    return this._execute({
      builder,
      afterEvent: 'afterInsert',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    const v = await this._runtime.runBefore('beforeUpsert', values)
    const pk = this._runtime.primaryKey
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdate(pk as keyof TColumns & string)

    return this._execute({
      builder,
      afterEvent: 'afterInsert',
      project: rows => this._projectOne(rows, opts),
      opts,
    })
  }

  // --- Restore ---

  async restore(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const sdCol = this._runtime.requireSoftDeleteColumn('restore()')

    const s = await this._runtime.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>)
    const builder = new UpdateBuilderCtor<TColumns>(this._runtime.table.name)
      .set(s)
      .where((e: ExprBuilder<TColumns>) => e.and(where(e), e.isNotNull(sdCol)))

    this._runtime.applyPreUpdate(builder)

    return this._execute({
      builder,
      afterEvent: 'afterUpdate',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  // --- Shared execution path ---

  private async _execute<TResult>(args: {
    builder: ReturnableBuilder
    afterEvent: 'afterInsert' | 'afterUpdate' | 'afterDelete'
    project: (rows: Record<string, unknown>[]) => TResult
    opts?: WriteReturnOptions
  }): Promise<TResult> {
    const retCols = args.opts?.full ? [] : [this._runtime.primaryKey]

    args.builder.returning(...retCols)

    const { sql, params } = args.builder.toSQL()
    const rows = await this._executor.query(sql, params)

    await this._runtime.runAfter(args.afterEvent, rows)

    return args.project(rows)
  }

  private _projectOne(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any {
    return opts?.full
      ? this._runtime.applyVirtuals(rows)[0]
      : rows[0]![this._runtime.primaryKey]
  }

  private _projectMany(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any[] {
    return opts?.full
      ? this._runtime.applyVirtuals(rows)
      : rows.map(r => r[this._runtime.primaryKey])
  }
}
