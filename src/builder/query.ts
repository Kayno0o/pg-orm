import type { AnyColumns, AnyRelations, AnyTableDef, InferInsert, InferRelationResult, InferSelect, InferUpdate, RelationDef } from '../types/index'
import type { ExprBuilder, ExprOp, ExprTape } from './expr'
import { quote } from '../sql/utils'
import { assembleExpr, createExprBuilder, OP_AND } from './expr'

// --- Mutable Query State ---
// Single flat object reused per builder chain. No cloning, no immutable snapshots.

type QueryOp = 'select' | 'insert' | 'insert_many' | 'update' | 'delete' | 'merge' | 'upsert' | 'count' | 'raw'

type OrderDir = 'asc' | 'desc'
interface OrderEntry { col: string, dir: OrderDir, nulls?: 'first' | 'last' }

interface JoinEntry {
  type: 'inner' | 'left' | 'right' | 'full' | 'lateral'
  table: string
  alias: string
  on: ExprTape | null
  relation?: string
}

interface CteEntry {
  name: string
  sql: string
  params: unknown[]
  materialized?: boolean
  recursive?: boolean
}

interface WindowEntry {
  name: string
  partitionBy: string[]
  orderBy: OrderEntry[]
}

interface MergeWhen {
  type: 'matched' | 'not_matched' | 'not_matched_by_source'
  condition?: ExprTape
  action: 'update' | 'insert' | 'delete' | 'nothing'
  values?: Record<string, unknown>
}

// Callback type for relation query customization
export type IncludeCallback = (q: SelectBuilder<any, any, any>) => SelectBuilder<any, any, any>

// Eager include entry — drives batched relation loading (no N+1)
export interface IncludeEntry {
  relation: string
  strategy: 'batch'
  callback?: IncludeCallback
}

interface QueryState {
  op: QueryOp
  table: string
  alias?: string
  // SELECT
  columns: string[] | null // null = *, explicit list = pick
  omitColumns: string[]
  computedColumns: { expr: string, alias: string }[]
  distinct: boolean
  distinctOn: string[]
  // WHERE
  whereTape: ExprTape | null
  // JOIN
  joins: JoinEntry[]
  // ORDER, LIMIT, OFFSET
  orderBy: OrderEntry[]
  limit: number | null
  offset: number | null
  // GROUP BY, HAVING
  groupBy: string[]
  havingTape: ExprTape | null
  // FOR UPDATE / SKIP LOCKED
  lockMode: 'update' | 'share' | 'no_key_update' | 'key_share' | null
  skipLocked: boolean
  // INSERT values
  insertValues: Record<string, unknown> | null
  insertManyValues: Record<string, unknown>[] | null
  // UPDATE set
  setValues: Record<string, unknown> | null
  // RETURNING
  returning: string[] | null // null = no RETURNING, [] = RETURNING *
  // UPSERT (ON CONFLICT)
  conflictTarget: string[] | null
  conflictAction: 'nothing' | 'update' | null
  conflictUpdateCols: string[] | null
  // MERGE
  mergeOn: ExprTape | null
  mergeWhen: MergeWhen[]
  // CTE
  ctes: CteEntry[]
  // WINDOW
  windows: WindowEntry[]
  // Raw
  rawSql: string | null
  rawParams: unknown[]
  // Includes (eager relation loading)
  includes: IncludeEntry[]
  // Soft-delete bypass
  withTrashed: boolean
}

function createState(op: QueryOp, table: string): QueryState {
  return {
    op,
    table,
    columns: null,
    omitColumns: [],
    computedColumns: [],
    distinct: false,
    distinctOn: [],
    whereTape: null,
    joins: [],
    orderBy: [],
    limit: null,
    offset: null,
    groupBy: [],
    havingTape: null,
    lockMode: null,
    skipLocked: false,
    insertValues: null,
    insertManyValues: null,
    setValues: null,
    returning: null,
    conflictTarget: null,
    conflictAction: null,
    conflictUpdateCols: null,
    mergeOn: null,
    mergeWhen: [],
    ctes: [],
    windows: [],
    rawSql: null,
    rawParams: [],
    includes: [],
    withTrashed: false,
  }
}

