import type { ExprTape } from '../builder/_tape'
import type { BulkUpdateRow } from '../builder/bulk-update'
import type { WhereInput } from '../builder/query'
import type { Dialect } from '../dialect'
import type { Executable } from '../sql/executor'
import type { TransactionClient } from '../sql/transaction'
import type { AnyColumns, AnyTableDef, AnyVirtuals, ColumnConstraint, HookContext, InferInsert, InferPrimaryKey, InferUpdate, InsertOptions, ScopedWriteOptions, SingleRowOptions, UpdateOptions, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import type { FindOrCreateOptions, UpsertOptions } from './upsert'
import { holdsForEveryRow, OP_AND, OP_EQ, OP_IN_SUBQUERY, OP_NOT, OP_OR, OP_SCALAR } from '../builder/_tape'
import { BulkUpdateBuilder } from '../builder/bulk-update'
import { compileWhere, DeleteBuilder as DeleteBuilderCtor, InsertBuilder as InsertBuilderCtor, SelectBuilder as SelectBuilderCtor, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { columnValue } from '../builder/state'
import { MAX_BIND_PARAMS, SOFT_DELETE_SCOPE, STATEMENT_PARAM_RESERVE } from '../constants'
import { dialectOf, requirePostgres } from '../dialect'
import { MultipleRowsError, NotFoundError, OrmError, StaleRecordError, ValidationError } from '../errors/index'
import { hasHooks } from '../hooks/index'
import { mapChunk } from '../mapper/index'
import { sqliteInsertDefaults } from '../schema/column-default'
import { columnOf } from '../schema/inspect'
import { chunks } from '../utils/collection'
import { quote } from '../utils/quote'
import { createMapperFactory } from './_mapper'
import { copyChunks, copyColumns } from './copy-from'
import { resolveRelationFilters } from './relation-filter'
import { liftedScopes } from './table-behavior'
import { assertKeyValue, isKeyValue } from './table-runtime'
import { conflictUpdate, insertedClassifier, skipConflicts, updateHookedRows } from './upsert'

type Where<TColumns extends AnyColumns> = WhereInput<TColumns>

export type { FindOrCreateOptions, UpsertOptions, UpsertUpdate } from './upsert'

const FIND_OR_CREATE_ATTEMPTS = 3

// A single-row write reports whether it changed a row by reading it back, so `returning: false` would make it misreport.
function requireReturning(op: string, opts?: WriteReturnOptions): void {
  if (opts?.returning === false)
    throw new ValidationError(`${op}() reads back the row it writes, so it does not take returning: false (the many-row writes do).`, op, { field: 'returning' })
}

/** Builder surface the pipeline needs to set RETURNING and compile. */
interface ReturnableBuilder {
  returning: (...cols: string[]) => this
  toSQL: (dialect?: Dialect) => { sql: string, params: unknown[] }
}

/** Frozen dependencies for a single write pipeline. */
export interface WritePipelineContext {
  executor: Executable
  runtime: TableRuntime
  hooks: HookContext
  tableRegistry?: ReadonlyMap<string, AnyTableDef>
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
  private _hooks: HookContext
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>
  private _mapperFactory: ReturnType<typeof createMapperFactory>
  private _sqliteDefaults?: Record<string, string>
  // Set on the pipeline a chunked write runs its chunks on: after-write hooks wait for the last chunk and run inside the chunks' transaction, so none fires for rows a later chunk rolls back.
  private _deferredAfter?: [event: 'afterInsert' | 'afterUpdate' | 'afterDelete', rows: Record<string, unknown>[]][]

  constructor(ctx: WritePipelineContext) {
    this._executor = ctx.executor
    this._runtime = ctx.runtime
    this._hooks = ctx.hooks
    this._tableRegistry = ctx.tableRegistry
    this._mapperFactory = createMapperFactory(this._runtime.table, dialectOf(ctx.executor))
  }

  // The builders read a falsy WHERE as "no WHERE", and an empty AND as one every row passes, which on a write is every row: only `deleteAll` may ask for that, by name.
  // The trait conditions ANDed on later would hide an empty clause from the builder's own check, so it is compiled here, once, its relation filters resolved, and handed on as its tape.
  private _requireWhere(where: Where<TColumns>, op: string): Where<TColumns> {
    const tape = where ? compileWhere<TColumns>(where, this._runtime.table.columns) : undefined

    if (!tape || holdsForEveryRow(tape))
      throw new ValidationError(`${op}() needs a WHERE that filters: a missing or empty one would reach every row (deleteAll() clears a table on purpose).`, op)

    return this._resolved(tape)
  }

  private _resolved(tape: ExprTape): Where<TColumns> {
    const resolved = resolveRelationFilters(tape, this._runtime.table, this._runtime.table.name, this._tableRegistry)

    return () => resolved
  }

  /**
   * Each value encoded for its column (`columnValue`: json marked, a vector as its text) before binding.
   * A key that is not a column of the table is refused, so a request body passed as is never writes a quoted identifier the table lacks.
   */
  private _normalizeValues(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const [key, val] of Object.entries(values))
      out[key] = columnValue(columnOf(this._runtime.table, key, 'write').pgType, val)

    return out
  }

  // A SQLite multi-row insert spells out the default of each column a row leaves out.
  private _insertMany(rows: InferInsert<TColumns>[]): InsertBuilderCtor<TColumns> {
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table).many(rows)

    if (dialectOf(this._executor) === 'sqlite')
      builder.getState().defaultSql = this._sqliteDefaults ??= sqliteInsertDefaults(this._runtime.table.columns)

    return builder
  }

  // --- Insert ---

  async insertOne(values: InferInsert<TColumns>, opts?: InsertOptions<TColumns>): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    requireReturning('insertOne', opts)

    const v = this._normalizeValues(await this._runtime.runBefore('beforeInsert', values, this._hooks) as Record<string, unknown>) as InferInsert<TColumns>

    return this._execute({
      builder: skipConflicts(new InsertBuilderCtor<TColumns>(this._runtime.table).values(v), opts),
      afterEvent: 'afterInsert',
      project: rows => this._projectOne(rows, opts) ?? null,
      opts,
    })
  }

  async insertMany(values: InferInsert<TColumns>[], opts?: InsertOptions<TColumns>): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    const v = (await this._runtime.runBeforeMany('beforeInsert', values, this._hooks))
      .map(row => this._normalizeValues(row as Record<string, unknown>)) as InferInsert<TColumns>[]

    return this._chunked(v, (pipeline, rows) => pipeline._execute({
      builder: skipConflicts(pipeline._insertMany(rows), opts),
      afterEvent: 'afterInsert',
      project: written => pipeline._projectMany(written, opts),
      opts,
    }))
  }

  /** Load rows through `COPY ... FROM STDIN`, skipping hooks: the columns the first row sets are the ones every row must set. */
  async copyFrom(rows: Iterable<InferInsert<TColumns>> | AsyncIterable<InferInsert<TColumns>>): Promise<number> {
    requirePostgres(dialectOf(this._executor), 'copyFrom')

    if (!this._executor.copyIn)
      throw new ValidationError('copyFrom needs an executor that runs COPY', 'copyFrom')

    const iterator = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()
    const first = await iterator.next()

    if (first.done)
      return 0

    const table = this._runtime.table
    const columns = copyColumns(table, first.value as Record<string, unknown>)

    return this._executor.copyIn(`COPY ${quote(table.name)} (${columns.map(quote).join(', ')}) FROM STDIN`, copyChunks(table, first.value as Record<string, unknown>, iterator, columns))
  }

  /**
   * Run a multi-row write in statements kept under the bind-parameter limit, all-or-nothing through the executor's `atomic` when it takes several.
   * Results are concatenated in input order.
   */
  private async _chunked<TRow extends object, TResult>(
    rows: TRow[],
    write: (pipeline: WritePipeline<TColumns, TVirtuals>, chunk: TRow[]) => Promise<TResult[]>,
    columns = new Set(rows.flatMap(row => Object.keys(row))).size,
  ): Promise<TResult[]> {
    const budget = MAX_BIND_PARAMS[dialectOf(this._executor)] - STATEMENT_PARAM_RESERVE
    const size = Math.max(1, Math.floor(budget / Math.max(1, columns)))

    if (rows.length <= size)
      return write(this, rows)

    const run = async (exec: Executable): Promise<TResult[]> => {
      const hooks: HookContext = exec === this._executor ? this._hooks : { repo: table => this._hooks.repo(table).using(exec as unknown as TransactionClient) }
      const pipeline = new WritePipeline<TColumns, TVirtuals>({ executor: exec, runtime: this._runtime, hooks, tableRegistry: this._tableRegistry })
      const deferred: NonNullable<typeof this._deferredAfter> = []
      const out: TResult[] = []

      pipeline._deferredAfter = deferred

      for (const chunk of chunks(rows, size))
        out.push(...await write(pipeline, chunk))

      for (const [event, written] of deferred)
        await this._runtime.runAfter(event, written, hooks)

      return out
    }

    return this._executor.atomic ? this._executor.atomic(run) : run(this._executor)
  }

  // --- Update ---

  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const filter = this._requireWhere(where, 'updateMany')
    const s = this._normalizeValues(await this._runtime.runBefore('beforeUpdate', { ...set }, this._hooks) as Record<string, unknown>) as InferUpdate<TColumns>
    const builder = new UpdateBuilderCtor<TColumns>(this._runtime.table)
      .set(s)
      .where(filter)

    this._runtime.behavior.prepareUpdate(builder, s)
    this._runtime.behavior.guardWrite(builder, liftedScopes(opts))

    return this._execute({
      builder,
      afterEvent: 'afterUpdate',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: UpdateOptions & SingleRowOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    requireReturning('updateOne', opts)

    const single = this._singleRow('updateOne', this._requireWhere(where, 'updateOne'), liftedScopes(opts), opts?.onMany)
    const rows = await this.updateMany(set, single.where, opts)

    return rows[0] ?? await single.noMatch()
  }

  /** Update the row a primary key names: the key bounds the statement, so it needs no `_singleRow`. */
  async updateById(set: InferUpdate<TColumns>, key: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    requireReturning('updateById', opts)

    const rows = await this.updateMany(set, key, opts)

    return rows[0] ?? null
  }

  /**
   * The WHERE `updateOne` and `deleteOne` run, reaching one row however many match, and what to answer when it changed none. Rows the table's scopes leave out are passed over unless `lifted`, as the statement itself skips them.
   * By default it is the first match by primary key. With `onMany: 'throw'` it is `where` holding only while exactly one row matches, so several change nothing, and a statement that changed nothing then counts the matches to tell none from several.
   * That count is a second statement: outside a transaction, a row written between the two can make it tell none from several wrongly, though the write itself never reaches more than one row.
   */
  private _singleRow(op: string, where: Where<TColumns>, lifted: string[], onMany?: SingleRowOptions['onMany']): { where: Where<TColumns>, noMatch: () => Promise<null> } {
    const { pkColumns, table } = this._runtime
    const live = <B extends SelectBuilderCtor<TColumns>>(builder: B): B => {
      this._runtime.behavior.prepareSelect(builder)
      builder.withoutScope(...lifted)

      return builder
    }

    // At most one row can match, so the statement itself is bounded: no subquery to pick it, no count to tell none from several.
    if (this._pinsOneRow(where))
      return { where, noMatch: async () => null }

    if (onMany === 'throw') {
      const matches = live(new SelectBuilderCtor<TColumns>(table).count().where(where))

      return {
        where: () => [{ op: OP_AND, count: 2 }, ...compileWhere<TColumns>(where, this._runtime.table.columns), { op: OP_EQ, col: [{ op: OP_SCALAR, subquery: matches }], val: 1 }],
        noMatch: async () => {
          const { sql, params } = matches.toSQL(dialectOf(this._executor))

          if (Number((await this._executor.query(sql, params))[0]?.count ?? 0) > 1)
            throw new MultipleRowsError(table.name, op)

          return null
        },
      }
    }

    this._runtime.requireKey(`${op}()`)

    const first = live(new SelectBuilderCtor<TColumns>(table)
      .pick(...pkColumns as (keyof TColumns & string)[])
      .where(where)
      .limit(1))

    for (const col of pkColumns)
      first.orderBy(col as keyof TColumns & string)

    // `where` is repeated on the statement itself: under READ COMMITTED, a row a concurrent transaction changed is checked again against the outer WHERE only, so the key alone would let two compare-and-set writes both through.
    return { where: () => [{ op: OP_AND, count: 2 }, ...compileWhere<TColumns>(where, this._runtime.table.columns), { op: OP_IN_SUBQUERY, cols: [...pkColumns], subquery: first }], noMatch: async () => null }
  }

  /**
   * Whether the WHERE surely holds for one row at most: its top level is a plain conjunction of single conditions, among them an equality to one value on every primary-key column, or on a column that is unique alone.
   * Anything else (an OR, a NOT, a nested group, an operator, null) answers no, as does a table with no key.
   */
  private _pinsOneRow(where: Where<TColumns>): boolean {
    const { pkColumns, table } = this._runtime
    const tape = compileWhere<TColumns>(where, table.columns)
    const conjuncts = tape[0]?.op === OP_AND ? tape.slice(1) : tape

    if (tape[0]?.op === OP_AND && tape[0].count !== conjuncts.length)
      return false

    const pinned = new Set<string>()

    for (const part of conjuncts) {
      if (part.op === OP_AND || part.op === OP_OR || part.op === OP_NOT)
        return false

      if (part.op === OP_EQ && typeof part.col === 'string' && isKeyValue(part.val))
        pinned.add(part.col)
    }

    if (pkColumns.length > 0 && pkColumns.every(col => pinned.has(col)))
      return true

    return [...pinned].some(col => table.columns[col]?.constraints.some((c: ColumnConstraint) => c.type === 'unique') || table.uniques.some(u => u.columns.length === 1 && u.columns[0] === col))
  }

  async updateWithLock(set: InferUpdate<TColumns>, where: Where<TColumns>, currentVersion: number, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals>> {
    requireReturning('updateWithLock', opts)

    const lockCol = this._runtime.behavior.getOptimisticLockColumn()

    if (!lockCol) {
      throw new ValidationError(
        'updateWithLock requires optimisticLock trait on table',
        'updateWithLock',
        { field: this._runtime.table.name },
      )
    }

    const filter = this._requireWhere(where, 'updateWithLock')
    const rows = await this.updateMany(set, e => e.and(compileWhere<TColumns>(filter), e.eq(lockCol, currentVersion)), opts)

    if (rows.length > 0)
      return rows[0]!

    const matches = new SelectBuilderCtor<TColumns>(this._runtime.table).count().where(filter)

    this._runtime.behavior.prepareSelect(matches)
    matches.withoutScope(...liftedScopes(opts))

    const { sql, params } = matches.toSQL(dialectOf(this._executor))

    if (Number((await this._executor.query(sql, params))[0]?.count ?? 0) === 0)
      throw new NotFoundError(this._runtime.table.name)

    throw new StaleRecordError(this._runtime.table.name, currentVersion)
  }

  async updateManyById(rows: Record<string, unknown>[], opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (rows.length === 0)
      return []

    const { pkColumns, table } = this._runtime
    const prepared = await this._keyedRows(rows, 'updateManyById', async patch => this._normalizeValues(await this._runtime.runBefore('beforeUpdate', patch, this._hooks)))
    // Each row binds its key and every column some row sets.
    const columns = pkColumns.length + new Set(prepared.flatMap(row => Object.keys(row.set))).size

    return this._chunked(prepared, (pipeline, chunk) => {
      const builder = new BulkUpdateBuilder(table.name, table.columns, [...pkColumns], chunk)

      this._runtime.behavior.prepareUpdate(builder, {})
      this._runtime.behavior.guardWrite(builder, liftedScopes(opts))

      return pipeline._execute({
        builder,
        afterEvent: 'afterUpdate',
        project: result => pipeline._projectMany(result, opts),
        opts,
      })
    }, columns)
  }

  /** Writes columns onto rows by key and nothing else: no hook, scope, version bump or timestamp, for a trait storing what it derived from a row it just wrote. */
  async patchById(rows: Record<string, unknown>[]): Promise<void> {
    const { pkColumns, table } = this._runtime
    const prepared = await this._keyedRows(rows, 'patchById', async patch => this._normalizeValues(patch))

    await this._chunked(prepared, async (pipeline, chunk) => {
      const { sql, params } = new BulkUpdateBuilder(table.name, table.columns, [...pkColumns], chunk).returning(...pkColumns).toSQL(dialectOf(pipeline._executor))

      await pipeline._executor.query(sql, params)

      return []
    }, pkColumns.length + new Set(prepared.flatMap(row => Object.keys(row.set))).size)
  }

  private async _keyedRows(rows: Record<string, unknown>[], op: string, prepareSet: (patch: Record<string, unknown>) => Promise<Record<string, unknown>>): Promise<BulkUpdateRow[]> {
    const { pkColumns, table } = this._runtime
    const seen = new Set<string>()

    this._runtime.requireKey(`${op}()`)
    const prepared: BulkUpdateRow[] = []

    for (const row of rows) {
      const key: Record<string, unknown> = {}
      const patch: Record<string, unknown> = {}

      for (const [col, value] of Object.entries(row)) {
        columnOf(table, col, op)
        ;(pkColumns.includes(col) ? key : patch)[col] = value
      }

      for (const col of pkColumns) {
        if (key[col] === undefined || key[col] === null)
          throw new ValidationError(`${op}(): a row on "${table.name}" is missing its primary key "${col}".`, op, { field: col })

        assertKeyValue(key[col], table.name, col, op)
      }

      // Two patches for one row would leave which one wins up to the planner.
      const identity = pkColumns.map(col => `${col}=${String(key[col])}`).join(', ')

      if (seen.has(identity))
        throw new ValidationError(`${op}(): two rows on "${table.name}" share one ${pkColumns.join(', ')}.`, op, { field: pkColumns.join(', ') })

      seen.add(identity)
      prepared.push({ key, set: await prepareSet(patch) })
    }

    return prepared
  }

  // --- Delete ---

  async deleteMany(where: Where<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._delete(this._requireWhere(where, 'deleteMany'), false, opts)
  }

  async deleteOne(where: Where<TColumns>, opts?: ScopedWriteOptions & SingleRowOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    requireReturning('deleteOne', opts)

    const single = this._singleRow('deleteOne', this._requireWhere(where, 'deleteOne'), liftedScopes(opts), opts?.onMany)
    const rows = await this._delete(single.where, false, opts)

    return rows[0] ?? await single.noMatch()
  }

  /** Delete the row a primary key names: the key bounds the statement, so it needs no `_singleRow`. */
  async deleteById(key: Where<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    requireReturning('deleteById', opts)

    const rows = await this.deleteMany(key, opts)

    return rows[0] ?? null
  }

  async deleteAll(opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._delete(null, false, opts)
  }

  async forceDelete(where: Where<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._delete(this._requireWhere(where, 'forceDelete'), true, opts)
  }

  async purgeTrashed(olderThan: Date, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const softDeleteColumn = this._runtime.behavior.getSoftDeleteColumn()
    const { name } = this._runtime.table

    if (softDeleteColumn === null)
      throw new ValidationError(`purgeTrashed() needs the softDelete trait on "${name}"`, 'purgeTrashed')

    if (!(olderThan instanceof Date) || Number.isNaN(olderThan.getTime()))
      throw new ValidationError(`purgeTrashed() on "${name}" takes a valid Date as its cutoff`, 'purgeTrashed', { value: olderThan })

    return this._delete(e => e.and(e.isNotNull(softDeleteColumn as never), e.lt(softDeleteColumn as never, olderThan as never)), true, opts)
  }

  // A `null` where is every row, which only `deleteAll` passes.
  private async _delete(where: Where<TColumns> | null, force: boolean, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    await this._runtime.runBefore('beforeDelete', undefined, this._hooks)

    // A soft delete is an UPDATE, so it runs the update path: `beforeUpdate` hooks (timestamps) and the version bump.
    const softSet = force ? null : this._runtime.behavior.softDeleteSet<TColumns>()
    const lifted = liftedScopes(opts)
    const builder = softSet
      ? this._runtime.behavior.rewriteDelete(this._normalizeValues(await this._runtime.runBefore('beforeUpdate', softSet, this._hooks) as Record<string, unknown>) as typeof softSet, where, lifted)
      : this._hardDelete(where, force ? [...lifted, SOFT_DELETE_SCOPE] : lifted)

    return this._execute({
      builder,
      afterEvent: 'afterDelete',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  private _hardDelete(where: Where<TColumns> | null, lifted: string[]): DeleteBuilderCtor<TColumns> {
    const builder = new DeleteBuilderCtor<TColumns>(this._runtime.table)

    if (where)
      builder.where(where)
    else
      builder.allRows()

    this._runtime.behavior.guardWrite(builder, lifted)

    return builder
  }

  // --- Upsert ---

  async upsertMany(
    values: InferInsert<TColumns>[],
    conflictTarget: (keyof TColumns & string)[],
    opts?: UpsertOptions<TColumns>,
  ): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    // A row an upsert writes may be inserted, so it goes through the insert hooks first.
    const inserted = await this._runtime.runBeforeMany('beforeUpsert', await this._runtime.runBeforeMany('beforeInsert', values, this._hooks), this._hooks) as Record<string, unknown>[]
    const { rows: hooked, columns } = await updateHookedRows(this._runtime, this._hooks, inserted)
    const v = hooked.map(row => this._normalizeValues(row)) as InferInsert<TColumns>[]
    const conflict = conflictUpdate<TColumns>(this._runtime, this._tableRegistry, values => this._normalizeValues(values), opts?.update, columns, liftedScopes(opts))

    return this._chunked(v as Record<string, unknown>[], async (pipeline, rows) => {
      const builder = pipeline._insertMany(rows as InferInsert<TColumns>[]).onConflict(conflictTarget).doUpdateWith(conflict)

      return pipeline._execute({
        builder,
        afterEvent: 'afterInsert',
        inserted: await insertedClassifier(pipeline._executor, this._runtime.table, builder, rows, conflictTarget),
        project: written => pipeline._projectMany(written, opts),
        opts,
      })
    })
  }

  async upsertOne(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
    opts?: UpsertOptions<TColumns>,
  ): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    requireReturning('upsertOne', opts)

    const rows = await this.upsertMany([values], conflictTarget, opts)

    return rows[0] ?? null
  }

  /**
   * The row holding `values`' conflict key, inserted when missing: `created` says which. One statement inserts or does nothing; on a conflict a trashed row is restored (`restore()`, hooks and all), else the live one is read back.
   * A row deleted between those statements sends it round again, a few times at most.
   */
  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[], opts?: FindOrCreateOptions): Promise<{ row: WithVirtuals<TColumns, TVirtuals>, created: boolean }> {
    const lifted = liftedScopes(opts)
    const v = this._normalizeValues(await this._runtime.runBefore('beforeUpsert', await this._runtime.runBefore('beforeInsert', values, this._hooks), this._hooks) as Record<string, unknown>)
    const { table } = this._runtime
    const key = Object.fromEntries(conflictTarget.map((col) => {
      if (v[col] === undefined || v[col] === null)
        throw new ValidationError(`findOrCreate(): the values on "${table.name}" have no "${col}", the conflict target it looks the row up by.`, 'findOrCreate', { field: col })

      return [col, assertKeyValue(v[col], table.name, col, 'findOrCreate')]
    })) as Where<TColumns>

    for (let attempt = 0; attempt < FIND_OR_CREATE_ATTEMPTS; attempt++) {
      const [created] = await this._execute({
        builder: new InsertBuilderCtor<TColumns>(table).values(v as InferInsert<TColumns>).onConflict(conflictTarget).doNothing(),
        afterEvent: 'afterInsert',
        project: rows => this._projectMany(rows),
      })

      if (created)
        return { row: created, created: true }

      const [found] = await this._select(key, lifted)

      if (!found) {
        if (await this._hiddenByScope(key))
          throw new OrmError(`findOrCreate() on "${table.name}": the row conflicting with the insert is hidden by a scope of the table, so it can be neither returned nor restored.`)

        continue
      }

      // The update hooks run for a trashed row only, the one this restores; a live row is returned as it is.
      const trashCol = this._runtime.behavior.getSoftDeleteColumn()

      if (trashCol && (found as Record<string, unknown>)[trashCol] != null) {
        const [restored] = await this.restore(key, opts)

        if (restored)
          return { row: restored, created: false }

        continue
      }

      const [hooked = found] = await this._runtime.runAfter('afterSelect', [found], this._hooks)

      return { row: hooked, created: false }
    }

    throw new OrmError(`findOrCreate() on "${table.name}": the row conflicting with the insert was deleted before it could be read, ${FIND_OR_CREATE_ATTEMPTS} times over.`)
  }

  // Whether a row matches `where` once no scope is applied.
  private async _hiddenByScope(where: Where<TColumns>): Promise<boolean> {
    const { sql, params } = new SelectBuilderCtor<TColumns>(this._runtime.table).count().where(where).toSQL(dialectOf(this._executor))

    return Number((await this._executor.query(sql, params))[0]?.count ?? 0) > 0
  }

  // Rows matching `where` and the table's scopes, trashed ones included, mapped and with virtuals like a write's.
  private async _select(where: Where<TColumns>, lifted: string[]): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).where(where).withoutScope(SOFT_DELETE_SCOPE, ...lifted)

    this._runtime.behavior.prepareSelect(builder)
    const { sql, params } = builder.toSQL(dialectOf(this._executor))

    return this._runtime.applyVirtuals(mapChunk(this._mapperFactory(builder), await this._executor.query(sql, params))) as WithVirtuals<TColumns, TVirtuals>[]
  }

  // --- Restore ---

  async restore(where: Where<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._restore(this._requireWhere(where, 'restore'), opts)
  }

  /** Restores every trashed row, which `restore` refuses a WHERE for. */
  async restoreAll(opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    return this._restore(e => e.and(), opts)
  }

  private async _restore(where: Where<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const sdCol = this._runtime.behavior.getSoftDeleteColumn()

    if (sdCol === null) {
      throw new ValidationError(
        'restore() requires softDelete trait on table',
        'restore',
        { field: this._runtime.table.name },
      )
    }

    const s = this._normalizeValues(await this._runtime.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>, this._hooks) as Record<string, unknown>) as InferUpdate<TColumns>
    const builder = this._runtime.behavior.buildRestoreUpdate(s, where, liftedScopes(opts))

    return this._execute({
      builder,
      afterEvent: 'afterUpdate',
      project: rows => this._projectMany(rows, opts),
      opts,
    })
  }

  // --- Shared execution path ---

  // `inserted`, on an upsert, tells each raw row's origin: inserted ones fire `afterInsert`, updated ones `afterUpdate`.
  private async _execute<TResult>(args: {
    builder: ReturnableBuilder
    afterEvent: 'afterInsert' | 'afterUpdate' | 'afterDelete'
    inserted?: (raw: Record<string, unknown>) => boolean
    project: (rows: Record<string, unknown>[]) => TResult
    opts?: WriteReturnOptions
  }): Promise<TResult> {
    const { pkColumns, table } = this._runtime

    if (args.opts?.pk)
      this._runtime.requireKey('{ pk: true }')

    // After-write hooks get the whole mapped row, as afterSelect does, so a hooked table returns every column even when the caller only wants keys or nothing.
    const hooked = hasHooks(table, args.afterEvent) || args.inserted !== undefined
    const whole = !args.opts?.pk || hooked
    const shape = new SelectBuilderCtor<AnyColumns>(table)

    if (args.opts?.returning !== false || hooked)
      args.builder.returning(...whole ? [] : pkColumns)

    const { sql, params } = args.builder.toSQL(dialectOf(this._executor))
    const raw = await this._executor.query(sql, params)
    const origins = args.inserted ? raw.map(args.inserted) : undefined
    const rows = mapChunk(this._mapperFactory(whole ? shape : shape.pick(...pkColumns)), raw)

    if (origins) {
      await this._runAfterWrite('afterInsert', rows.filter((_row, i) => origins[i]))
      await this._runAfterWrite('afterUpdate', rows.filter((_row, i) => !origins[i]))
    }
    else {
      await this._runAfterWrite(args.afterEvent, rows)
    }

    return args.project(rows)
  }

  // A write that touched no row fires no after-write hook, and a chunked one with no hook listening keeps no rows for it.
  private async _runAfterWrite(event: 'afterInsert' | 'afterUpdate' | 'afterDelete', rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0 || !hasHooks(this._runtime.table, event))
      return

    if (this._deferredAfter)
      this._deferredAfter.push([event, rows])
    else
      await this._runtime.runAfter(event, rows, this._hooks)
  }

  // `rows` arrive mapped; the row form installs virtuals.
  private _projectOne(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any {
    return this._projectMany(rows.slice(0, 1), opts)[0]
  }

  private _projectMany(rows: Record<string, unknown>[], opts?: WriteReturnOptions): any[] {
    return opts?.pk ? this._keys(rows) : this._runtime.applyVirtuals(rows)
  }

  // A composite key is an object holding each part.
  private _keys(rows: Record<string, unknown>[]): unknown[] {
    const { pkColumns } = this._runtime

    if (pkColumns.length === 1)
      return rows.map(row => row[pkColumns[0]!])

    return rows.map(row => Object.fromEntries(pkColumns.map(col => [col, row[col]])))
  }
}
