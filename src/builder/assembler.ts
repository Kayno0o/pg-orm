import type { Dialect } from '../dialect'
import type { ExprTape } from './_tape'
import type { BuilderState, MergeWhen, OrderEntry } from './state'
import { DialectError, ValidationError } from '../errors/index'
import { qualifyCol, quote, quotePath } from '../sql/utils'
import { bindRawParams, shiftPlaceholders } from './_placeholders'
import { assembleExpr, assertColumn, holdsForEveryRow, isSqlValue, OP_AND, OP_IS_NULL, OP_RAW } from './_tape'
import { isConflictValue } from './conflict'
import { isRawSql, joinKeyword, joinQualifier, lockKeyword, orderSuffix, quoteCols, selectedColumns } from './state'

/**
 * Single bottleneck for placeholder counting and parameter accumulation.
 * Every clause printer flows through one instance per query, so `$N` numbering
 * stays linear and identifier quoting always goes through `quote()` / `quotePath()`.
 */
class SqlBuilder {
  readonly params: unknown[] = []
  pidx: number
  readonly parts: string[] = []
  // The table's own columns and the select's output aliases, when known: a bare name outside them is refused.
  columns?: ReadonlySet<string>
  outputs?: ReadonlySet<string>

  constructor(readonly dialect: Dialect, paramOffset: number) {
    this.pidx = paramOffset + 1
  }

  column(name: string, qualifier?: string): string {
    assertColumn(name, this.columns)

    return qualifyCol(name, qualifier)
  }

  // An output alias (a computed column, a count) sorts unqualified; anything else is a column.
  orderColumn(name: string, qualifier?: string): string {
    return this.outputs?.has(name) ? quote(name) : this.column(name, qualifier)
  }

  postgresOnly(feature: string): void {
    if (this.dialect !== 'postgres')
      throw new DialectError(feature, this.dialect)
  }

  pushParam(val: unknown): string {
    this.params.push(val)

    return `$${this.pidx++}`
  }

  push(part: string): void {
    this.parts.push(part)
  }

  /** Splice an expression tape into the running SQL stream, bumping param state. `columns: null` checks no name, for a clause naming other tables' columns or aliases. */
  inlineExpr(tape: ExprTape, qualifier?: string, columns: ReadonlySet<string> | null = this.columns ?? null): string {
    const result = assembleExpr(tape, this.pidx - 1, qualifier, this.dialect, columns ?? undefined)

    this.params.push(...result.params)
    this.pidx += result.params.length

    return result.sql
  }

  toResult(): { sql: string, params: unknown[] } {
    return { sql: this.parts.join(' '), params: this.params }
  }
}

// --- CTE ---

function printCtes(sb: SqlBuilder, ctes: BuilderState['ctes']): void {
  if (!ctes.length)
    return

  const cteParts = ctes.map((c) => {
    const mat = c.materialized === true ? 'MATERIALIZED ' : c.materialized === false ? 'NOT MATERIALIZED ' : ''

    if (c.query) {
      const built = c.query.toSQL(sb.pidx - 1, sb.dialect)

      sb.params.push(...built.params)
      sb.pidx += built.params.length

      return `${quote(c.name)} AS (${mat}${built.sql})`
    }

    // Renumber $N placeholders by captured index + current offset, then push params.
    // This preserves duplicate references (`$1 ... $1`) and out-of-order references
    // (`$2 ... $1`) — both would be silently miscompiled by occurrence-based mapping.
    const offset = sb.pidx - 1
    const cteSql = shiftPlaceholders(c.sql, offset)

    sb.params.push(...c.params)
    sb.pidx += c.params.length

    return `${quote(c.name)} AS (${mat}${cteSql})`
  })

  const hasRecursive = ctes.some(c => c.recursive)

  sb.push(`WITH ${hasRecursive ? 'RECURSIVE ' : ''}${cteParts.join(', ')}`)
}

