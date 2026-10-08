import type { Dialect } from '../dialect'
import type { ExprTape } from './_tape'
import type { BuilderState, MergeWhen } from './state'
import { DialectError, ValidationError } from '../errors/index'
import { quote } from '../sql/utils'
import { assembleExpr, OP_AND, OP_IS_NULL, OP_RAW } from './_tape'
import { isConflictValue } from './conflict'
import { formatOrderBy, isRawSql, PLACEHOLDER_RE, quoteCols, selectedColumns } from './state'

const RAW_PARAM_RE = /\?/g

/**
 * Single bottleneck for placeholder counting and parameter accumulation.
 * Every clause printer flows through one instance per query, so `$N` numbering
 * stays linear and identifier quoting always goes through `quote()` / `quotePath()`.
 */
class SqlBuilder {
  readonly params: unknown[] = []
  pidx: number
  readonly parts: string[] = []

  constructor(readonly dialect: Dialect, paramOffset: number) {
    this.pidx = paramOffset + 1
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

  /** Splice an expression tape into the running SQL stream, bumping param state. */
  inlineExpr(tape: ExprTape, qualifier?: string): string {
    const result = assembleExpr(tape, this.pidx - 1, qualifier, this.dialect)

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
    // Renumber $N placeholders by captured index + current offset, then push params.
    // This preserves duplicate references (`$1 ... $1`) and out-of-order references
    // (`$2 ... $1`) — both would be silently miscompiled by occurrence-based mapping.
    const offset = sb.pidx - 1
    const cteSql = c.sql.replace(PLACEHOLDER_RE, (_, n) => `$${Number(n) + offset}`)

    sb.params.push(...c.params)
    sb.pidx += c.params.length

    return `${quote(c.name)} AS (${mat}${cteSql})`
  })

  const hasRecursive = ctes.some(c => c.recursive)

  sb.push(`WITH ${hasRecursive ? 'RECURSIVE ' : ''}${cteParts.join(', ')}`)
}

// --- Shared clause printers ---

function printReturning(sb: SqlBuilder, returning: string[] | null, extra?: string): void {
  if (returning) {
    sb.push(`RETURNING ${returning.length ? quoteCols(returning) : '*'}${extra ? `, ${extra}` : ''}`)
  }
}

function printOnConflict(sb: SqlBuilder, state: BuilderState): void {
  if (!state.conflictTarget)
    return

  const target = quoteCols(state.conflictTarget)

  if (state.conflictAction !== 'update') {
    if (state.conflictAction === 'nothing')
      sb.push(`ON CONFLICT (${target}) DO NOTHING`)

    return
  }

  const set = state.conflictSet ?? {}
  // `[]` copies every incoming column but the target, `null` copies none.
  let copies = state.conflictUpdateCols ?? []

  if (state.conflictUpdateCols?.length === 0) {
    const conflictSet = new Set(state.conflictTarget)
    const valueKeys = state.insertValues
      ? Object.keys(state.insertValues)
      : state.insertManyValues?.[0]
        ? Object.keys(state.insertManyValues[0])
        : []

    copies = valueKeys.filter(k => !conflictSet.has(k))
  }

  const clauses = copies.filter(c => !(c in set)).map(c => `${quote(c)} = EXCLUDED.${quote(c)}`)

  for (const [col, value] of Object.entries(set)) {
    const rendered = isConflictValue(value)
      ? sb.inlineExpr([{ op: OP_RAW, sql: value.sql, params: [...value.params] }])
      : sb.pushParam(value)

    clauses.push(`${quote(col)} = ${rendered}`)
  }

  // Nothing to write still updates the target to itself, so the conflicting row comes back through RETURNING like an updated one.
  if (clauses.length === 0)
    clauses.push(...state.conflictTarget.map(c => `${quote(c)} = EXCLUDED.${quote(c)}`))

  const guard = state.conflictWhere ? ` WHERE ${sb.inlineExpr(state.conflictWhere, state.table)}` : ''

  sb.push(`ON CONFLICT (${target}) DO UPDATE SET ${clauses.join(', ')}${guard}`)
}

function printWhere(sb: SqlBuilder, tape: ExprTape | null): void {
  if (tape)
    sb.push(`WHERE ${sb.inlineExpr(tape)}`)
}

// --- SELECT pieces ---

