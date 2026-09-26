import type { BulkUpdateRow } from '../builder/bulk-update'
import type { ConflictSet, ConflictValue } from '../builder/conflict'
import type { ConflictUpdate } from '../builder/insert'
import type { WhereInput } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyVirtuals, InferInsert, InferPrimaryKey, InferUpdate, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { BulkUpdateBuilder } from '../builder/bulk-update'
import { compileWhere, DeleteBuilder as DeleteBuilderCtor, InsertBuilder as InsertBuilderCtor, SelectBuilder as SelectBuilderCtor, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { StaleRecordError, ValidationError } from '../errors/index'
import { mapChunk } from '../mapper/index'
import { jsonParam } from '../sql/json-param'
import { createMapperFactory } from './_mapper'

type Where<TColumns extends AnyColumns> = WhereInput<TColumns>

/** An upsert's conflict update: the columns to copy from the incoming row, or the full `ConflictUpdate`. */
export type UpsertUpdate<TColumns extends AnyColumns> = (keyof TColumns & string)[] | ConflictUpdate<TColumns>

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
  private _mapperFactory: ReturnType<typeof createMapperFactory>

  constructor(ctx: WritePipelineContext) {
    this._executor = ctx.executor
    this._runtime = ctx.runtime
    this._mapperFactory = createMapperFactory(this._runtime.table)
  }

  /**
   * Mark json/jsonb values before parameter binding. bun:sql's unsafe() path does not
   * know column types, and serializeParams() would otherwise turn every JS array into a
   * PostgreSQL array literal (e.g. {"a","b"}), which is not JSON. Marking them leaves the
   * value untouched all the way to the driver, which encodes it to JSON itself - stringifying
   * here instead would arrive as a string and be encoded a second time, storing a JSON string
   * scalar that reads back correctly and answers `string` to jsonb_typeof.
   */
  private _normalizeJsonValues(values: Record<string, unknown>): Record<string, unknown> {
    const cols = this._runtime.table.columns
    const out: Record<string, unknown> = {}

    for (const [key, val] of Object.entries(values)) {
      const col = cols[key]

      if (
        col
        && (col.pgType === 'json' || col.pgType === 'jsonb')
        && val !== null
        && val !== undefined
        && (Array.isArray(val) || typeof val === 'object')
      ) {
        out[key] = jsonParam(val)
      }
      else {
        out[key] = val
      }
    }

    return out
  }

  // --- Insert ---

  async insertOne(values: InferInsert<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    const v = this._normalizeJsonValues(await this._runtime.runBefore('beforeInsert', values) as Record<string, unknown>) as InferInsert<TColumns>
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

    const v = (await this._runtime.runBeforeMany('beforeInsert', values))
      .map(row => this._normalizeJsonValues(row as Record<string, unknown>)) as InferInsert<TColumns>[]
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
    const s = this._normalizeJsonValues(await this._runtime.runBefore('beforeUpdate', set) as Record<string, unknown>) as InferUpdate<TColumns>
    const builder = new UpdateBuilderCtor<TColumns>(this._runtime.table.name)
      .set(s)
      .where(where)

    this._runtime.behavior.prepareUpdate(builder, s)

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
    const lockCol = this._runtime.behavior.getOptimisticLockColumn()

    if (!lockCol) {
      throw new ValidationError(
        'updateWithLock requires optimisticLock trait on table',
        'updateWithLock',
        { field: this._runtime.table.name },
      )
    }

    const rows = await this.updateMany(
      set,
      e => e.and(compileWhere<TColumns>(where), e.eq(lockCol, currentVersion)),
      opts,
    )

    if (rows.length === 0)
      throw new StaleRecordError(this._runtime.table.name, currentVersion)

    return rows[0]!
  }

  async updateManyById(rows: Record<string, unknown>[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (rows.length === 0)
      return []

    const { pkColumns, table } = this._runtime
    const seen = new Set<string>()
    const prepared: BulkUpdateRow[] = []

    for (const row of rows) {
      const key: Record<string, unknown> = {}
      const patch: Record<string, unknown> = {}

      for (const [col, value] of Object.entries(row))
        (pkColumns.includes(col) ? key : patch)[col] = value

      for (const col of pkColumns) {
        if (key[col] === undefined || key[col] === null)
          throw new ValidationError(`updateManyById(): a row on "${table.name}" is missing its primary key "${col}".`, 'updateManyById', { field: col, value: row })
      }

      // Two patches for one row would leave which one wins up to the planner.
      const identity = pkColumns.map(col => `${col}=${String(key[col])}`).join(', ')

      if (seen.has(identity))
        throw new ValidationError(`updateManyById(): the row ${identity} on "${table.name}" appears twice.`, 'updateManyById', { value: key })

      seen.add(identity)
      prepared.push({ key, set: this._normalizeJsonValues(await this._runtime.runBefore('beforeUpdate', patch)) })
    }

    const builder = new BulkUpdateBuilder(table.name, table.columns, [...pkColumns], prepared)

    this._runtime.behavior.prepareUpdate(builder, {})

    return this._execute({
      builder,
      afterEvent: 'afterUpdate',
      project: result => this._projectMany(result, opts),
      opts,
    })
  }

  // --- Delete ---

  async deleteMany(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    await this._runtime.runBefore('beforeDelete', undefined)

    // A soft delete is an UPDATE, so it runs the update path: `beforeUpdate` hooks (timestamps) and the version bump.
    const softSet = this._runtime.behavior.softDeleteSet<TColumns>()
    const builder = softSet
      ? this._runtime.behavior.rewriteDelete(await this._runtime.runBefore('beforeUpdate', softSet), where)
      : new DeleteBuilderCtor<TColumns>(this._runtime.table.name).where(where)

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
    update?: UpsertUpdate<TColumns>,
    opts?: WriteReturnOptions,
  ): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    const v = (await this._runtime.runBeforeMany('beforeUpsert', values))
      .map(row => this._normalizeJsonValues(row as Record<string, unknown>)) as InferInsert<TColumns>[]
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table.name)
      .many(v)
      .onConflict(conflictTarget)
      .doUpdateWith(await this._conflictUpdate(update))

    return this._execute({
      builder,
      afterEvent: 'afterInsert',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  async upsertOne(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
    update?: UpsertUpdate<TColumns>,
    opts?: WriteReturnOptions,
  ): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.upsertMany([values], conflictTarget, update, opts)

    return rows[0] ?? null
  }

  // The row an upsert updates is updated like any other: `beforeUpdate` hooks (timestamps) and the version bump apply to it.
  private async _conflictUpdate(update?: UpsertUpdate<TColumns>): Promise<ConflictUpdate<TColumns>> {
    const spec: ConflictUpdate<TColumns> = Array.isArray(update) ? { columns: update.length ? update : undefined } : update ?? {}
    const hooked = this._normalizeJsonValues(await this._runtime.runBefore('beforeUpdate', {}))
    const lock = this._runtime.behavior.getOptimisticLockColumn()

    if (Object.keys(hooked).length === 0 && !lock)
      return spec

    return {
      ...spec,
      set: u => ({
        ...hooked,
        ...spec.set?.(u),
        ...lock ? { [lock]: u.add(u.existing(lock) as ConflictValue<number>, 1) } : {},
      }) as ConflictSet<TColumns>,
    }
  }

  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    const v = this._normalizeJsonValues(await this._runtime.runBefore('beforeUpsert', values) as Record<string, unknown>) as InferInsert<TColumns>
    // A no-op update on the key so the existing row comes back through RETURNING.
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdate(...this._runtime.pkColumns as (keyof TColumns & string)[])

    return this._execute({
      builder,
      afterEvent: 'afterInsert',
      project: rows => this._projectOne(rows, opts),
      opts,
    })
  }

  // --- Restore ---

  async restore(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const sdCol = this._runtime.behavior.getSoftDeleteColumn()

    if (sdCol === null) {
      throw new ValidationError(
        'restore() requires softDelete trait on table',
        'restore',
        { field: this._runtime.table.name },
      )
    }

    const s = await this._runtime.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>)
    const builder = this._runtime.behavior.buildRestoreUpdate(s, where)

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
    const retCols = args.opts?.full ? [] : [...this._runtime.pkColumns]

    args.builder.returning(...retCols)

    const { sql, params } = args.builder.toSQL()
    const rows = await this._executor.query(sql, params)

    await this._runtime.runAfter(args.afterEvent, rows)

    return args.project(rows)
  }

  private _projectOne(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any {
    if (!opts?.full)
      return this._keys(rows)[0]

    const mapper = this._mapperFactory(new SelectBuilderCtor(this._runtime.table.name))
    const mapped = mapChunk(mapper, rows)

    return this._runtime.applyVirtuals(mapped)[0]
  }

  private _projectMany(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any[] {
    if (!opts?.full)
      return this._keys(rows)

    const mapper = this._mapperFactory(new SelectBuilderCtor(this._runtime.table.name))
    const mapped = mapChunk(mapper, rows)

    return this._runtime.applyVirtuals(mapped)
  }

  // Keys go through the row mapper like any read, so a bigserial key comes back as a bigint; a composite key is an object holding each part.
  private _keys(rows: Record<string, unknown>[]): unknown[] {
    const { pkColumns, table } = this._runtime
    const mapped = mapChunk(this._mapperFactory(new SelectBuilderCtor<AnyColumns>(table.name).pick(...pkColumns)), rows)

    if (pkColumns.length === 1)
      return mapped.map(row => row[pkColumns[0]!])

    return mapped.map(row => Object.fromEntries(pkColumns.map(col => [col, row[col]])))
  }
}