// --- Shared clause printers ---

// A statement reading other tables (UPDATE ... FROM, DELETE ... USING) returns only its own table's columns: a bare * would bring theirs along on Postgres.
function printReturning(sb: SqlBuilder, state: BuilderState): void {
  const { returning, returningExtra: extra } = state

  if (!returning)
    return

  const q = state.fromTables?.length ? state.table : undefined
  const all = q && sb.dialect === 'postgres' ? `${quote(q)}.*` : '*'

  sb.push(`RETURNING ${returning.length ? returning.map(col => sb.column(col, q)).join(', ') : all}${extra ? `, ${extra}` : ''}`)
}

// The columns an insert writes. Rows writing different ones are refused: copying them on conflict would overwrite a column a row left out with its default.
function incomingColumns(state: BuilderState): string[] {
  if (state.insertValues)
    return Object.keys(state.insertValues)

  if (state.insertSelect)
    return state.insertSelect.columns

  const rows = state.insertManyValues ?? []
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))]
  const missing = keys.find(k => rows.some(row => !(k in row)))

  if (missing !== undefined)
    throw new ValidationError(`ON CONFLICT DO UPDATE: some rows leave out "${missing}", which copying the incoming columns would reset to its default. Give every row the same columns, or name the columns to copy.`, 'onConflict', { field: missing })

  return keys
}

function printOnConflict(sb: SqlBuilder, state: BuilderState): void {
  if (!state.conflictTarget)
    return

  // No target skips a row conflicting on any constraint, which only DO NOTHING can do.
  const target = state.conflictTarget.length ? ` (${quoteCols(state.conflictTarget)})` : ''

  if (state.conflictAction !== 'update') {
    if (state.conflictAction === 'nothing')
      sb.push(`ON CONFLICT${target} DO NOTHING`)

    return
  }

  if (!target)
    throw new ValidationError('ON CONFLICT DO UPDATE needs the conflict target: name the columns in onConflict().', 'onConflict')

  const set = state.conflictSet ?? {}
  // `[]` copies every incoming column but the target, `null` copies none.
  let copies = state.conflictUpdateCols ?? []

  if (state.conflictUpdateCols?.length === 0) {
    const conflictSet = new Set(state.conflictTarget)

    copies = incomingColumns(state).filter(k => !conflictSet.has(k))
  }

  const clauses = copies.filter(c => !(c in set)).map(c => `${quote(c)} = EXCLUDED.${quote(c)}`)

  for (const [col, value] of Object.entries(set)) {
    const rendered = isConflictValue(value)
      ? sb.inlineExpr([{ op: OP_RAW, sql: value.sql, params: [...value.params] }])
      : printValue(sb, value)

    clauses.push(`${quote(col)} = ${rendered}`)
  }

  // Nothing to write still updates the target to itself, so the conflicting row comes back through RETURNING like an updated one.
  if (clauses.length === 0)
    clauses.push(...state.conflictTarget.map(c => `${quote(c)} = EXCLUDED.${quote(c)}`))

  const guard = state.conflictWhere ? ` WHERE ${sb.inlineExpr(state.conflictWhere, state.table)}` : ''

  sb.push(`ON CONFLICT${target} DO UPDATE SET ${clauses.join(', ')}${guard}`)
}

function printWhere(sb: SqlBuilder, tape: ExprTape | null, qualifier?: string): void {
  if (tape)
    sb.push(`WHERE ${sb.inlineExpr(tape, qualifier)}`)
}

// --- SELECT pieces ---

