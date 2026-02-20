import type { AnyColumns, AnyRelations, InferInsert, InferRelationResult, InferSelect, InferUpdate } from '../types/index'
import type { ExprBuilder, ExprTape } from './expr'
import { assembleExpr, createExprBuilder } from './expr'

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
}

interface WindowEntry {
  name: string
  partitionBy: string[]
  orderBy: OrderEntry[]
}

interface MergeWhen {
  type: 'matched' | 'not_matched'
  condition?: ExprTape
  action: 'update' | 'insert' | 'delete' | 'nothing'
  values?: Record<string, unknown>
}

// Eager include entry — drives batched relation loading (no N+1)
export interface IncludeEntry {
  relation: string
  strategy: 'batch' | 'lateral'
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
      this.parts.push(`RETURNING ${this.state.returning.length ? this.state.returning.map(c => `"${c}"`).join(', ') : '*'}`)
    }
  }

  private appendOnConflict(): void {
    if (!this.state.conflictTarget)
      return

    const target = this.state.conflictTarget.map(c => `"${c}"`).join(', ')

    if (this.state.conflictAction === 'nothing') {
      this.parts.push(`ON CONFLICT (${target}) DO NOTHING`)
    }
    else if (this.state.conflictAction === 'update' && this.state.conflictUpdateCols) {
      const setClauses = this.state.conflictUpdateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')

      this.parts.push(`ON CONFLICT (${target}) DO UPDATE SET ${setClauses}`)
    }
  }

  private assembleCtes(): void {
    if (!this.state.ctes.length)
      return

    const cteParts = this.state.ctes.map((c) => {
      const mat = c.materialized === true ? 'MATERIALIZED ' : c.materialized === false ? 'NOT MATERIALIZED ' : ''
      let cteSql = c.sql

      for (const p of c.params) {
        cteSql = cteSql.replace(/\$\d+/, this.pushParam(p))
      }

      return `"${c.name}" AS (${mat}${cteSql})`
    })

    this.parts.push(`WITH ${cteParts.join(', ')}`)
  }

  private assembleSelect(): void {
    if (this.state.op === 'count') {
      this.parts.push('SELECT count(*)')
    }
    else {
      const distinct = this.state.distinct ? 'DISTINCT ' : this.state.distinctOn.length ? `DISTINCT ON (${this.state.distinctOn.map(c => `"${c}"`).join(', ')}) ` : ''
      const cols = buildSelectColumns(this.state)

      this.parts.push(`SELECT ${distinct}${cols}`)
    }

    this.parts.push(`FROM "${this.state.table}"${this.state.alias ? ` AS "${this.state.alias}"` : ''}`)

    for (const j of this.state.joins) {
      const joinType = j.type.toUpperCase()
      const onClause = j.on ? ` ON ${this.assembleWhere(j.on)}` : ''

      if (j.type === 'lateral') {
        this.parts.push(`CROSS JOIN LATERAL (${j.table}) AS "${j.alias}"`)
      }
      else {
        this.parts.push(`${joinType} JOIN "${j.table}" AS "${j.alias}"${onClause}`)
      }
    }

    if (this.state.whereTape)
      this.parts.push(`WHERE ${this.assembleWhere(this.state.whereTape)}`)

    if (this.state.groupBy.length)
      this.parts.push(`GROUP BY ${this.state.groupBy.map(c => `"${c}"`).join(', ')}`)

    if (this.state.havingTape)
      this.parts.push(`HAVING ${this.assembleWhere(this.state.havingTape)}`)

    for (const w of this.state.windows) {
      const partBy = w.partitionBy.length ? `PARTITION BY ${w.partitionBy.map(c => `"${c}"`).join(', ')}` : ''
      const ordBy = w.orderBy.length ? `ORDER BY ${w.orderBy.map(o => `"${o.col}" ${o.dir.toUpperCase()}${o.nulls ? ` NULLS ${o.nulls.toUpperCase()}` : ''}`).join(', ')}` : ''

      this.parts.push(`WINDOW "${w.name}" AS (${[partBy, ordBy].filter(Boolean).join(' ')})`)
    }

    if (this.state.orderBy.length)
      this.parts.push(`ORDER BY ${this.state.orderBy.map(o => `"${o.col}" ${o.dir.toUpperCase()}${o.nulls ? ` NULLS ${o.nulls.toUpperCase()}` : ''}`).join(', ')}`)

    if (this.state.limit != null)
      this.parts.push(`LIMIT ${this.state.limit}`)

    if (this.state.offset != null)
      this.parts.push(`OFFSET ${this.state.offset}`)

    if (this.state.lockMode) {
      this.parts.push(`FOR ${this.state.lockMode.toUpperCase().replace('_', ' ')}`)

      if (this.state.skipLocked)
        this.parts.push('SKIP LOCKED')
    }
  }

  private assembleInsert(): void {
    const vals = this.state.insertValues!
    const keys = Object.keys(vals)
    const colList = keys.map(k => `"${k}"`).join(', ')
    const valList = keys.map(k => this.pushParam(vals[k])).join(', ')

    this.parts.push(`INSERT INTO "${this.state.table}" (${colList}) VALUES (${valList})`)
    this.appendOnConflict()
    this.appendReturning()
  }

  private assembleInsertMany(): void {
    const rows = this.state.insertManyValues!

    if (rows.length === 0)
      return

    const keys = Object.keys(rows[0]!)
    const colList = keys.map(k => `"${k}"`).join(', ')
    const valueSets = rows.map(row => `(${keys.map(k => this.pushParam(row[k])).join(', ')})`)

    this.parts.push(`INSERT INTO "${this.state.table}" (${colList}) VALUES ${valueSets.join(', ')}`)
    this.appendOnConflict()
    this.appendReturning()
  }

  private assembleUpdate(): void {
    const vals = this.state.setValues!
    const setClauses = Object.entries(vals).map(([k, v]) => {
      if (typeof v === 'object' && v !== null && '__raw' in v) {
        return `"${k}" = ${(v as { __raw: string }).__raw}`
      }

      return `"${k}" = ${this.pushParam(v)}`
    })

    this.parts.push(`UPDATE "${this.state.table}" SET ${setClauses.join(', ')}`)

    if (this.state.whereTape)
      this.parts.push(`WHERE ${this.assembleWhere(this.state.whereTape)}`)

    this.appendReturning()
  }

  private assembleDelete(): void {
    this.parts.push(`DELETE FROM "${this.state.table}"`)

    if (this.state.whereTape)
      this.parts.push(`WHERE ${this.assembleWhere(this.state.whereTape)}`)

    this.appendReturning()
  }

  private assembleMerge(): void {
    this.parts.push(`MERGE INTO "${this.state.table}"`)

    if (this.state.joins.length) {
      const j = this.state.joins[0]!

      this.parts.push(`USING "${j.table}" AS "${j.alias}"`)

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
        const setClauses = Object.entries(when.values).map(([k, v]) => `"${k}" = ${this.pushParam(v)}`).join(', ')

        this.parts.push(`WHEN MATCHED${condStr} THEN UPDATE SET ${setClauses}`)
      }
      else if (when.action === 'delete') {
        this.parts.push(`WHEN MATCHED${condStr} THEN DELETE`)
      }
      else {
        this.parts.push(`WHEN MATCHED${condStr} THEN DO NOTHING`)
      }
    }
    else if (when.action === 'insert' && when.values) {
      const keys = Object.keys(when.values)
      const cols = keys.map(k => `"${k}"`).join(', ')
      const vals = keys.map(k => this.pushParam(when.values![k])).join(', ')

      this.parts.push(`WHEN NOT MATCHED${condStr} THEN INSERT (${cols}) VALUES (${vals})`)
    }
    else {
      this.parts.push(`WHEN NOT MATCHED${condStr} THEN DO NOTHING`)
    }
  }

  private assembleUpsert(): void {
    const vals = this.state.insertValues!
    const keys = Object.keys(vals)
    const colList = keys.map(k => `"${k}"`).join(', ')
    const valList = keys.map(k => this.pushParam(vals[k])).join(', ')

    this.parts.push(`INSERT INTO "${this.state.table}" (${colList}) VALUES (${valList})`)

    if (this.state.conflictTarget) {
      const target = this.state.conflictTarget.map(c => `"${c}"`).join(', ')
      const updateCols = this.state.conflictUpdateCols ?? keys.filter(k => !this.state.conflictTarget!.includes(k))
      const setClauses = updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(', ')

      this.parts.push(`ON CONFLICT (${target}) DO UPDATE SET ${setClauses}`)
    }

    this.appendReturning()
  }

  private assembleRaw(): void {
    let rawSql = this.state.rawSql!

    for (const p of this.state.rawParams) {
      rawSql = rawSql.replace('?', this.pushParam(p))
    }
    this.parts.push(rawSql)
  }
}