function cloneState(s: QueryState): QueryState {
  return {
    ...s,
    omitColumns: [...s.omitColumns],
    computedColumns: s.computedColumns.map(c => ({ ...c })),
    distinctOn: [...s.distinctOn],
    whereTape: s.whereTape ? [...s.whereTape] : null,
    joins: s.joins.map(j => ({ ...j })),
    orderBy: s.orderBy.map(o => ({ ...o })),
    groupBy: [...s.groupBy],
    havingTape: s.havingTape ? [...s.havingTape] : null,
    insertValues: s.insertValues ? { ...s.insertValues } : null,
    insertManyValues: s.insertManyValues ? s.insertManyValues.map(r => ({ ...r })) : null,
    setValues: s.setValues ? { ...s.setValues } : null,
    returning: s.returning ? [...s.returning] : null,
    conflictTarget: s.conflictTarget ? [...s.conflictTarget] : null,
    conflictUpdateCols: s.conflictUpdateCols ? [...s.conflictUpdateCols] : null,
    mergeOn: s.mergeOn ? [...s.mergeOn] : null,
    mergeWhen: s.mergeWhen.map(w => ({ ...w })),
    ctes: s.ctes.map(c => ({ ...c, params: [...c.params] })),
    windows: s.windows.map(w => ({ ...w, partitionBy: [...w.partitionBy], orderBy: w.orderBy.map(o => ({ ...o })) })),
    rawParams: [...s.rawParams],
    includes: s.includes.map(i => ({ ...i })),
  }
}

// --- Helpers ---

function quoteCols(cols: string[]): string {
  return cols.map(quote).join(', ')
}

function formatOrderBy(entries: OrderEntry[]): string {
  return entries.map(o => `${quote(o.col)} ${o.dir.toUpperCase()}${o.nulls ? ` NULLS ${o.nulls.toUpperCase()}` : ''}`).join(', ')
}

// Validate values for INSERT/UPDATE — reject undefined, non-finite numbers, and __raw objects
function validateValues(vals: Record<string, unknown>, context: string): void {
  for (const [key, val] of Object.entries(vals)) {
    if (val === undefined) {
      throw new Error(`${context}: column "${key}" has value undefined. Use null for nullable columns.`)
    }

    if (typeof val === 'number' && !Number.isFinite(val)) {
      throw new TypeError(`${context}: column "${key}" has non-finite value ${val}. NaN and Infinity are not valid SQL values.`)
    }

    if (val !== null && typeof val === 'object' && '__raw' in val) {
      throw new TypeError(`${context}: column "${key}" contains a __raw object. Raw SQL expressions are not allowed in user-facing APIs.`)
    }
  }
}

// --- SQL Assembly from QueryState ---
// Uses QueryAssembler class to keep each method under the line limit.

class QueryAssembler {
  private params: unknown[] = []
  private pidx = 1
  private parts: string[] = []
  private state: QueryState

  constructor(state: QueryState) {
    this.state = state
  }

  assemble(): { sql: string, params: unknown[] } {
    this.assembleCtes()

    switch (this.state.op) {
      case 'select': case 'count': this.assembleSelect()

        break
      case 'insert': this.assembleInsert()

        break
      case 'insert_many': this.assembleInsertMany()

        break
      case 'update': this.assembleUpdate()

        break
      case 'delete': this.assembleDelete()

        break
      case 'merge': this.assembleMerge()

        break
      case 'upsert': this.assembleUpsert()

        break
      case 'raw': this.assembleRaw()

        break
    }

    return { sql: this.parts.join(' '), params: this.params }
  }

  private pushParam(val: unknown): string {
    this.params.push(val)

    return `$${this.pidx++}`
  }

  private assembleWhere(tape: ExprTape): string {
    const result = assembleExpr(tape, this.pidx - 1)

    this.params.push(...result.params)
    this.pidx += result.params.length

    return result.sql
  }

  private appendReturning(): void {
    if (this.state.returning) {
      this.parts.push(`RETURNING ${this.state.returning.length ? quoteCols(this.state.returning) : '*'}`)
    }
  }