// A joined column comes back under its `alias.col` name, so it neither collides with the table's own nor is lost.
function printSelectColumns(sb: SqlBuilder, state: BuilderState): string {
  const q = joinQualifier(state)

  for (const col of state.omitColumns) assertColumn(col, sb.columns)

  const cols: string[] = selectedColumns(state)?.map(col => col.includes('.') ? `${quotePath(col)} AS ${quote(col)}` : sb.column(col, q)) ?? [q ? `${quote(q)}.*` : '*']

  for (const cc of state.computedColumns) {
    // `cc.expr` is interpolated unparameterized. Inputs are constrained at the
    // entry points: `computed()` produces strings via the safe `ExprBuilder`,
    // and `computedRaw()` runs the string through `validateRawSqlFragment`
    // (rejects `;`, `--`, `/*`, dollar-quotes, unterminated strings). The
    // alias is bound by `validateIdentifier`. Do not introduce a new caller
    // here without applying both.
    const expr = cc.tape ? sb.inlineExpr(cc.tape, q) : cc.filter ? `(${cc.expr} AND ${sb.inlineExpr(cc.filter.tape, cc.filter.qualifier, null)})` : cc.expr

    cols.push(`${expr} AS ${quote(cc.alias)}`)
  }

  return cols.join(', ') || '*'
}

// Postgres names a bare `count(*)` column `count`, SQLite names it after the expression.
function countColumn(sb: SqlBuilder): string {
  return sb.dialect === 'sqlite' ? 'count(*) AS "count"' : 'count(*)'
}

function printSelectHead(sb: SqlBuilder, state: BuilderState, counted: boolean): void {
  if (counted) {
    sb.push(`SELECT ${countColumn(sb)}`)

    return
  }

  if (state.distinctOn.length && !state.distinct)
    sb.postgresOnly('distinctOn()')

  const distinct = state.distinct
    ? 'DISTINCT '
    : state.distinctOn.length ? `DISTINCT ON (${state.distinctOn.map(col => sb.column(col, joinQualifier(state))).join(', ')}) ` : ''

  sb.push(`SELECT ${distinct}${printSelectColumns(sb, state)}`)
}

function printFrom(sb: SqlBuilder, state: BuilderState): void {
  sb.push(`FROM ${quote(state.table)}${state.alias !== undefined ? ` AS ${quote(state.alias)}` : ''}`)
}

function printJoins(sb: SqlBuilder, state: BuilderState): void {
  for (const j of state.joins) {
    const joinType = joinKeyword(j.type)
    const onClause = j.on ? ` ON ${sb.inlineExpr(j.on, joinQualifier(state))}` : ''

    sb.push(`${joinType} JOIN ${quote(j.table)} AS ${quote(j.alias)}${onClause}`)
  }
}

// An ORDER BY list, an entry naming a column or holding an expression whose params bind in place.
function printOrder(sb: SqlBuilder, entries: OrderEntry[], qualifier?: string): string {
  return entries.map(o => `${o.expr ? sb.inlineExpr(o.expr, qualifier) : sb.orderColumn(o.col, qualifier)} ${orderSuffix(o)}`).join(', ')
}

function printGroupHaving(sb: SqlBuilder, state: BuilderState): void {
  const q = joinQualifier(state)
  const groups = [...state.groupBy.map(col => sb.column(col, q)), ...(state.groupByExprs ?? []).map(expr => sb.inlineExpr(expr, q))]

  if (groups.length)
    sb.push(`GROUP BY ${groups.join(', ')}`)

  if (state.havingTape)
    sb.push(`HAVING ${sb.inlineExpr(state.havingTape, q, null)}`)
}

function printWindows(sb: SqlBuilder, state: BuilderState): void {
  const q = joinQualifier(state)

  for (const w of state.windows) {
    const partBy = w.partitionBy.length ? `PARTITION BY ${w.partitionBy.map(col => sb.column(col, q)).join(', ')}` : ''
    const ordBy = w.orderBy.length ? `ORDER BY ${printOrder(sb, w.orderBy, q)}` : ''

    sb.push(`WINDOW ${quote(w.name)} AS (${[partBy, ordBy].filter(Boolean).join(' ')})`)
  }
}

