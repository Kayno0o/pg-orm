import type { AnyColumnDef, AnyTableDef, ColumnConstraint } from '../types/index'
import { columnEntries } from './types'

export interface CollectedConstraints {
  /** Each column rendered via the caller-supplied formatter, already indented for CREATE TABLE. */
  colDefs: string[]
  /** Columns participating in the table's PRIMARY KEY, pre-quoted. */
  pkCols: string[]
  /** Columns to emit as single-column UNIQUE constraints, raw (unquoted). */
  uniqueCols: string[]
}

/**
 * Single pass over a table's columns: renders each column via `formatColumn`
 * and collects table-level constraint buckets in the same loop. CHECK
 * constraints (both from `constraint.type === 'check'` and from validation
 * metadata) remain inline inside the column formatter, so DDL output stays
 * byte-identical with the previous multi-pass implementation.
 *
 * The formatter is injected to avoid a cycle with `./ddl`.
 */
export function collectConstraints(
  table: AnyTableDef,
  formatColumn: (name: string, colDef: AnyColumnDef) => string,
): CollectedConstraints {
  const colDefs: string[] = []
  const pkCols: string[] = []
  const uniqueCols: string[] = []

  for (const [name, colDef] of columnEntries(table.columns)) {
    colDefs.push(`  ${formatColumn(name, colDef)}`)

    for (const c of colDef.constraints as ColumnConstraint[]) {
      if (c.type === 'primary_key')
        pkCols.push(`"${name}"`)
      else if (c.type === 'unique')
        uniqueCols.push(name)
    }
  }

  return { colDefs, pkCols, uniqueCols }
}
