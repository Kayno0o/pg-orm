import type { ExprTape } from './_tape'
import type { BuilderState, MergeWhen } from './state'
import { ValidationError } from '../errors/index'
import { quote } from '../sql/utils'
import { assembleExpr } from './_tape'
import { formatOrderBy, isRawSql, PLACEHOLDER_RE, quoteCols } from './state'

const RAW_PARAM_RE = /\?/g

/**
 * Single bottleneck for placeholder counting and parameter accumulation.
 * Every clause printer flows through one instance per query, so `$N` numbering
 * stays linear and identifier quoting always goes through `quote()` / `quotePath()`.
 */
class SqlBuilder {
  readonly params: unknown[] = []
  pidx = 1
  readonly parts: string[] = []

  pushParam(val: unknown): string {
    this.params.push(val)

    return `$${this.pidx++}`
  }

  push(part: string): void {
    this.parts.push(part)
  }

  /** Splice an expression tape into the running SQL stream, bumping param state. */
  inlineExpr(tape: ExprTape): string {
    const result = assembleExpr(tape, this.pidx - 1)

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

function printReturning(sb: SqlBuilder, returning: string[] | null): void {
  if (returning) {
    sb.push(`RETURNING ${returning.length ? quoteCols(returning) : '*'}`)
  }
}

function printOnConflict(sb: SqlBuilder, state: BuilderState): void {
  if (!state.conflictTarget)
    return

  const target = quoteCols(state.conflictTarget)

  if (state.conflictAction === 'nothing') {
    sb.push(`ON CONFLICT (${target}) DO NOTHING`)

    return
  }

  if (state.conflictAction === 'update' && state.conflictUpdateCols) {
    let updateCols = state.conflictUpdateCols

    if (updateCols.length === 0) {
      const conflictSet = new Set(state.conflictTarget)
      const valueKeys = state.insertValues
        ? Object.keys(state.insertValues)
        : state.insertManyValues?.[0]
          ? Object.keys(state.insertManyValues[0])
          : []

      updateCols = valueKeys.filter(k => !conflictSet.has(k))
    }

    if (updateCols.length > 0) {
      const setClauses = updateCols.map(c => `${quote(c)} = EXCLUDED.${quote(c)}`).join(', ')

      sb.push(`ON CONFLICT (${target}) DO UPDATE SET ${setClauses}`)
    }
    else {
      sb.push(`ON CONFLICT (${target}) DO NOTHING`)
    }
  }
}

function printWhere(sb: SqlBuilder, tape: ExprTape | null): void {
  if (tape)
    sb.push(`WHERE ${sb.inlineExpr(tape)}`)
}

// --- SELECT pieces ---

function printSelectColumns(state: BuilderState): string {
  const cols: string[] = state.columns
    ? state.columns.filter(c => !state.omitColumns.includes(c)).map(quote)
    : ['*']

  for (const cc of state.computedColumns) {
    cols.push(`${cc.expr} AS ${quote(cc.alias)}`)
  }

  return cols.join(', ') || '*'
}

function printSelectHead(sb: SqlBuilder, state: BuilderState): void {
  if (state.op === 'count') {
    sb.push('SELECT count(*)')

    return
  }

  const distinct = state.distinct
    ? 'DISTINCT '
    : state.distinctOn.length ? `DISTINCT ON (${quoteCols(state.distinctOn)}) ` : ''

  sb.push(`SELECT ${distinct}${printSelectColumns(state)}`)
}

function printFrom(sb: SqlBuilder, state: BuilderState): void {
  sb.push(`FROM ${quote(state.table)}${state.alias !== undefined ? ` AS ${quote(state.alias)}` : ''}`)
}

function printJoins(sb: SqlBuilder, state: BuilderState): void {
  for (const j of state.joins) {
    if (j.type === 'lateral') {
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

  if (state.offset != null)
    sb.push(`OFFSET ${sb.pushParam(state.offset)}`)
}

function printLock(sb: SqlBuilder, state: BuilderState): void {
  if (!state.lockMode)
    return

  sb.push(`FOR ${state.lockMode.toUpperCase().replaceAll('_', ' ')}`)

  if (state.skipLocked)
    sb.push('SKIP LOCKED')
}

function printSelect(sb: SqlBuilder, state: BuilderState): void {
  printSelectHead(sb, state)
  printFrom(sb, state)
  printJoins(sb, state)
  printWhere(sb, state.whereTape)
  printGroupHaving(sb, state)
  printWindows(sb, state.windows)
  printOrderLimit(sb, state)
  printLock(sb, state)
}

// --- INSERT / UPDATE / DELETE ---

function printInsert(sb: SqlBuilder, state: BuilderState): void {
  const vals = state.insertValues!
  const keys = Object.keys(vals)
  const colList = quoteCols(keys)
  const valList = keys.map(k => sb.pushParam(vals[k])).join(', ')

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES (${valList})`)
  printOnConflict(sb, state)
  printReturning(sb, state.returning)
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
    `(${keys.map(k => k in row ? sb.pushParam(row[k]) : 'DEFAULT').join(', ')})`,
  )

  sb.push(`INSERT INTO ${quote(state.table)} (${colList}) VALUES ${valueSets.join(', ')}`)
  printOnConflict(sb, state)
  printReturning(sb, state.returning)
}

function printSetClauses(sb: SqlBuilder, values: Record<string, unknown>): string {
  return Object.entries(values).map(([k, v]) => {
    if (isRawSql(v))
      return `${quote(k)} = ${v.__raw}`

    return `${quote(k)} = ${sb.pushParam(v)}`
  }).join(', ')
}

function printUpdate(sb: SqlBuilder, state: BuilderState): void {
  const setClauses = printSetClauses(sb, state.setValues!)

  sb.push(`UPDATE ${quote(state.table)} SET ${setClauses}`)
  printWhere(sb, state.whereTape)
  printReturning(sb, state.returning)
}

function printDelete(sb: SqlBuilder, state: BuilderState): void {
  sb.push(`DELETE FROM ${quote(state.table)}`)
  printWhere(sb, state.whereTape)
  printReturning(sb, state.returning)
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

  printReturning(sb, state.returning)
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

  printReturning(sb, state.returning)
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

export function assembleQuery(state: BuilderState): { sql: string, params: unknown[] } {
  const sb = new SqlBuilder()

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