function printSelectColumns(sb: SqlBuilder, state: BuilderState): string {
  const cols: string[] = selectedColumns(state)?.map(quote) ?? ['*']

  for (const cc of state.computedColumns) {
    // `cc.expr` is interpolated unparameterized. Inputs are constrained at the
    // entry points: `computed()` produces strings via the safe `ExprBuilder`,
    // and `computedRaw()` runs the string through `validateRawSqlFragment`
    // (rejects `;`, `--`, `/*`, dollar-quotes, unterminated strings). The
    // alias is bound by `validateIdentifier`. Do not introduce a new caller
    // here without applying both.
    const expr = cc.filter ? `(${cc.expr} AND ${sb.inlineExpr(cc.filter.tape, cc.filter.qualifier)})` : cc.expr

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
    : state.distinctOn.length ? `DISTINCT ON (${quoteCols(state.distinctOn)}) ` : ''

  sb.push(`SELECT ${distinct}${printSelectColumns(sb, state)}`)
}

function printFrom(sb: SqlBuilder, state: BuilderState): void {
  sb.push(`FROM ${quote(state.table)}${state.alias !== undefined ? ` AS ${quote(state.alias)}` : ''}`)
}

function printJoins(sb: SqlBuilder, state: BuilderState): void {
  for (const j of state.joins) {
    if (j.type === 'lateral') {
      sb.postgresOnly('LATERAL joins')
      sb.push(`CROSS JOIN LATERAL (${j.table}) AS ${quote(j.alias)}`)

      continue
    }

    const joinType = j.type.toUpperCase()
    const onClause = j.on ? ` ON ${sb.inlineExpr(j.on)}` : ''

    sb.push(`${joinType} JOIN ${quote(j.table)} AS ${quote(j.alias)}${onClause}`)
  }
}

function printGroupHaving(sb: SqlBuilder, state: BuilderState): void {
  if (state.groupBy.length)
    sb.push(`GROUP BY ${quoteCols(state.groupBy)}`)

  if (state.havingTape)
    sb.push(`HAVING ${sb.inlineExpr(state.havingTape)}`)
}

function printWindows(sb: SqlBuilder, windows: BuilderState['windows']): void {
  for (const w of windows) {
    const partBy = w.partitionBy.length ? `PARTITION BY ${quoteCols(w.partitionBy)}` : ''
    const ordBy = w.orderBy.length ? `ORDER BY ${formatOrderBy(w.orderBy)}` : ''

    sb.push(`WINDOW ${quote(w.name)} AS (${[partBy, ordBy].filter(Boolean).join(' ')})`)
  }
}

function printOrderLimit(sb: SqlBuilder, state: BuilderState): void {
  if (state.orderBy.length)
    sb.push(`ORDER BY ${formatOrderBy(state.orderBy)}`)

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
  if (!state.lockMode || sb.dialect === 'sqlite')
    return

  sb.push(`FOR ${state.lockMode.toUpperCase().replaceAll('_', ' ')}`)

  if (state.skipLocked)
    sb.push('SKIP LOCKED')
}

// Trashed rows are left out here rather than when the repository hands the builder over, so a withTrashed() called later still lets them in.
function selectWhere(state: BuilderState): ExprTape | null {
  if (!state.softDeleteColumn || state.withTrashed)
    return state.whereTape

  const live: ExprTape = [{ op: OP_IS_NULL, col: state.softDeleteColumn }]

  return state.whereTape ? [{ op: OP_AND, count: 2 }, ...state.whereTape, ...live] : live
}

function printSelect(sb: SqlBuilder, state: BuilderState): void {
  // A grouped or distinct query has fewer result rows than matched rows, so its count wraps the query instead of replacing its column list.
  const wrapCount = state.op === 'count' && (state.groupBy.length > 0 || state.distinct || state.distinctOn.length > 0)

  if (wrapCount)
    sb.push(`SELECT ${countColumn(sb)} FROM (`)

  printSelectHead(sb, state, state.op === 'count' && !wrapCount)
  printFrom(sb, state)
  printJoins(sb, state)
  printWhere(sb, selectWhere(state))
  printGroupHaving(sb, state)
  printWindows(sb, state.windows)
  printOrderLimit(sb, state)
  printLock(sb, state)

  if (wrapCount)
    sb.push(') AS "__counted"')
}

// --- INSERT / UPDATE / DELETE ---

function printInsert(sb: SqlBuilder, state: BuilderState): void {
  const vals = state.insertValues!
  const keys = Object.keys(vals)

  // No columns supplied → let every column take its default. `() VALUES ()` is a
  // syntax error in Postgres; `DEFAULT VALUES` is the correct empty-row insert.
  if (keys.length === 0) {
    sb.push(`INSERT INTO ${quote(state.table)} DEFAULT VALUES`)
    printOnConflict(sb, state)
    printReturning(sb, state.returning, state.returningExtra)

    return
  }

  const colList = quoteCols(keys)
  const valList = keys.map(k => sb.pushParam(vals[k])).join(', ')

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES (${valList})`)
  printOnConflict(sb, state)
  printReturning(sb, state.returning, state.returningExtra)
}

// A column a row leaves out takes its default, which SQLite cannot ask for by `DEFAULT` inside VALUES: there the default's own expression is written out, from the table the repository knows.
function insertValue(sb: SqlBuilder, state: BuilderState, row: Record<string, unknown>, key: string): string {
  if (key in row)
    return sb.pushParam(row[key])

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
    return

  const keySet = new Set<string>()

  for (const row of rows) {
    for (const k of Object.keys(row)) keySet.add(k)
  }

  const keys = [...keySet]
  const colList = quoteCols(keys)
  const valueSets = rows.map(row =>
    `(${keys.map(k => insertValue(sb, state, row, k)).join(', ')})`,
  )

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES ${valueSets.join(', ')}`)
  printOnConflict(sb, state)
  printReturning(sb, state.returning, state.returningExtra)
}