  private appendOnConflict(): void {
    if (!this.state.conflictTarget)
      return

    const target = quoteCols(this.state.conflictTarget)

    if (this.state.conflictAction === 'nothing') {
      this.parts.push(`ON CONFLICT (${target}) DO NOTHING`)
    }
    else if (this.state.conflictAction === 'update' && this.state.conflictUpdateCols) {
      let updateCols = this.state.conflictUpdateCols

      // If no specific columns given, update all non-conflict columns from inserted values
      if (updateCols.length === 0) {
        const conflictSet = new Set(this.state.conflictTarget)
        const valueKeys = this.state.insertValues
          ? Object.keys(this.state.insertValues)
          : this.state.insertManyValues?.[0]
            ? Object.keys(this.state.insertManyValues[0])
            : []

        updateCols = valueKeys.filter(k => !conflictSet.has(k))
      }

      if (updateCols.length > 0) {
        const setClauses = updateCols.map(c => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ')

        this.parts.push(`ON CONFLICT (${target}) DO UPDATE SET ${setClauses}`)
      }
      else {
        // No columns to update — fall back to DO NOTHING
        this.parts.push(`ON CONFLICT (${target}) DO NOTHING`)
      }
    }
  }

  private assembleCtes(): void {
    if (!this.state.ctes.length)
      return

    const cteParts = this.state.ctes.map((c) => {
      const mat = c.materialized === true ? 'MATERIALIZED ' : c.materialized === false ? 'NOT MATERIALIZED ' : ''
      let paramIdx = 0
      const cteParams = c.params
      const cteSql = c.sql.replace(/\$\d+/g, () => {
        if (paramIdx < cteParams.length) {
          return this.pushParam(cteParams[paramIdx++])
        }

        return `$${this.pidx}`
      })

      return `${quote(c.name)} AS (${mat}${cteSql})`
    })

    const hasRecursive = this.state.ctes.some(c => c.recursive)

    this.parts.push(`WITH ${hasRecursive ? 'RECURSIVE ' : ''}${cteParts.join(', ')}`)
  }

  private assembleSelect(): void {
    if (this.state.op === 'count') {
      this.parts.push('SELECT count(*)')
    }
    else {
      const distinct = this.state.distinct ? 'DISTINCT ' : this.state.distinctOn.length ? `DISTINCT ON (${quoteCols(this.state.distinctOn)}) ` : ''
      const cols = buildSelectColumns(this.state)

      this.parts.push(`SELECT ${distinct}${cols}`)
    }

    this.parts.push(`FROM ${quote(this.state.table)}${this.state.alias ? ` AS ${quote(this.state.alias)}` : ''}`)

    for (const j of this.state.joins) {
      const joinType = j.type.toUpperCase()
      const onClause = j.on ? ` ON ${this.assembleWhere(j.on)}` : ''

      if (j.type === 'lateral') {
        this.parts.push(`CROSS JOIN LATERAL (${j.table}) AS ${quote(j.alias)}`)
      }
      else {
        this.parts.push(`${joinType} JOIN ${quote(j.table)} AS ${quote(j.alias)}${onClause}`)
      }
    }

    if (this.state.whereTape)
      this.parts.push(`WHERE ${this.assembleWhere(this.state.whereTape)}`)

    if (this.state.groupBy.length)
      this.parts.push(`GROUP BY ${quoteCols(this.state.groupBy)}`)

    if (this.state.havingTape)
      this.parts.push(`HAVING ${this.assembleWhere(this.state.havingTape)}`)

    for (const w of this.state.windows) {
      const partBy = w.partitionBy.length ? `PARTITION BY ${quoteCols(w.partitionBy)}` : ''
      const ordBy = w.orderBy.length ? `ORDER BY ${formatOrderBy(w.orderBy)}` : ''

      this.parts.push(`WINDOW ${quote(w.name)} AS (${[partBy, ordBy].filter(Boolean).join(' ')})`)
    }

    if (this.state.orderBy.length)
      this.parts.push(`ORDER BY ${formatOrderBy(this.state.orderBy)}`)

    if (this.state.limit != null)
      this.parts.push(`LIMIT ${this.pushParam(this.state.limit)}`)

    if (this.state.offset != null)
      this.parts.push(`OFFSET ${this.pushParam(this.state.offset)}`)

    if (this.state.lockMode) {
      this.parts.push(`FOR ${this.state.lockMode.toUpperCase().replaceAll('_', ' ')}`)

      if (this.state.skipLocked)
        this.parts.push('SKIP LOCKED')
    }
  }

  private assembleInsert(): void {
    const vals = this.state.insertValues!
    const keys = Object.keys(vals)
    const colList = quoteCols(keys)
    const valList = keys.map(k => this.pushParam(vals[k])).join(', ')

    this.parts.push(`INSERT INTO ${quote(this.state.table)} (${colList}) VALUES (${valList})`)
    this.appendOnConflict()
    this.appendReturning()
  }

  private assembleInsertMany(): void {
    const rows = this.state.insertManyValues!

    if (rows.length === 0)
      return

    // Union all keys across all rows so missing optional columns use DEFAULT
    const keySet = new Set<string>()

    for (const row of rows) {
      for (const k of Object.keys(row)) keySet.add(k)
    }

    const keys = [...keySet]
    const colList = quoteCols(keys)
    const valueSets = rows.map(row =>
      `(${keys.map(k => k in row ? this.pushParam(row[k]) : 'DEFAULT').join(', ')})`,
    )

    this.parts.push(`INSERT INTO ${quote(this.state.table)} (${colList}) VALUES ${valueSets.join(', ')}`)
    this.appendOnConflict()
    this.appendReturning()
  }

  private assembleUpdate(): void {
    const vals = this.state.setValues!
    const setClauses = Object.entries(vals).map(([k, v]) => {
      if (typeof v === 'object' && v !== null && '__raw' in v) {
        return `${quote(k)} = ${(v as { __raw: string }).__raw}`
      }

      return `${quote(k)} = ${this.pushParam(v)}`
    })

    this.parts.push(`UPDATE ${quote(this.state.table)} SET ${setClauses.join(', ')}`)

    if (this.state.whereTape)
      this.parts.push(`WHERE ${this.assembleWhere(this.state.whereTape)}`)

    this.appendReturning()
  }

  private assembleDelete(): void {
    this.parts.push(`DELETE FROM ${quote(this.state.table)}`)

    if (this.state.whereTape)
      this.parts.push(`WHERE ${this.assembleWhere(this.state.whereTape)}`)

    this.appendReturning()
  }

  private assembleMerge(): void {
    this.parts.push(`MERGE INTO ${quote(this.state.table)}`)

    if (this.state.joins.length) {
      const j = this.state.joins[0]!

      this.parts.push(`USING ${quote(j.table)} AS ${quote(j.alias)}`)

      if (this.state.mergeOn)
        this.parts.push(`ON ${this.assembleWhere(this.state.mergeOn)}`)
    }

    for (const when of this.state.mergeWhen) {
      this.assembleMergeWhen(when)
    }

    this.appendReturning()
  }

  private assembleMergeWhen(when: MergeWhen): void {
    const condStr = when.condition ? ` AND ${this.assembleWhere(when.condition)}` : ''

    if (when.type === 'matched') {
      if (when.action === 'update' && when.values) {
        const setClauses = Object.entries(when.values).map(([k, v]) => {
          if (v && typeof v === 'object' && '__raw' in v) {
            return `${quote(k)} = ${(v as { __raw: string }).__raw}`
          }

          return `${quote(k)} = ${this.pushParam(v)}`
        }).join(', ')

        this.parts.push(`WHEN MATCHED${condStr} THEN UPDATE SET ${setClauses}`)
      }
      else if (when.action === 'delete') {
        this.parts.push(`WHEN MATCHED${condStr} THEN DELETE`)
      }
      else {
        this.parts.push(`WHEN MATCHED${condStr} THEN DO NOTHING`)
      }
    }
    else if (when.type === 'not_matched') {
      if (when.action === 'insert' && when.values) {
        const keys = Object.keys(when.values)
        const cols = quoteCols(keys)
        const vals = keys.map((k) => {
          const v = when.values![k]

          if (v && typeof v === 'object' && '__raw' in v) {
            return (v as { __raw: string }).__raw
          }

          return this.pushParam(v)
        }).join(', ')

        this.parts.push(`WHEN NOT MATCHED${condStr} THEN INSERT (${cols}) VALUES (${vals})`)
      }
      else {
        this.parts.push(`WHEN NOT MATCHED${condStr} THEN DO NOTHING`)
      }
    }
    else if (when.type === 'not_matched_by_source') {
      if (when.action === 'update' && when.values) {
        const setClauses = Object.entries(when.values).map(([k, v]) => {
          if (v && typeof v === 'object' && '__raw' in v) {
            return `${quote(k)} = ${(v as { __raw: string }).__raw}`
          }

          return `${quote(k)} = ${this.pushParam(v)}`
        }).join(', ')

        this.parts.push(`WHEN NOT MATCHED BY SOURCE${condStr} THEN UPDATE SET ${setClauses}`)
      }
      else if (when.action === 'delete') {
        this.parts.push(`WHEN NOT MATCHED BY SOURCE${condStr} THEN DELETE`)
      }
      else {
        this.parts.push(`WHEN NOT MATCHED BY SOURCE${condStr} THEN DO NOTHING`)
      }
    }
  }

  private assembleUpsert(): void {
    const vals = this.state.insertValues!
    const keys = Object.keys(vals)
    const colList = quoteCols(keys)
    const valList = keys.map(k => this.pushParam(vals[k])).join(', ')

    this.parts.push(`INSERT INTO ${quote(this.state.table)} (${colList}) VALUES (${valList})`)

    if (this.state.conflictTarget) {
      const target = quoteCols(this.state.conflictTarget)
      const updateCols = this.state.conflictUpdateCols ?? keys.filter(k => !this.state.conflictTarget!.includes(k))
      const setClauses = updateCols.map(c => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ')

      this.parts.push(`ON CONFLICT (${target}) DO UPDATE SET ${setClauses}`)
    }

    this.appendReturning()
  }

  private assembleRaw(): void {
    let rawSql = this.state.rawSql!
    let paramIdx = 0
    const params = this.state.rawParams

    rawSql = rawSql.replace(/\?/g, () => {
      if (paramIdx < params.length) {
        return this.pushParam(params[paramIdx++])
      }

      return '?'
    })
    this.parts.push(rawSql)
  }
}

export function assembleQuery(state: QueryState): { sql: string, params: unknown[] } {
  return new QueryAssembler(state).assemble()
}

/** @internal */
export function getBuilderState(builder: { _state: QueryState }): QueryState {
  return builder._state
}

function buildSelectColumns(state: QueryState): string {
  const cols: string[] = state.columns
    ? state.columns.filter(c => !state.omitColumns.includes(c)).map(quote)
    : ['*']

  for (const cc of state.computedColumns) {
    cols.push(`${cc.expr} AS ${quote(cc.alias)}`)
  }

  return cols.join(', ') || '*'
}

// --- Base Builder Classes (hierarchy eliminates duplication) ---

abstract class BaseBuilder {
  /** @internal */ _state: QueryState

  constructor(op: QueryOp, table: string) {
    this._state = createState(op, table)
  }

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
  }

  explain(opts?: { analyze?: boolean }): { sql: string, params: unknown[] } {
    const { sql, params } = this.toSQL()
    const analyze = opts?.analyze ? 'ANALYZE, ' : ''

    return { sql: `EXPLAIN (${analyze}FORMAT JSON) ${sql}`, params }
  }
}

abstract class MutationBuilder extends BaseBuilder {
  // returning() is implemented per-subclass for proper return types
}

abstract class WhereableMutationBuilder extends MutationBuilder {
  where(fn: (e: ExprBuilder<any>) => ExprTape): this {
    const builder = createExprBuilder()

    this._state.whereTape = fn(builder)

    return this
  }
}

// --- Query Builder (chainable, mutable, typed) ---

export class SelectBuilder<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TResult = InferSelect<TColumns>,
> extends BaseBuilder {
  constructor(table: string) {
    super('select', table)
  }

  clone(): SelectBuilder<TColumns, TRelations, TResult> {
    const b = new SelectBuilder<TColumns, TRelations, TResult>(this._state.table)

    b._state = cloneState(this._state)

    return b
  }

  /** Select only the specified columns. */
  pick<K extends (keyof TColumns & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Pick<InferSelect<TColumns>, K[number]>> {
    this._state.columns = cols as string[]

    return this as never
  }

  /** Exclude the specified columns from the result. */
  omit<K extends (keyof TColumns & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Omit<InferSelect<TColumns>, K[number]>> {
    this._state.omitColumns = cols as string[]

    return this as never
  }

  /** Add a computed SQL expression as a column in the result. */
  computed<TComputed = unknown>(expr: string, alias: string): SelectBuilder<TColumns, TRelations, TResult & Record<typeof alias, TComputed>> {
    this._state.computedColumns.push({ expr, alias })

    return this as never
  }

  distinct(): this {
    this._state.distinct = true

    return this
  }

  distinctOn<K extends (keyof TColumns & string)[]>(...cols: K): this {
    this._state.distinctOn = cols as string[]

    return this
  }

  /** Set the WHERE clause. Replaces any existing WHERE. */
  where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }

  /** Add an additional AND condition to the existing WHERE clause. */
  andWhere(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()
    const newTape = fn(builder)

    if (this._state.whereTape) {
      // Combine with AND
      this._state.whereTape = [
        { op: OP_AND, count: 2 } as ExprOp,
        ...this._state.whereTape,
        ...newTape,
      ]
    }
    else {
      this._state.whereTape = newTape
    }

    return this
  }

  /** INNER JOIN another table. */
  join(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'inner', table, alias, on: on(builder) })

    return this
  }