function printOrderLimit(sb: SqlBuilder, state: BuilderState): void {
  if (state.orderBy.length)
    sb.push(`ORDER BY ${printOrder(sb, state.orderBy, joinQualifier(state))}`)

  if (state.limit != null)
    sb.push(`LIMIT ${sb.pushParam(state.limit)}`)
  // SQLite only takes an OFFSET after a LIMIT, and -1 is no limit.
  else if (state.offset != null && sb.dialect === 'sqlite')
    sb.push('LIMIT -1')

  if (state.offset != null)
    sb.push(`OFFSET ${sb.pushParam(state.offset)}`)
}

// A SQLite transaction holds the whole database's write lock from its first statement, so it never meets a locked row: the clause is dropped, which SKIP LOCKED included keeps the semantics.
function printLock(sb: SqlBuilder, state: BuilderState): void {
  const modifier = state.skipLocked ? 'skipLocked' : state.noWait ? 'noWait' : state.lockOf?.length ? 'lockOf' : null

  if (modifier && !state.lockMode)
    throw new ValidationError(`${modifier}() needs a lock: call forUpdate(), forNoKeyUpdate(), forShare() or forKeyShare() too.`, modifier)

  if (state.skipLocked && state.noWait)
    throw new ValidationError('skipLocked() and noWait() cannot both apply: a locked row is either skipped or an error.', 'noWait')

  if (!state.lockMode || sb.dialect === 'sqlite')
    return

  sb.push(`FOR ${lockKeyword(state.lockMode)}`)

  if (state.lockOf?.length)
    sb.push(`OF ${state.lockOf.map(quote).join(', ')}`)

  if (state.skipLocked)
    sb.push('SKIP LOCKED')

  if (state.noWait)
    sb.push('NOWAIT')
}

// Trashed rows are left out here rather than when the repository hands the builder over, so a withTrashed() called later still lets them in.
function selectWhere(state: BuilderState): ExprTape | null {
  if (!state.softDeleteColumn || state.withTrashed)
    return state.whereTape

  const live: ExprTape = [{ op: OP_IS_NULL, col: state.softDeleteColumn }]

  return state.whereTape ? [{ op: OP_AND, count: 2 }, ...state.whereTape, ...live] : live
}

export const PARTITION_RANK = '__pgorm_rn'

// Rows numbered within each `limitPer` value, the window keeping the query's order, then cut to the offset and limit; the rank column comes back with the rows.
function printPartitionedSelect(sb: SqlBuilder, state: BuilderState, column: string): void {
  const order = state.orderBy.length ? ` ORDER BY ${printOrder(sb, state.orderBy, joinQualifier(state))}` : ''
  const rank = { expr: `ROW_NUMBER() OVER (PARTITION BY ${qualifyCol(column, joinQualifier(state))}${order})`, alias: PARTITION_RANK }
  const offset = state.offset ?? 0

  sb.push('SELECT * FROM (')
  printSelect(sb, { ...state, computedColumns: [...state.computedColumns, rank], orderBy: [], limit: null, offset: null, limitPer: undefined, lockMode: null })
  sb.push(`) AS "__pgorm_part" WHERE ${quote(PARTITION_RANK)} > ${sb.pushParam(offset)}`)

  if (state.limit != null)
    sb.push(`AND ${quote(PARTITION_RANK)} <= ${sb.pushParam(offset + state.limit)}`)

  sb.push(`ORDER BY ${quote(PARTITION_RANK)}`)
}

