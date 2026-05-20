import type { ExprTape } from './expr'
import type { BuilderState, MergeWhen } from './state'
import { quote } from '../sql/utils'
import { assembleExpr } from './expr'
import { formatOrderBy, isRawSql, PLACEHOLDER_RE, quoteCols } from './state'

class QueryAssembler {
  private params: unknown[] = []
  private pidx = 1
  private parts: string[] = []
  private state: BuilderState

  constructor(state: BuilderState) {
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
        this.parts.push(`ON CONFLICT (${target}) DO NOTHING`)
      }
    }
  }

  private assembleCtes(): void {
    if (!this.state.ctes.length)
      return

    const cteParts = this.state.ctes.map((c) => {
      const mat = c.materialized === true ? 'MATERIALIZED ' : c.materialized === false ? 'NOT MATERIALIZED ' : ''
      // Renumber $N placeholders by captured index + current offset, then push params.
      // This preserves duplicate references (`$1 ... $1`) and out-of-order references
      // (`$2 ... $1`) — both are silently miscompiled by occurrence-based mapping.
      const offset = this.pidx - 1
      const cteSql = c.sql.replace(PLACEHOLDER_RE, (_, n) => `$${Number(n) + offset}`)

      this.params.push(...c.params)
      this.pidx += c.params.length

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

    this.parts.push(`FROM ${quote(this.state.table)}${this.state.alias !== undefined ? ` AS ${quote(this.state.alias)}` : ''}`)

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
      if (isRawSql(v)) {
        return `${quote(k)} = ${v.__raw}`
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
          if (isRawSql(v))
            return `${quote(k)} = ${v.__raw}`

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

          if (isRawSql(v)) {
            return v.__raw
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
          if (isRawSql(v)) {
            return `${quote(k)} = ${v.__raw}`
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
      if (paramIdx >= params.length) {
        throw new Error(`raw SQL has more "?" placeholders than parameters (${params.length} provided)`)
      }

      return this.pushParam(params[paramIdx++])
    })
    this.parts.push(rawSql)
  }
}

export function assembleQuery(state: BuilderState): { sql: string, params: unknown[] } {
  return new QueryAssembler(state).assemble()
}

export function buildSelectColumns(state: BuilderState): string {
  const cols: string[] = state.columns
    ? state.columns.filter(c => !state.omitColumns.includes(c)).map(quote)
    : ['*']

  for (const cc of state.computedColumns) {
    cols.push(`${cc.expr} AS ${quote(cc.alias)}`)
  }

  return cols.join(', ') || '*'
}