  /** LEFT JOIN another table. */
  leftJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'left', table, alias, on: on(builder) })

    return this
  }

  rightJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'right', table, alias, on: on(builder) })

    return this
  }

  fullJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'full', table, alias, on: on(builder) })

    return this
  }

  /** Add an ORDER BY clause. Can be called multiple times for multi-column ordering. */
  orderBy(col: keyof TColumns & string, dir: OrderDir = 'asc', nulls?: 'first' | 'last'): this {
    this._state.orderBy.push({ col, dir, nulls })

    return this
  }

  /** Limit the number of returned rows. */
  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`limit() requires a non-negative integer, got ${n}`)
    }

    this._state.limit = n

    return this
  }

  /** Skip the first N rows. */
  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`offset() requires a non-negative integer, got ${n}`)
    }

    this._state.offset = n

    return this
  }

  groupBy(...cols: (keyof TColumns & string)[]): this {
    this._state.groupBy = cols as string[]

    return this
  }

  having(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.havingTape = fn(builder)

    return this
  }

  /** Add FOR UPDATE row-level locking. */
  forUpdate(): this {
    this._state.lockMode = 'update'

    return this
  }

  forShare(): this {
    this._state.lockMode = 'share'

    return this
  }

  forNoKeyUpdate(): this {
    this._state.lockMode = 'no_key_update'

    return this
  }

  skipLocked(): this {
    this._state.skipLocked = true

    return this
  }

  window(name: string, opts: { partitionBy?: string[], orderBy?: OrderEntry[] }): this {
    this._state.windows.push({ name, partitionBy: opts.partitionBy ?? [], orderBy: opts.orderBy ?? [] })

    return this
  }

  with(name: string, sql: string, params: unknown[] = [], materialized?: boolean): this {
    this._state.ctes.push({ name, sql, params, materialized })

    return this
  }

  withRecursive(name: string, sql: string, params: unknown[] = [], materialized?: boolean): this {
    this._state.ctes.push({ name, sql, params, materialized, recursive: true })

    return this
  }

  as(_alias: string): this {
    this._state.alias = _alias

    return this
  }

  // Typed eager relation loading — constrained to relation names only.
  // hasMany relations always use WHERE fk = ANY($1) batching, never per-row subqueries.
  //
  // Two forms:
  //   .include('posts')                                           — simple include
  //   .include('posts', postsTable, pq => pq.include(...))       — typed callback (filtering + nesting)
  include<K extends keyof TRelations & string>(
    relation: K,
  ): SelectBuilder<TColumns, TRelations, TResult & { [P in K]: InferRelationResult<TRelations[P]> }>
  include<K extends keyof TRelations & string, TTable extends AnyTableDef, TChildResult>(
    relation: K,
    table: TTable,
    callback: (q: SelectBuilder<TTable['columns'], TTable['relations'], InferSelect<TTable['columns']>>) => SelectBuilder<TTable['columns'], TTable['relations'], TChildResult>,
  ): SelectBuilder<TColumns, TRelations, TResult & {
    [P in K]: TRelations[P] extends RelationDef<'hasMany', any, any> ? TChildResult[]
      : TRelations[P] extends RelationDef<'hasManyThrough', any, any> ? TChildResult[]
        : TRelations[P] extends RelationDef<infer _K, any, infer N> ? N extends true ? TChildResult | null : TChildResult
          : TChildResult
  }>
  include(
    relation: string,
    table?: AnyTableDef,
    callback?: IncludeCallback,
  ): SelectBuilder<TColumns, TRelations, any> {
    this._state.includes.push({ relation, strategy: 'batch', callback })

    return this as never
  }

  // Aggregate builder — uses ExprBuilder aggregate methods to build computed columns
  // Usage: .aggregate(e => ({ total: e.sum('amount'), avg: e.avg('price') }))
  aggregate<TAgg extends Record<string, string>>(
    fn: (e: ExprBuilder<TColumns>) => TAgg,
  ): SelectBuilder<TColumns, TRelations, { [K in keyof TAgg]: number }> {
    const builder = createExprBuilder<TColumns>()
    const aggs = fn(builder)

    // Replace columns with aggregates only
    this._state.columns = []

    for (const [alias, expr] of Object.entries(aggs)) {
      this._state.computedColumns.push({ expr, alias })
    }

    return this as never
  }

  count(): SelectBuilder<TColumns, TRelations, { count: number }> {
    this._state.op = 'count'

    return this as never
  }

  /** Include soft-deleted rows in the result. */
  withTrashed(): this {
    this._state.withTrashed = true

    return this
  }
}

