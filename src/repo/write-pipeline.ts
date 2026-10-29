import type { ExprTape } from '../builder/_tape'
import type { BulkUpdateRow } from '../builder/bulk-update'
import type { ConflictSet, ConflictValue } from '../builder/conflict'
import type { ConflictUpdate } from '../builder/insert'
import type { WhereInput } from '../builder/query'
import type { Dialect } from '../dialect'
import type { Executable } from '../sql/executor'
import type { TransactionClient } from '../sql/transaction'
import type { AnyColumns, AnyTableDef, AnyVirtuals, ColumnConstraint, HookContext, InferInsert, InferPrimaryKey, InferUpdate, InsertOptions, ScopedWriteOptions, SingleRowOptions, UpdateOptions, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { holdsForEveryRow, OP_AND, OP_EQ, OP_IN_SUBQUERY, OP_SCALAR, vectorText } from '../builder/_tape'
import { BulkUpdateBuilder } from '../builder/bulk-update'
import { isConflictValue } from '../builder/conflict'
import { compileWhere, DeleteBuilder as DeleteBuilderCtor, InsertBuilder as InsertBuilderCtor, SelectBuilder as SelectBuilderCtor, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { MAX_BIND_PARAMS, SOFT_DELETE_SCOPE, STATEMENT_PARAM_RESERVE } from '../constants'
import { dialectOf, requirePostgres } from '../dialect'
import { MultipleRowsError, NotFoundError, OrmError, StaleRecordError, ValidationError } from '../errors/index'
import { hasHooks } from '../hooks/index'
import { mapChunk } from '../mapper/index'
import { sqliteInsertDefaults } from '../schema/column-default'
import { copyField } from '../sql/copy'
import { jsonParam } from '../sql/json-param'
import { quote } from '../sql/utils'
import { createMapperFactory } from './_mapper'
import { resolveRelationFilters } from './relation-filter'
import { liftedScopes, resolveScopes } from './table-behavior'
import { assertKeyValue, columnOf } from './table-runtime'

type Where<TColumns extends AnyColumns> = WhereInput<TColumns>

const INSERTED_FLAG = '__pgorm_inserted'
// The size a COPY's rows are batched to before each write to the stream.
const COPY_CHUNK_CHARS = 64 * 1024
const FIND_OR_CREATE_ATTEMPTS = 3
const VECTOR_TYPE_RE = /^(?:vector|halfvec)\(\d+\)$/
// SQLite nests an OR chain one level per term, under its expression depth limit of 1000.
const SQLITE_OR_TERMS = 500

async function* prepend<T>(first: T, rest: Iterator<T> | AsyncIterator<T>): AsyncGenerator<T> {
  try {
    yield first

    for (let next = await rest.next(); !next.done; next = await rest.next())
      yield next.value
  }
  finally {
    await rest.return?.()
  }
}

// A COPY's column list is fixed by its first row, so every later one must set exactly those columns.
function assertCopyRow(row: Record<string, unknown>, columns: string[], expected: ReadonlySet<string>): void {
  let set = 0

  for (const key in row) {
    if (row[key] === undefined)
      continue

    if (!expected.has(key))
      throw new ValidationError(`copyFrom rows must all set the columns the first one sets (${columns.join(', ')}): one also sets "${key}"`, 'copyFrom', { field: key })

    set++
  }

  if (set !== columns.length)
    throw new ValidationError(`copyFrom rows must all set the columns the first one sets (${columns.join(', ')}): one leaves ${columns.filter(c => row[c] === undefined).join(', ')} unset`, 'copyFrom')
}

/** An upsert's conflict update: the columns to copy from the incoming row, or the full `ConflictUpdate`. */
export type UpsertUpdate<TColumns extends AnyColumns> = (keyof TColumns & string)[] | ConflictUpdate<TColumns>

/** Builder surface the pipeline needs to set RETURNING and compile. */
interface ReturnableBuilder {
  returning: (...cols: string[]) => this
  toSQL: (dialect?: Dialect) => { sql: string, params: unknown[] }
}

function skipConflicts<TColumns extends AnyColumns>(builder: InsertBuilderCtor<TColumns>, opts?: InsertOptions<TColumns>): InsertBuilderCtor<TColumns> {
  return opts?.skipConflicts ? builder.onConflict(opts.skipConflicts).doNothing() : builder
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
   * Mark json/jsonb values before parameter binding. bun:sql's unsafe() path does not
   * know column types, and serializeParams() would otherwise turn every JS array into a
   * PostgreSQL array literal (e.g. {"a","b"}), which is not JSON. Marking them leaves the
   * value untouched all the way to the driver, which encodes it to JSON itself - stringifying
   * here instead would arrive as a string and be encoded a second time, storing a JSON string
   * scalar that reads back correctly and answers `string` to jsonb_typeof. A vector goes in as pgvector's `[1,2]` text for the same reason.
   * A key that is not a column of the table is refused, so a request body passed as is never writes a quoted identifier the table lacks.
   */
  private _normalizeValues(values: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {}

    for (const [key, val] of Object.entries(values)) {
      const col = columnOf(this._runtime.table, key, 'write')

      if (VECTOR_TYPE_RE.test(col.pgType) && (Array.isArray(val) || val instanceof Float32Array)) {
        out[key] = vectorText(val)

        continue
      }

      // A scalar too: SQLite stores the string "123" or `true` as its JSON text only when marked.
      out[key] = (col.pgType === 'json' || col.pgType === 'jsonb') && val !== null && val !== undefined ? jsonParam(val) : val
    }

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
      throw new OrmError('copyFrom needs an executor that runs COPY')

    const iterator = Symbol.asyncIterator in rows ? rows[Symbol.asyncIterator]() : rows[Symbol.iterator]()
    const first = await iterator.next()

    if (first.done)
      return 0

    const columns = this._copyColumns(first.value as Record<string, unknown>)
    const table = this._runtime.table.name

    return this._executor.copyIn(`COPY ${quote(table)} (${columns.map(quote).join(', ')}) FROM STDIN`, this._copyChunks(first.value as Record<string, unknown>, iterator, columns))
  }

  private _copyColumns(row: Record<string, unknown>): string[] {
    const table = this._runtime.table
    const columns = Object.keys(row).filter(key => row[key] !== undefined)

    if (columns.length === 0)
      throw new ValidationError(`copyFrom on "${table.name}" got a row setting no column`, 'copyFrom')

    for (const name of columns) {
      const col = columnOf(table, name, 'copyFrom')

      if (col.constraints.some((c: ColumnConstraint) => c.type === 'generated'))
        throw new ValidationError(`"${table.name}"."${name}" is a generated column, which COPY cannot write`, 'copyFrom', { field: name })
    }

    return columns
  }

  private async* _copyChunks(first: Record<string, unknown>, rest: Iterator<unknown> | AsyncIterator<unknown>, columns: string[]): AsyncGenerator<string> {
    const table = this._runtime.table
    const json = columns.map(name => table.columns[name]!.pgType === 'json' || table.columns[name]!.pgType === 'jsonb')
    const expected = new Set(columns)
    let buffer = ''

    for await (const value of prepend(first, rest)) {
      const row = value as Record<string, unknown>

      assertCopyRow(row, columns, expected)
      buffer += `${columns.map((name, i) => copyField(row[name], json[i]!)).join('\t')}\n`

      if (buffer.length >= COPY_CHUNK_CHARS) {
        yield buffer
        buffer = ''
      }
    }

    if (buffer)
      yield buffer
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

      for (let i = 0; i < rows.length; i += size)
        out.push(...await write(pipeline, rows.slice(i, i + size)))

      for (const [event, written] of deferred)
        await this._runtime.runAfter(event, written, hooks)

      return out
    }

    return this._executor.atomic ? this._executor.atomic(run) : run(this._executor)
  }

  // --- Update ---

  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const filter = this._requireWhere(where, 'updateMany')
    const s = this._normalizeValues(await this._runtime.runBefore('beforeUpdate', set, this._hooks) as Record<string, unknown>) as InferUpdate<TColumns>
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
    const single = this._singleRow('updateOne', this._requireWhere(where, 'updateOne'), liftedScopes(opts), opts?.onMany)
    const rows = await this.updateMany(set, single.where, opts)

    return rows[0] ?? await single.noMatch()
  }

  /** Update the row a primary key names: the key bounds the statement, so it needs no `_singleRow`. */
  async updateById(set: InferUpdate<TColumns>, key: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
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

    const first = live(new SelectBuilderCtor<TColumns>(table)
      .pick(...pkColumns as (keyof TColumns & string)[])
      .where(where)
      .limit(1))

    for (const col of pkColumns)
      first.orderBy(col as keyof TColumns & string)

    // `where` is repeated on the statement itself: under READ COMMITTED, a row a concurrent transaction changed is checked again against the outer WHERE only, so the key alone would let two compare-and-set writes both through.
    return { where: () => [{ op: OP_AND, count: 2 }, ...compileWhere<TColumns>(where, this._runtime.table.columns), { op: OP_IN_SUBQUERY, cols: [...pkColumns], subquery: first }], noMatch: async () => null }
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
    const single = this._singleRow('deleteOne', this._requireWhere(where, 'deleteOne'), liftedScopes(opts), opts?.onMany)
    const rows = await this._delete(single.where, false, opts)

    return rows[0] ?? await single.noMatch()
  }

  /** Delete the row a primary key names: the key bounds the statement, so it needs no `_singleRow`. */
  async deleteById(key: Where<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
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
      ? this._runtime.behavior.rewriteDelete(await this._runtime.runBefore('beforeUpdate', softSet, this._hooks), where, lifted)
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
    update?: UpsertUpdate<TColumns>,
    opts?: ScopedWriteOptions,
  ): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    if (values.length === 0)
      return []

    // A row an upsert writes may be inserted, so it goes through the insert hooks first.
    const inserted = await this._runtime.runBeforeMany('beforeUpsert', await this._runtime.runBeforeMany('beforeInsert', values, this._hooks), this._hooks) as Record<string, unknown>[]
    const { rows: hooked, columns } = await this._updateHookedRows(inserted)
    const v = hooked.map(row => this._normalizeValues(row)) as InferInsert<TColumns>[]
    const conflict = this._conflictUpdate(update, columns, liftedScopes(opts))

    return this._chunked(v as Record<string, unknown>[], async (pipeline, rows) => {
      const builder = pipeline._insertMany(rows as InferInsert<TColumns>[]).onConflict(conflictTarget).doUpdateWith(conflict)

      return pipeline._execute({
        builder,
        afterEvent: 'afterInsert',
        inserted: await pipeline._insertedClassifier(builder, rows, conflictTarget),
        project: written => pipeline._projectMany(written, opts),
        opts,
      })
    })
  }

  /**
   * How to tell an upsert's inserted rows from its updated ones, so each fires its own after hook; undefined when no hook listens.
   * Postgres says it per row (`xmax = 0` on a row the statement inserted). SQLite has no such column, so the keys already present are read first: exact inside a transaction, best effort outside one, where a concurrent insert can land between the two statements.
   */
  private async _insertedClassifier(builder: InsertBuilderCtor<TColumns>, rows: Record<string, unknown>[], target: string[]): Promise<((raw: Record<string, unknown>) => boolean) | undefined> {
    const { table } = this._runtime

    if (!hasHooks(table, 'afterInsert') && !hasHooks(table, 'afterUpdate'))
      return undefined

    if (dialectOf(this._executor) === 'postgres') {
      builder.getState().returningExtra = `(xmax = 0) AS ${quote(INSERTED_FLAG)}`

      return (raw) => {
        const inserted = raw[INSERTED_FLAG] === true

        delete raw[INSERTED_FLAG]

        return inserted
      }
    }

    const keyOf = (row: Record<string, unknown>): string => JSON.stringify(target.map(col => String(row[col])))
    const conflicting = rows.filter(row => target.every(col => row[col] !== undefined && row[col] !== null))

    if (conflicting.length === 0)
      return () => true

    const existing = new Set<string>()

    for (let i = 0; i < conflicting.length; i += SQLITE_OR_TERMS) {
      const present = new SelectBuilderCtor<TColumns>(table)
        .pick(...target as (keyof TColumns & string)[])
        .where(e => e.or(...conflicting.slice(i, i + SQLITE_OR_TERMS).map(row => compileWhere<TColumns>(Object.fromEntries(target.map(col => [col, row[col]])) as Where<TColumns>))))
      const { sql, params } = present.toSQL(dialectOf(this._executor))

      for (const row of await this._executor.query(sql, params))
        existing.add(keyOf(row))
    }

    return raw => !existing.has(keyOf(raw))
  }

  async upsertOne(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
    update?: UpsertUpdate<TColumns>,
    opts?: ScopedWriteOptions,
  ): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.upsertMany([values], conflictTarget, update, opts)

    return rows[0] ?? null
  }

  /**
   * Runs `beforeUpdate` on each upsert row, as the update it may become: what a hook sets or changes is written into the row, for the conflict update to take through EXCLUDED, so the inserted row carries it too.
   * Gives the rows and those columns, which every row must set alike, a row lacking one inserting its default and updating to it.
   */
  private async _updateHookedRows(rows: Record<string, unknown>[]): Promise<{ rows: Record<string, unknown>[], columns: string[] }> {
    if (!hasHooks(this._runtime.table, 'beforeUpdate'))
      return { rows, columns: [] }

    const hooked = await this._runtime.runBeforeMany('beforeUpdate', rows.map(row => ({ ...row })), this._hooks)
    const changed = hooked.map((row, i) => Object.keys(row).filter(col => !Object.hasOwn(rows[i]!, col) || row[col] !== rows[i]![col]))
    const columns = [...new Set(changed.flat())]
    const uneven = columns.find(col => hooked.some(row => !Object.hasOwn(row, col)))

    if (uneven !== undefined)
      throw new ValidationError(`upsert on "${this._runtime.table.name}": a beforeUpdate hook set "${uneven}" on some rows only, where the conflict update writes it for every row.`, 'upsert', { field: uneven })

    return { rows: hooked, columns }
  }

  // The row an upsert updates is updated like any other: the columns `beforeUpdate` hooks set (timestamps), taken from the incoming row, and the version bump apply to it, and only while the scopes not `lifted` hold for it. A trashed row is restored, taking the incoming row's soft-delete column (null unless given), unless `set` says otherwise.
  private _conflictUpdate(update: UpsertUpdate<TColumns> | undefined, hookedColumns: string[], lifted: string[]): ConflictUpdate<TColumns> {
    const given: ConflictUpdate<TColumns> = Array.isArray(update) ? { columns: update.length ? update : undefined } : update ?? {}
    const guards = resolveScopes(this._runtime.table).filter(scope => scope.name !== SOFT_DELETE_SCOPE && !lifted.includes(scope.name))
    const spec: ConflictUpdate<TColumns> = guards.length === 0
      ? given
      : { ...given, where: e => e.and(...given.where ? [compileWhere<TColumns>(given.where, this._runtime.table.columns as TColumns)] : [], ...guards.map(scope => scope.tape)) }
    const lock = this._runtime.behavior.getOptimisticLockColumn()
    const trashCol = this._runtime.behavior.getSoftDeleteColumn()

    for (const col of spec.columns ?? [])
      columnOf(this._runtime.table, col, 'upsert')

    if (!spec.set && hookedColumns.length === 0 && !lock && !trashCol && guards.length === 0)
      return spec

    return {
      ...spec,
      set: (u) => {
        const hooked = Object.fromEntries(hookedColumns.map(col => [col, u.excluded(col as keyof TColumns & string)]))
        const set: Record<string, unknown> = { ...hooked, ...trashCol && { [trashCol]: u.excluded(trashCol) }, ...spec.set?.(u) }

        if (lock)
          set[lock] = u.add(u.existing(lock) as ConflictValue<number>, 1)

        // Plain values are bound like any write's, so a json value is marked; an expression is left to render itself.
        for (const [col, value] of Object.entries(set)) {
          if (isConflictValue(value))
            columnOf(this._runtime.table, col, 'upsert')
          else
            Object.assign(set, this._normalizeValues({ [col]: value }))
        }

        return set as ConflictSet<TColumns>
      },
    }
  }

  /**
   * The row holding `values`' conflict key, inserted when missing: `created` says which. One statement inserts or does nothing; on a conflict a trashed row is restored (`restore()`, hooks and all), else the live one is read back.
   * A row deleted between those statements sends it round again, a few times at most.
   */
  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[]): Promise<{ row: WithVirtuals<TColumns, TVirtuals>, created: boolean }> {
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

      const [restored] = this._runtime.behavior.getSoftDeleteColumn() ? await this.restore(key) : []

      if (restored)
        return { row: restored, created: false }

      const [found] = await this._select(key)

      if (found) {
        await this._runtime.runAfter('afterSelect', [found], this._hooks)

        return { row: found, created: false }
      }
    }

    throw new OrmError(`findOrCreate() on "${table.name}": the row conflicting with the insert was deleted before it could be read, ${FIND_OR_CREATE_ATTEMPTS} times over.`)
  }

  // Rows matching `where` and the table's scopes, trashed ones included, mapped and with virtuals like a write's.
  private async _select(where: Where<TColumns>): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).where(where).withoutScope(SOFT_DELETE_SCOPE)

    this._runtime.behavior.prepareSelect(builder)
    const { sql, params } = builder.toSQL(dialectOf(this._executor))

    return this._runtime.applyVirtuals(mapChunk(this._mapperFactory(builder), await this._executor.query(sql, params))) as WithVirtuals<TColumns, TVirtuals>[]
  }

  // --- Restore ---

  async restore(where: Where<TColumns>, opts?: ScopedWriteOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    const sdCol = this._runtime.behavior.getSoftDeleteColumn()

    if (sdCol === null) {
      throw new ValidationError(
        'restore() requires softDelete trait on table',
        'restore',
        { field: this._runtime.table.name },
      )
    }

    const s = await this._runtime.runBefore('beforeUpdate', { [sdCol]: null } as InferUpdate<TColumns>, this._hooks)
    const builder = this._runtime.behavior.buildRestoreUpdate(s, where && this._resolved(compileWhere<TColumns>(where, this._runtime.table.columns)), liftedScopes(opts))

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

  // A write that touched no row fires no after-write hook.
  private async _runAfterWrite(event: 'afterInsert' | 'afterUpdate' | 'afterDelete', rows: Record<string, unknown>[]): Promise<void> {
    if (rows.length === 0)
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
