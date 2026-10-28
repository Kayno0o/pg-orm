import type { BulkUpdateRow } from '../builder/bulk-update'
import type { ConflictSet, ConflictValue } from '../builder/conflict'
import type { ConflictUpdate } from '../builder/insert'
import type { WhereInput } from '../builder/query'
import type { Dialect } from '../dialect'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyVirtuals, ColumnConstraint, InferInsert, InferPrimaryKey, InferUpdate, InsertOptions, SingleRowOptions, UpdateOptions, WithVirtuals, WriteReturnOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { OP_AND, OP_EQ, OP_IN_SUBQUERY, OP_SCALAR } from '../builder/_tape'
import { BulkUpdateBuilder } from '../builder/bulk-update'
import { isConflictValue } from '../builder/conflict'
import { compileWhere, DeleteBuilder as DeleteBuilderCtor, InsertBuilder as InsertBuilderCtor, SelectBuilder as SelectBuilderCtor, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { MAX_BIND_PARAMS, STATEMENT_PARAM_RESERVE } from '../constants'
import { dialectOf, requirePostgres } from '../dialect'
import { MultipleRowsError, NotFoundError, OrmError, StaleRecordError, ValidationError } from '../errors/index'
import { hasHooks } from '../hooks/index'
import { mapChunk } from '../mapper/index'
import { sqliteInsertDefaults } from '../schema/column-default'
import { copyField } from '../sql/copy'
import { jsonParam } from '../sql/json-param'
import { quote } from '../sql/utils'
import { createMapperFactory } from './_mapper'

type Where<TColumns extends AnyColumns> = WhereInput<TColumns>

const INSERTED_FLAG = '__pgorm_inserted'
// The size a COPY's rows are batched to before each write to the stream.
const COPY_CHUNK_CHARS = 64 * 1024
const FIND_OR_CREATE_ATTEMPTS = 3
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

// The builders read a falsy WHERE as "no WHERE", which on a write is every row: only `deleteAll` may ask for that, by name.
function requireWhere<T>(where: T, op: string): T {
  if (!where)
    throw new ValidationError(`${op}() needs a WHERE: a missing one would reach every row (deleteAll() clears a table on purpose).`, op, { value: where })

  return where
}

function skipConflicts<TColumns extends AnyColumns>(builder: InsertBuilderCtor<TColumns>, opts?: InsertOptions<TColumns>): InsertBuilderCtor<TColumns> {
  return opts?.skipConflicts ? builder.onConflict(opts.skipConflicts).doNothing() : builder
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
  // Set on the pipeline a chunked write runs its chunks on: after-write hooks wait for the last chunk, so none fires for rows a later chunk rolls back.
  private _deferredAfter?: [event: 'afterInsert' | 'afterUpdate' | 'afterDelete', rows: Record<string, unknown>[]][]

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

      // A scalar too: SQLite stores the string "123" or `true` as its JSON text only when marked.
      if (col && (col.pgType === 'json' || col.pgType === 'jsonb') && val !== null && val !== undefined) {
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
    const builder = new InsertBuilderCtor<TColumns>(this._runtime.table).many(rows)

    if (dialectOf(this._executor) === 'sqlite')
      builder.getState().defaultSql = this._sqliteDefaults ??= sqliteInsertDefaults(this._runtime.table.columns)

    return builder
  }

  // --- Insert ---

  async insertOne(values: InferInsert<TColumns>, opts?: InsertOptions<TColumns>): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const v = this._normalizeJsonValues(await this._runtime.runBefore('beforeInsert', values) as Record<string, unknown>) as InferInsert<TColumns>

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

    const v = (await this._runtime.runBeforeMany('beforeInsert', values))
      .map(row => this._normalizeJsonValues(row as Record<string, unknown>)) as InferInsert<TColumns>[]

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
      const col = table.columns[name]

      if (!col)
        throw new ValidationError(`"${table.name}" has no column "${name}"`, 'copyFrom', { field: name })

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
  private async _chunked<TRow extends Record<string, unknown>, TResult>(
    rows: TRow[],
    write: (pipeline: WritePipeline<TColumns, TVirtuals>, chunk: TRow[]) => Promise<TResult[]>,
  ): Promise<TResult[]> {
    const columns = new Set(rows.flatMap(row => Object.keys(row))).size
    const budget = MAX_BIND_PARAMS[dialectOf(this._executor)] - STATEMENT_PARAM_RESERVE
    const size = Math.max(1, Math.floor(budget / Math.max(1, columns)))

    if (rows.length <= size)
      return write(this, rows)

    const deferred: NonNullable<typeof this._deferredAfter> = []
    const run = async (exec: Executable): Promise<TResult[]> => {
      const pipeline = new WritePipeline<TColumns, TVirtuals>({ executor: exec, runtime: this._runtime })
      const out: TResult[] = []

      pipeline._deferredAfter = deferred

      for (let i = 0; i < rows.length; i += size)
        out.push(...await write(pipeline, rows.slice(i, i + size)))

      return out
    }
    const out = this._executor.atomic ? await this._executor.atomic(run) : await run(this._executor)

    for (const [event, written] of deferred)
      await this._runtime.runAfter(event, written)

    return out
  }

  // --- Update ---

  async updateMany(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns>[] | WithVirtuals<TColumns, TVirtuals>[]> {
    requireWhere(where, 'updateMany')

    const s = this._normalizeJsonValues(await this._runtime.runBefore('beforeUpdate', set) as Record<string, unknown>) as InferUpdate<TColumns>
    const builder = new UpdateBuilderCtor<TColumns>(this._runtime.table)
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

  async updateOne(set: InferUpdate<TColumns>, where: Where<TColumns>, opts?: UpdateOptions & SingleRowOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const single = this._singleRow('updateOne', requireWhere(where, 'updateOne'), opts?.withTrashed, opts?.onMany)
    const rows = await this.updateMany(set, single.where, opts)

    return rows[0] ?? await single.noMatch()
  }

  /** Update the row a primary key names: the key bounds the statement, so it needs no `_singleRow`. */
  async updateById(set: InferUpdate<TColumns>, key: Where<TColumns>, opts?: UpdateOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.updateMany(set, key, opts)

    return rows[0] ?? null
  }

  /**
   * The WHERE `updateOne` and `deleteOne` run, reaching one row however many match, and what to answer when it changed none. Trashed rows are passed over unless `withTrashed`, as the statement itself skips them.
   * By default it is the first match by primary key. With `onMany: 'throw'` it is `where` holding only while exactly one row matches, so several change nothing, and a statement that changed nothing then counts the matches to tell none from several.
   * That count is a second statement: outside a transaction, a row written between the two can make it tell none from several wrongly, though the write itself never reaches more than one row.
   */
  private _singleRow(op: string, where: Where<TColumns>, withTrashed?: boolean, onMany?: SingleRowOptions['onMany']): { where: Where<TColumns>, noMatch: () => Promise<null> } {
    const { pkColumns, table } = this._runtime
    const live = <B extends SelectBuilderCtor<TColumns>>(builder: B): B => {
      if (!withTrashed)
        this._runtime.behavior.prepareSelect(builder)

      return builder
    }

    if (onMany === 'throw') {
      const matches = live(new SelectBuilderCtor<TColumns>(table).count().where(where))

      return {
        where: () => [{ op: OP_AND, count: 2 }, ...compileWhere<TColumns>(where), { op: OP_EQ, col: [{ op: OP_SCALAR, subquery: matches }], val: 1 }],
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
    return { where: () => [{ op: OP_AND, count: 2 }, ...compileWhere<TColumns>(where), { op: OP_IN_SUBQUERY, cols: [...pkColumns], subquery: first }], noMatch: async () => null }
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

    if (rows.length > 0)
      return rows[0]!

    const matches = new SelectBuilderCtor<TColumns>(this._runtime.table).count().where(where)

    if (!opts?.withTrashed)
      this._runtime.behavior.prepareSelect(matches)

    const { sql, params } = matches.toSQL(dialectOf(this._executor))

    if (Number((await this._executor.query(sql, params))[0]?.count ?? 0) === 0)
      throw new NotFoundError(this._runtime.table.name)

    throw new StaleRecordError(this._runtime.table.name, currentVersion)
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

  async deleteOne(where: Where<TColumns>, opts?: WriteReturnOptions & SingleRowOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const single = this._singleRow('deleteOne', requireWhere(where, 'deleteOne'), false, opts?.onMany)
    const rows = await this._delete(single.where, false, opts)

    return rows[0] ?? await single.noMatch()
  }

  /** Delete the row a primary key names: the key bounds the statement, so it needs no `_singleRow`. */
  async deleteById(key: Where<TColumns>, opts?: WriteReturnOptions): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.deleteMany(key, opts)

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
    const hardDelete = new DeleteBuilderCtor<TColumns>(this._runtime.table)
    const builder = softSet
      ? this._runtime.behavior.rewriteDelete(await this._runtime.runBefore('beforeUpdate', softSet), where)
      : where ? hardDelete.where(where) : hardDelete.allRows()

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
    const conflict = await this._conflictUpdate(update)

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
    opts?: WriteReturnOptions,
  ): Promise<InferPrimaryKey<TColumns> | WithVirtuals<TColumns, TVirtuals> | null> {
    const rows = await this.upsertMany([values], conflictTarget, update, opts)

    return rows[0] ?? null
  }

  // The row an upsert updates is updated like any other: `beforeUpdate` hooks (timestamps) and the version bump apply to it. A trashed row is restored, taking the incoming row's soft-delete column (null unless given), unless `set` says otherwise.
  private async _conflictUpdate(update?: UpsertUpdate<TColumns>): Promise<ConflictUpdate<TColumns>> {
    const spec: ConflictUpdate<TColumns> = Array.isArray(update) ? { columns: update.length ? update : undefined } : update ?? {}
    const hooked = await this._runtime.runBefore('beforeUpdate', {})
    const lock = this._runtime.behavior.getOptimisticLockColumn()
    const trashCol = this._runtime.behavior.getSoftDeleteColumn()

    if (!spec.set && Object.keys(hooked).length === 0 && !lock && !trashCol)
      return spec

    return {
      ...spec,
      set: (u) => {
        const set: Record<string, unknown> = { ...hooked, ...trashCol && { [trashCol]: u.excluded(trashCol) }, ...spec.set?.(u) }

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

  /**
   * The row holding `values`' conflict key, inserted when missing: `created` says which. One statement inserts or does nothing; on a conflict a trashed row is restored (`restore()`, hooks and all), else the live one is read back.
   * A row deleted between those statements sends it round again, a few times at most.
   */
  async findOrCreate(values: InferInsert<TColumns>, conflictTarget: (keyof TColumns & string)[]): Promise<{ row: WithVirtuals<TColumns, TVirtuals>, created: boolean }> {
    const v = this._normalizeJsonValues(await this._runtime.runBefore('beforeUpsert', values) as Record<string, unknown>)
    const { table } = this._runtime
    const key = Object.fromEntries(conflictTarget.map((col) => {
      if (v[col] === undefined || v[col] === null)
        throw new ValidationError(`findOrCreate(): the values on "${table.name}" have no "${col}", the conflict target it looks the row up by.`, 'findOrCreate', { field: col })

      return [col, v[col]]
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

      if (found)
        return { row: found, created: false }
    }

    throw new OrmError(`findOrCreate() on "${table.name}": the row conflicting with the insert was deleted before it could be read, ${FIND_OR_CREATE_ATTEMPTS} times over.`)
  }

  // Rows matching `where`, trashed ones included, mapped and with virtuals like a write's.
  private async _select(where: Where<TColumns>): Promise<WithVirtuals<TColumns, TVirtuals>[]> {
    const builder = new SelectBuilderCtor<TColumns>(this._runtime.table).where(where)
    const { sql, params } = builder.toSQL(dialectOf(this._executor))

    return this._runtime.applyVirtuals(mapChunk(this._mapperFactory(builder), await this._executor.query(sql, params))) as WithVirtuals<TColumns, TVirtuals>[]
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

  // `inserted`, on an upsert, tells each raw row's origin: inserted ones fire `afterInsert`, updated ones `afterUpdate`.
  private async _execute<TResult>(args: {
    builder: ReturnableBuilder
    afterEvent: 'afterInsert' | 'afterUpdate' | 'afterDelete'
    inserted?: (raw: Record<string, unknown>) => boolean
    project: (rows: Record<string, unknown>[]) => TResult
    opts?: WriteReturnOptions
  }): Promise<TResult> {
    const { pkColumns, table } = this._runtime
    // After-write hooks get the whole mapped row, as afterSelect does, so a hooked table returns every column even when the caller only wants keys.
    const whole = !args.opts?.pk || hasHooks(table, args.afterEvent) || args.inserted !== undefined
    const shape = new SelectBuilderCtor<AnyColumns>(table)

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
      await this._runtime.runAfter(event, rows)
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