export class InsertBuilder<TColumns extends AnyColumns, TResult = void> extends MutationBuilder {
  constructor(table: string) {
    super('insert', table)
  }

  clone(): InsertBuilder<TColumns, TResult> {
    const b = new InsertBuilder<TColumns, TResult>(this._state.table)

    b._state = cloneState(this._state)

    return b
  }

  values(vals: InferInsert<TColumns>): this {
    validateValues(vals as Record<string, unknown>, 'InsertBuilder.values()')
    this._state.insertValues = vals as Record<string, unknown>

    return this
  }

  many(vals: InferInsert<TColumns>[]): this {
    this._state.op = 'insert_many'
    for (const v of vals) {
      validateValues(v as Record<string, unknown>, 'InsertBuilder.many()')
    }
    this._state.insertManyValues = vals as Record<string, unknown>[]

    return this
  }

  onConflict(target: (keyof TColumns & string)[]): OnConflictBuilder<TColumns, TResult> {
    this._state.conflictTarget = target as string[]

    return new OnConflictBuilder(this)
  }

  returning(): InsertBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): InsertBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): InsertBuilder<TColumns, unknown> {
    this._state.returning = cols.length ? cols : []

    return this as never
  }
}

export class OnConflictBuilder<TColumns extends AnyColumns, TResult> {
  constructor(private parent: InsertBuilder<TColumns, TResult>) {}