export function assembleQuery(state: QueryState): { sql: string, params: unknown[] } {
  return new QueryAssembler(state).assemble()
}

function buildSelectColumns(state: QueryState): string {
  const cols: string[] = state.columns
    ? state.columns.filter(c => !state.omitColumns.includes(c)).map(c => `"${c}"`)
    : ['*']

  for (const cc of state.computedColumns) {
    cols.push(`${cc.expr} AS "${cc.alias}"`)
  }

  return cols.join(', ') || '*'
}

// --- Query Builder (chainable, mutable, typed) ---

export class SelectBuilder<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TResult = InferSelect<TColumns>,
> {
  /** @internal */ _state: QueryState

  constructor(table: string) {
    this._state = createState('select', table)
  }

  pick<K extends (keyof TColumns & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Pick<InferSelect<TColumns>, K[number]>> {
    this._state.columns = cols as string[]

    return this as never
  }

  omit<K extends (keyof TColumns & string)[]>(...cols: K): SelectBuilder<TColumns, TRelations, Omit<InferSelect<TColumns>, K[number]>> {
    this._state.omitColumns = cols as string[]

    return this as never
  }

  computed(expr: string, alias: string): SelectBuilder<TColumns, TRelations, TResult & Record<string, unknown>> {
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

  where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }

  andWhere(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()
    const newTape = fn(builder)

    if (this._state.whereTape) {
      // Combine with AND
      this._state.whereTape = [
        { op: 0 /* OP_AND */, count: 2 } as import('./expr').ExprOp,
        ...this._state.whereTape,
        ...newTape,
      ]
    }
    else {
      this._state.whereTape = newTape
    }

    return this
  }

  join(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'inner', table, alias, on: on(builder) })

    return this
  }

  leftJoin(table: string, alias: string, on: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.joins.push({ type: 'left', table, alias, on: on(builder) })

    return this
  }

  orderBy(col: keyof TColumns & string, dir: OrderDir = 'asc', nulls?: 'first' | 'last'): this {
    this._state.orderBy.push({ col: col as string, dir, nulls })

    return this
  }

  limit(n: number): this {
    this._state.limit = n

    return this
  }

  offset(n: number): this {
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

  as(_alias: string): this {
    this._state.alias = _alias

    return this
  }

  // Typed eager relation loading — constrained to relation names only.
  // hasMany relations always use WHERE fk = ANY($1) batching, never per-row subqueries.
  include<K extends keyof TRelations & string>(
    relation: K,
    opts?: { strategy?: 'batch' | 'lateral' },
  ): SelectBuilder<TColumns, TRelations, TResult & { [P in K]: InferRelationResult<TRelations[P]> }> {
    this._state.includes.push({ relation, strategy: opts?.strategy ?? 'batch' })

    return this as never
  }

  count(): SelectBuilder<TColumns, TRelations, { count: number }> {
    this._state.op = 'count'

    return this as never
  }

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
  }
}