function printSelect(sb: SqlBuilder, state: BuilderState): void {
  if (state.limitPer && state.op === 'select' && (state.limit != null || state.offset != null)) {
    printPartitionedSelect(sb, state, state.limitPer)

    return
  }

  // A grouped or distinct query has fewer result rows than matched rows, so its count wraps the query instead of replacing its column list.
  const wrapCount = state.op === 'count' && (state.groupBy.length > 0 || state.distinct || state.distinctOn.length > 0)

  if (wrapCount)
    sb.push(`SELECT ${countColumn(sb)} FROM (`)

  // The wrapped query lists its group columns: Postgres refuses a * that is not grouped.
  const inner = wrapCount && !state.columns && state.groupBy.length > 0 ? { ...state, columns: [...state.groupBy] } : state

  printSelectHead(sb, inner, state.op === 'count' && !wrapCount)
  printFrom(sb, state)
  printJoins(sb, state)
  printWhere(sb, selectWhere(state), joinQualifier(state))
  printGroupHaving(sb, state)
  printWindows(sb, state)
  printOrderLimit(sb, state)
  printLock(sb, state)

  if (wrapCount)
    sb.push(') AS "__counted"')
}

// --- INSERT / UPDATE / DELETE ---

// SQLite reads an ON CONFLICT after a bare SELECT as a join constraint: the WHERE wrapping the query ends it first.
function printInsertSelect(sb: SqlBuilder, state: BuilderState, insert: NonNullable<BuilderState['insertSelect']>): void {
  if (insert.columns.length === 0)
    throw new ValidationError('InsertBuilder.fromSelect() needs at least one column.', 'InsertBuilder.fromSelect()')

  const built = insert.query.toSQL(sb.pidx - 1, sb.dialect)

  sb.params.push(...built.params)
  sb.pidx += built.params.length

  const query = sb.dialect === 'sqlite' ? `SELECT * FROM (${built.sql}) WHERE true` : built.sql

  sb.push(`INSERT INTO ${quote(state.table)} (${quoteCols(insert.columns)}) ${query}`)
  printOnConflict(sb, state)
  printReturning(sb, state)
}

function printInsert(sb: SqlBuilder, state: BuilderState): void {
  if (state.insertSelect) {
    printInsertSelect(sb, state, state.insertSelect)

    return
  }

  const vals = state.insertValues!
  const keys = Object.keys(vals)

  // No columns supplied → let every column take its default. `() VALUES ()` is a
  // syntax error in Postgres; `DEFAULT VALUES` is the correct empty-row insert.
  if (keys.length === 0) {
    sb.push(`INSERT INTO ${quote(state.table)} DEFAULT VALUES`)
    printOnConflict(sb, state)
    printReturning(sb, state)

    return
  }

  const colList = quoteCols(keys)
  const valList = keys.map(k => printValue(sb, vals[k])).join(', ')

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES (${valList})`)
  printOnConflict(sb, state)
  printReturning(sb, state)
}

// A column a row leaves out takes its default, which SQLite cannot ask for by `DEFAULT` inside VALUES: there the default's own expression is written out, from the table the repository knows.
function insertValue(sb: SqlBuilder, state: BuilderState, row: Record<string, unknown>, key: string): string {
  if (key in row)
    return printValue(sb, row[key])

  if (sb.dialect === 'postgres')
    return 'DEFAULT'

  const fallback = state.defaultSql?.[key]

  if (fallback === undefined)
    throw new DialectError('Rows leaving out different columns in one insert built outside a repository', sb.dialect)

  return fallback
}

function printInsertMany(sb: SqlBuilder, state: BuilderState): void {
  const rows = state.insertManyValues!

  if (rows.length === 0)
    throw new ValidationError('InsertBuilder.many() needs at least one row.', 'InsertBuilder.many()')

  const keySet = new Set<string>()

  for (const row of rows) {
    for (const k of Object.keys(row)) keySet.add(k)
  }

  const keys = [...keySet]

  // One row of defaults has its own syntax; several have none that names no column.
  if (keys.length === 0) {
    if (rows.length > 1)
      throw new ValidationError('InsertBuilder.many(): rows with no columns cannot share one INSERT; insert them one by one.', 'InsertBuilder.many()')

    sb.push(`INSERT INTO ${quote(state.table)} DEFAULT VALUES`)
    printOnConflict(sb, state)
    printReturning(sb, state)

    return
  }

  const colList = quoteCols(keys)
  const valueSets = rows.map(row =>
    `(${keys.map(k => insertValue(sb, state, row, k)).join(', ')})`,
  )

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES ${valueSets.join(', ')}`)
  printOnConflict(sb, state)
  printReturning(sb, state)
}

