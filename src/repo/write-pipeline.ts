import type { BulkUpdateRow } from '../builder/bulk-update'
import type { ConflictSet, ConflictValue } from '../builder/conflict'
import type { ConflictUpdate } from '../builder/insert'
import type { WhereInput } from '../builder/query'
import type { Dialect } from '../dialect'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyVirtuals, InferInsert, InferPrimaryKey, InferUpdate, UpdateOptions, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { BulkUpdateBuilder } from '../builder/bulk-update'
import { isConflictValue } from '../builder/conflict'
import { compileWhere, DeleteBuilder as DeleteBuilderCtor, InsertBuilder as InsertBuilderCtor, SelectBuilder as SelectBuilderCtor, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { dialectOf } from '../dialect'
import { StaleRecordError, ValidationError } from '../errors/index'
import { hasHooks } from '../hooks/index'
import { mapChunk } from '../mapper/index'
import { sqliteInsertDefaults } from '../schema/column-default'
import { jsonParam } from '../sql/json-param'
import { createMapperFactory } from './_mapper'

type Where<TColumns extends AnyColumns> = WhereInput<TColumns>

/** An upsert's conflict update: the columns to copy from the incoming row, or the full `ConflictUpdate`. */
export type UpsertUpdate<TColumns extends AnyColumns> = (keyof TColumns & string)[] | ConflictUpdate<TColumns>

/** Builder surface the pipeline needs to set RETURNING and compile. */
interface ReturnableBuilder {
  returning: (...cols: string[]) => this
  toSQL: (dialect?: Dialect) => { sql: string, params: unknown[] }
}

// The builders read a falsy WHERE as "no WHERE", which on a write is every row: only `deleteAll` may ask for that, by name.
function requireWhere<T>(where: T, op: string): T {
  if (!where)
    throw new ValidationError(`${op}() needs a WHERE: a missing one would reach every row (deleteAll() clears a table on purpose).`, op, { value: where })

  return where
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
  private _sqliteDefaults?: Record<string, string>

  constructor(ctx: WritePipelineContext) {
    this._executor = ctx.executor
    this._runtime = ctx.runtime
    this._mapperFactory = createMapperFactory(this._runtime.table, dialectOf(ctx.executor))
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

  // A SQLite multi-row insert spells out the default of each column a row leaves out.
  private _insertMany(rows: InferInsert<TColumns>[]): InsertBuilderCtor<TColumns> {
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table.name).many(rows)

    if (dialectOf(this._executor) === 'sqlite')
      builder.getState().defaultSql = this._sqliteDefaults ??= sqliteInsertDefaults(this._runtime.table.columns)

    return builder
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
    const builder = this._insertMany(v)

    return this._execute({
      builder,
      afterEvent: 'afterInsert',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  // --- Update ---

  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    requireWhere(where, 'updateMany')

    const s = this._normalizeJsonValues(await this._runtime.runBefore('beforeUpdate', set) as Record<string, unknown>) as InferUpdate<TColumns>
    const builder = new UpdateBuilderCtor<TColumns>(this._runtime.table.name)
      .set(s)
      .where(where)

    this._runtime.behavior.prepareUpdate(builder, s)
    this._runtime.behavior.excludeTrashed(builder, opts?.withTrashed)

    return this._execute({
      builder,
      afterEvent: 'afterUpdate',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.updateMany(set, where, opts)

    return rows[0] ?? null
  }

  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns>, currentVersion: number, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
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

  async updateManyById(rows: Record<string, unknown>[], opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
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
    this._runtime.behavior.excludeTrashed(builder, opts?.withTrashed)

    return this._execute({
      builder,
      afterEvent: 'afterUpdate',
      project: result => this._projectMany(result, opts),
      opts,
    })
  }

  // --- Delete ---

  async deleteMany(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._delete(requireWhere(where, 'deleteMany'), false, opts)
  }

  async deleteOne(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.deleteMany(where, opts)

    return rows[0] ?? null
  }

  async deleteAll(opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._delete(null, false, opts)
  }

  async forceDelete(where: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._delete(requireWhere(where, 'forceDelete'), true, opts)
  }

  // A `null` where is every row, which only `deleteAll` passes.
  private async _delete(where: Where<TColumns> | null, force: boolean, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    await this._runtime.runBefore('beforeDelete', undefined)

    // A soft delete is an UPDATE, so it runs the update path: `beforeUpdate` hooks (timestamps) and the version bump.
    const softSet = force ? null : this._runtime.behavior.softDeleteSet<TColumns>()
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
    const builder = this._insertMany(v)
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
    const hooked = await this._runtime.runBefore('beforeUpdate', {})
    const lock = this._runtime.behavior.getOptimisticLockColumn()

    if (!spec.set && Object.keys(hooked).length === 0 && !lock)
      return spec

    return {
      ...spec,
      set: (u) => {
        const set: Record<string, unknown> = { ...hooked, ...spec.set?.(u) }

        if (lock)
          set[lock] = u.add(u.existing(lock) as ConflictValue<number>, 1)

        // Plain values are bound like any write's, so a json value is marked; an expression is left to render itself.
        for (const [col, value] of Object.entries(set)) {
          if (!isConflictValue(value))
            Object.assign(set, this._normalizeJsonValues({ [col]: value }))
        }

        return set as ConflictSet<TColumns>
      },
    }
  }

  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    const v = this._normalizeJsonValues(await this._runtime.runBefore('beforeUpsert', values) as Record<string, unknown>) as InferInsert<TColumns>
    // A no-op update of the key to its own value, so the existing row comes back through RETURNING. `EXCLUDED` would hold the incoming row's key, a serial's next value.
    const pkColumns = this._runtime.pkColumns as (keyof TColumns & string)[]
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdateWith({ columns: [], set: u => Object.fromEntries(pkColumns.map(col => [col, u.existing(col)])) as ConflictSet<TColumns> })

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
    const { pkColumns, table } = this._runtime
    // After-write hooks get the whole mapped row, as afterSelect does, so a hooked table returns every column even when the caller only wants keys.
    const whole = args.opts?.full || hasHooks(table, args.afterEvent)
    const shape = new SelectBuilderCtor<AnyColumns>(table.name)

    args.builder.returning(...whole ? [] : pkColumns)

    const { sql, params } = args.builder.toSQL(dialectOf(this._executor))
    const rows = mapChunk(this._mapperFactory(whole ? shape : shape.pick(...pkColumns)), await this._executor.query(sql, params))

    await this._runtime.runAfter(args.afterEvent, rows)

    return args.project(rows)
  }

  // `rows` arrive mapped; the full form installs virtuals.
  private _projectOne(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any {
    return this._projectMany(rows.slice(0, 1), opts)[0]
  }

  private _projectMany(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any[] {
    return opts?.full ? this._runtime.applyVirtuals(rows) : this._keys(rows)
  }

  // A composite key is an object holding each part.
  private _keys(rows: Record<string, unknown>[]): unknown[] {
    const { pkColumns } = this._runtime

    if (pkColumns.length === 1)
      return rows.map(row => row[pkColumns[0]!])

    return rows.map(row => Object.fromEntries(pkColumns.map(col => [col, row[col]])))
  }
}