  doNothing(): InsertBuilder<TColumns, TResult> {
    this.parent._state.conflictAction = 'nothing'

    return this.parent
  }

  doUpdate(...cols: (keyof TColumns & string)[]): InsertBuilder<TColumns, TResult> {
    this.parent._state.conflictAction = 'update'
    this.parent._state.conflictUpdateCols = cols as string[]

    return this.parent
  }
}

export class UpdateBuilder<TColumns extends AnyColumns, _TResult = void> extends WhereableMutationBuilder {
  constructor(table: string) {
    super('update', table)
  }

  clone(): UpdateBuilder<TColumns, _TResult> {
    const b = new UpdateBuilder<TColumns, _TResult>(this._state.table)

    b._state = cloneState(this._state)

    return b
  }

  set(vals: InferUpdate<TColumns>): this {
    validateValues(vals as Record<string, unknown>, 'UpdateBuilder.set()')
    this._state.setValues = vals as Record<string, unknown>

    return this
  }

  override where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }

  returning(): UpdateBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): UpdateBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): UpdateBuilder<TColumns, unknown> {
    this._state.returning = cols.length ? cols : []

    return this as never
  }
}

export class DeleteBuilder<TColumns extends AnyColumns, _TResult = void> extends WhereableMutationBuilder {
  constructor(table: string) {
    super('delete', table)
  }