// A value written into a statement: a raw fragment (`setRaw`) as is, an expression as its SQL, anything else bound.
function printValue(sb: SqlBuilder, v: unknown, qualifier?: string): string {
  if (isRawSql(v))
    return v.__raw

  return isSqlValue(v) ? sb.inlineExpr(v, qualifier) : sb.pushParam(v)
}

function printSetClauses(sb: SqlBuilder, values: Record<string, unknown>, qualifier?: string): string {
  return Object.entries(values).map(([k, v]) => `${quote(k)} = ${printValue(sb, v, qualifier)}`).join(', ')
}

function printUpdate(sb: SqlBuilder, state: BuilderState): void {
  if (!state.setValues || Object.keys(state.setValues).length === 0) {
    throw new ValidationError(
      `update() on "${state.table}" has no columns to set`,
      'update',
    )
  }

  requireWhereOrAllRows(state)

  const q = state.fromTables?.length ? state.table : undefined
  const setClauses = printSetClauses(sb, state.setValues, q)

  sb.push(`UPDATE ${quote(state.table)} SET ${setClauses}`)

  if (q)
    sb.push(`FROM ${fromList(state)}`)

  printWhere(sb, state.whereTape, q)
  printReturning(sb, state)
}

// A falsy where() is a no-op and an empty AND holds, so a builder whose every condition came out falsy or empty would otherwise reach the whole table.
function requireWhereOrAllRows(state: BuilderState): void {
  if ((!state.whereTape || holdsForEveryRow(state.whereTape)) && !state.allRows)
    throw new ValidationError(`${state.op}() on "${state.table}" has no WHERE, or one every row passes: call allRows() to reach every row on purpose.`, state.op)
}

// The other tables an UPDATE ... FROM or DELETE ... USING reads, each under its alias.
function fromList(state: BuilderState): string {
  return (state.fromTables ?? []).map(t => `${quote(t.table)} AS ${quote(t.alias)}`).join(', ')
}

function printDelete(sb: SqlBuilder, state: BuilderState): void {
  requireWhereOrAllRows(state)
  sb.push(`DELETE FROM ${quote(state.table)}`)

  const q = state.fromTables?.length ? state.table : undefined

  if (q) {
    sb.postgresOnly('DELETE ... USING')
    sb.push(`USING ${fromList(state)}`)
  }

  printWhere(sb, state.whereTape, q)
  printReturning(sb, state)
}

// --- MERGE ---

function printMergeWhen(sb: SqlBuilder, when: MergeWhen): void {
  const condStr = when.condition ? ` AND ${sb.inlineExpr(when.condition)}` : ''

  if (when.type === 'matched') {
    if (when.action === 'update' && when.values) {
      sb.push(`WHEN MATCHED${condStr} THEN UPDATE SET ${printSetClauses(sb, when.values)}`)
    }
    else if (when.action === 'delete') {
      sb.push(`WHEN MATCHED${condStr} THEN DELETE`)
    }
    else {
      sb.push(`WHEN MATCHED${condStr} THEN DO NOTHING`)
    }

    return
  }

  if (when.type === 'not_matched') {
    if (when.action === 'insert' && when.values) {
      const keys = Object.keys(when.values)
      const cols = quoteCols(keys)
      const vals = keys.map(k => printValue(sb, when.values![k])).join(', ')

      sb.push(`WHEN NOT MATCHED${condStr} THEN INSERT (${cols}) VALUES (${vals})`)
    }
    else {
      sb.push(`WHEN NOT MATCHED${condStr} THEN DO NOTHING`)
    }

    return
  }

  if (when.type === 'not_matched_by_source') {
    if (when.action === 'update' && when.values) {
      sb.push(`WHEN NOT MATCHED BY SOURCE${condStr} THEN UPDATE SET ${printSetClauses(sb, when.values)}`)
    }
    else if (when.action === 'delete') {
      sb.push(`WHEN NOT MATCHED BY SOURCE${condStr} THEN DELETE`)
    }
    else {
      sb.push(`WHEN NOT MATCHED BY SOURCE${condStr} THEN DO NOTHING`)
    }
  }
}