export class InsertBuilder<TColumns extends AnyColumns, TResult = void> {
  /** @internal */ _state: QueryState

  constructor(table: string) {
    this._state = createState('insert', table)
  }

  values(vals: InferInsert<TColumns>): this {
    this._state.insertValues = vals as Record<string, unknown>

    return this
  }

  many(vals: InferInsert<TColumns>[]): this {
    this._state.op = 'insert_many'
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

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
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

export class UpdateBuilder<TColumns extends AnyColumns, _TResult = void> {
  /** @internal */ _state: QueryState

  constructor(table: string) {
    this._state = createState('update', table)
  }

  set(vals: InferUpdate<TColumns>): this {
    this._state.setValues = vals as Record<string, unknown>

    return this
  }

  where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
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

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
  }
}

export class DeleteBuilder<TColumns extends AnyColumns, _TResult = void> {
  /** @internal */ _state: QueryState

  constructor(table: string) {
    this._state = createState('delete', table)
  }

  where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
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

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
  }
}

export class MergeBuilder<TColumns extends AnyColumns> {
  /** @internal */ _state: QueryState

  constructor(table: string) {
    this._state = createState('merge', table)
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

  returning(): MergeBuilder<TColumns>
  returning<K extends (keyof TColumns & string)[]>(...cols: K): MergeBuilder<TColumns>
  returning(...cols: string[]): MergeBuilder<TColumns> {
    this._state.returning = cols.length ? cols : []

    return this as never
  }

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
  }
}

export class UpsertBuilder<TColumns extends AnyColumns, _TResult = void> {
  /** @internal */ _state: QueryState

  constructor(table: string) {
    this._state = createState('upsert', table)
  }

  values(vals: InferInsert<TColumns>): this {
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

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
  }
}