  clone(): DeleteBuilder<TColumns, _TResult> {
    const b = new DeleteBuilder<TColumns, _TResult>(this._state.table)

    b._state = cloneState(this._state)

    return b
  }

  override where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }

  returning(): DeleteBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): DeleteBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): DeleteBuilder<TColumns, unknown> {
    this._state.returning = cols.length ? cols : []

    return this as never
  }
}

export class MergeBuilder<TColumns extends AnyColumns> extends MutationBuilder {
  constructor(table: string) {
    super('merge', table)
  }

  clone(): MergeBuilder<TColumns> {
    const b = new MergeBuilder<TColumns>(this._state.table)

    b._state = cloneState(this._state)

    return b
  }

  using(sourceTable: string, alias: string): this {
    this._state.joins.push({ type: 'inner', table: sourceTable, alias, on: null })

    return this
  }

  on(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeOn = fn(builder)

    return this
  }

  whenMatched(action: 'update', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'matched',
      action: 'update',
      values,
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenMatchedDelete(condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'matched',
      action: 'delete',
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenNotMatched(action: 'insert', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched',
      action: 'insert',
      values,
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenNotMatchedBySource(action: 'update', values: Record<string, unknown>, condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched_by_source',
      action: 'update',
      values,
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  whenNotMatchedBySourceDelete(condition?: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.mergeWhen.push({
      type: 'not_matched_by_source',
      action: 'delete',
      condition: condition ? condition(builder) : undefined,
    })

    return this
  }

  returning(): MergeBuilder<TColumns>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): MergeBuilder<TColumns>
  returning(...cols: string[]): MergeBuilder<TColumns> {
    this._state.returning = cols.length ? cols : []

    return this as never
  }
}

export class UpsertBuilder<TColumns extends AnyColumns, _TResult = void> extends MutationBuilder {
  constructor(table: string) {
    super('upsert', table)
  }

  clone(): UpsertBuilder<TColumns, _TResult> {
    const b = new UpsertBuilder<TColumns, _TResult>(this._state.table)

    b._state = cloneState(this._state)

    return b
  }

  values(vals: InferInsert<TColumns>): this {
    validateValues(vals as Record<string, unknown>, 'UpsertBuilder.values()')
    this._state.insertValues = vals as Record<string, unknown>

    return this
  }

  onConflict(...cols: (keyof TColumns & string)[]): this {
    this._state.conflictTarget = cols as string[]

    return this
  }

  doUpdate(...cols: (keyof TColumns & string)[]): this {
    this._state.conflictUpdateCols = cols.length ? (cols as string[]) : null

    return this
  }

  returning(): UpsertBuilder<TColumns, InferSelect<TColumns>>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): UpsertBuilder<TColumns, Pick<InferSelect<TColumns>, K[number]>>
  returning(...cols: string[]): UpsertBuilder<TColumns, unknown> {
    this._state.returning = cols.length ? cols : []

    return this as never
  }
}

// --- Set Operations (UNION / INTERSECT / EXCEPT) ---

type SetOp = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'INTERSECT ALL' | 'EXCEPT' | 'EXCEPT ALL'

interface SetOperand {
  sql: string
  params: unknown[]
}

export class SetOperationBuilder<_TResult = Record<string, unknown>> {
  private operands: SetOperand[] = []
  private operators: SetOp[] = []
  private _orderBy: OrderEntry[] = []
  private _limit: number | null = null
  private _offset: number | null = null

  private constructor(first: SetOperand) {
    this.operands.push(first)
  }

  static union<T>(
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('UNION')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  static unionAll<T>(
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('UNION ALL')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  static intersect<T>(
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('INTERSECT')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  static except<T>(
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('EXCEPT')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  orderBy(col: string, dir: OrderDir = 'asc', nulls?: 'first' | 'last'): this {
    this._orderBy.push({ col, dir, nulls })

    return this
  }

  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`limit() requires a non-negative integer, got ${n}`)
    }

    this._limit = n

    return this
  }

  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`offset() requires a non-negative integer, got ${n}`)
    }

    this._offset = n

    return this
  }

  toSQL(): { sql: string, params: unknown[] } {
    const allParams: unknown[] = []
    const parts: string[] = []

    for (let i = 0; i < this.operands.length; i++) {
      if (i > 0)
        parts.push(this.operators[i - 1]!)

      const op = this.operands[i]!
      const offset = allParams.length
      // Re-number $N placeholders with correct offset
      const sql = op.sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`)

      allParams.push(...op.params)
      parts.push(`(${sql})`)
    }

    if (this._orderBy.length)
      parts.push(`ORDER BY ${formatOrderBy(this._orderBy)}`)

    if (this._limit != null) {
      allParams.push(this._limit)
      parts.push(`LIMIT $${allParams.length}`)
    }

    if (this._offset != null) {
      allParams.push(this._offset)
      parts.push(`OFFSET $${allParams.length}`)
    }

    return { sql: parts.join(' '), params: allParams }
  }
}