function printMerge(sb: SqlBuilder, state: BuilderState): void {
  sb.postgresOnly('MERGE')

  const source = state.joins[0]

  if (!source || !state.mergeOn)
    throw new ValidationError('MERGE needs a source and a match condition: call using() and on().', 'MergeBuilder')

  sb.push(`MERGE INTO ${quote(state.table)}`)
  sb.push(`USING ${quote(source.table)} AS ${quote(source.alias)}`)
  sb.push(`ON ${sb.inlineExpr(state.mergeOn)}`)

  for (const when of state.mergeWhen) {
    printMergeWhen(sb, when)
  }

  printReturning(sb, state)
}

// --- UPSERT ---

function printUpsert(sb: SqlBuilder, state: BuilderState): void {
  const vals = state.insertValues!
  const keys = Object.keys(vals)
  const colList = quoteCols(keys)
  const valList = keys.map(k => printValue(sb, vals[k])).join(', ')

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES (${valList})`)

  if (state.conflictTarget) {
    if (!state.conflictTarget.length)
      throw new ValidationError('ON CONFLICT DO UPDATE needs the conflict target: name the columns in onConflict().', 'onConflict')

    const target = quoteCols(state.conflictTarget)
    const updateCols = state.conflictUpdateCols ?? keys.filter(k => !state.conflictTarget!.includes(k))
    // With nothing else to copy the target is set to itself, so the conflicting row still comes back through RETURNING.
    const setClauses = (updateCols.length > 0 ? updateCols : state.conflictTarget).map(c => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ')

    sb.push(`ON CONFLICT (${target}) DO UPDATE SET ${setClauses}`)
  }

  printReturning(sb, state)
}

// --- RAW ---

function printRaw(sb: SqlBuilder, state: BuilderState): void {
  sb.push(bindRawParams(state.rawSql!, state.rawParams, 'raw', value => sb.pushParam(value)))
}

// --- Dispatcher ---

const columnSets = new WeakMap<readonly string[], ReadonlySet<string>>()

// One set per table's column list, which the repository shares between its queries.
function columnSet(columns: readonly string[]): ReadonlySet<string> {
  let set = columnSets.get(columns)

  if (!set) {
    set = new Set(columns)
    columnSets.set(columns, set)
  }

  return set
}

export function assembleQuery(state: BuilderState, dialect: Dialect = 'postgres', paramOffset = 0): { sql: string, params: unknown[] } {
  const sb = new SqlBuilder(dialect, paramOffset)

  printCtes(sb, state.ctes)

  // MERGE names its source's columns bare too, so only the other statements check theirs.
  if (state.tableColumns?.length && state.op !== 'merge' && state.op !== 'raw') {
    sb.columns = columnSet(state.tableColumns)
    sb.outputs = new Set(state.computedColumns.map(c => c.alias))
  }

  switch (state.op) {
    case 'select':
    case 'count':
      printSelect(sb, state)

      break
    case 'insert':
      printInsert(sb, state)

      break
    case 'insert_many':
      printInsertMany(sb, state)

      break
    case 'update':
      printUpdate(sb, state)

      break
    case 'delete':
      printDelete(sb, state)

      break
    case 'merge':
      printMerge(sb, state)

      break
    case 'upsert':
      printUpsert(sb, state)

      break
    case 'raw':
      printRaw(sb, state)

      break
  }

  return sb.toResult()
}