function printSetClauses(sb: SqlBuilder, values: Record<string, unknown>): string {
  return Object.entries(values).map(([k, v]) => {
    if (isRawSql(v))
      return `${quote(k)} = ${v.__raw}`

    return `${quote(k)} = ${sb.pushParam(v)}`
  }).join(', ')
}

function printUpdate(sb: SqlBuilder, state: BuilderState): void {
  if (!state.setValues || Object.keys(state.setValues).length === 0) {
    throw new ValidationError(
      `update() on "${state.table}" has no columns to set`,
      'update',
    )
  }

  requireWhereOrAllRows(state)

  const setClauses = printSetClauses(sb, state.setValues)

  sb.push(`UPDATE ${quote(state.table)} SET ${setClauses}`)
  printWhere(sb, state.whereTape)
  printReturning(sb, state.returning, state.returningExtra)
}

// A falsy where() is a no-op, so a builder whose every condition came out falsy would otherwise reach the whole table.
function requireWhereOrAllRows(state: BuilderState): void {
  if (!state.whereTape && !state.allRows)
    throw new ValidationError(`${state.op}() on "${state.table}" has no WHERE: call allRows() to reach every row on purpose.`, state.op)
}

function printDelete(sb: SqlBuilder, state: BuilderState): void {
  requireWhereOrAllRows(state)
  sb.push(`DELETE FROM ${quote(state.table)}`)
  printWhere(sb, state.whereTape)
  printReturning(sb, state.returning, state.returningExtra)
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
      const vals = keys.map((k) => {
        const v = when.values![k]

        if (isRawSql(v))
          return v.__raw

        return sb.pushParam(v)
      }).join(', ')

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
  sb.push(`MERGE INTO ${quote(state.table)}`)

  if (state.joins.length) {
    const j = state.joins[0]!

    sb.push(`USING ${quote(j.table)} AS ${quote(j.alias)}`)

    if (state.mergeOn)
      sb.push(`ON ${sb.inlineExpr(state.mergeOn)}`)
  }

  for (const when of state.mergeWhen) {
    printMergeWhen(sb, when)
  }

  printReturning(sb, state.returning, state.returningExtra)
}

// --- UPSERT ---

function printUpsert(sb: SqlBuilder, state: BuilderState): void {
  const vals = state.insertValues!
  const keys = Object.keys(vals)
  const colList = quoteCols(keys)
  const valList = keys.map(k => sb.pushParam(vals[k])).join(', ')

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES (${valList})`)

  if (state.conflictTarget) {
    const target = quoteCols(state.conflictTarget)
    const updateCols = state.conflictUpdateCols ?? keys.filter(k => !state.conflictTarget!.includes(k))
    const setClauses = updateCols.map(c => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ')

    sb.push(`ON CONFLICT (${target}) DO UPDATE SET ${setClauses}`)
  }

  printReturning(sb, state.returning, state.returningExtra)
}

// --- RAW ---

function printRaw(sb: SqlBuilder, state: BuilderState): void {
  let paramIdx = 0
  const params = state.rawParams
  const rawSql = state.rawSql!.replace(RAW_PARAM_RE, () => {
    if (paramIdx >= params.length) {
      throw new ValidationError(
        `raw SQL has more "?" placeholders than parameters (${params.length} provided)`,
        'raw',
      )
    }

    return sb.pushParam(params[paramIdx++])
  })

  sb.push(rawSql)
}

// --- Dispatcher ---

export function assembleQuery(state: BuilderState, dialect: Dialect = 'postgres', paramOffset = 0): { sql: string, params: unknown[] } {
  const sb = new SqlBuilder(dialect, paramOffset)

  printCtes(sb, state.ctes)

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
