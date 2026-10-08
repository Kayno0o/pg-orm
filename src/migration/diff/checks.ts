import type { AnyTableDef } from '../../types/index'
import type { LiveCheck, LiveTable, MigrationOp } from '../types'
import { getColumnMeta } from '../../schema/column-meta'
import { columnChecks, HASHED_CHECK_RE } from '../checks'
import { buildAddCheckSql, buildDropConstraintSql } from '../ddl'
import { columnEntries } from '../types'

const DIGITS_RE = /^\d*$/

/**
 * Diff the CHECK constraints of tables that already exist, by name: a check whose expression changed gets a new hashed name, so it is dropped and re-added.
 * Only checks this ORM owns are dropped: hashed ones, and `<table>_<column>_check[N]`, the names PG gave the unnamed checks earlier versions created. A new table or column carries its checks in its own DDL.
 */
export function diffChecks(desired: ReadonlyMap<string, AnyTableDef>, liveTables: LiveTable[], liveChecks: LiveCheck[]): MigrationOp[] {
  const ops: MigrationOp[] = []
  const liveByName = new Map(liveTables.map(t => [t.name, t]))
  const checksByTable = Map.groupBy(liveChecks, c => c.tableName)

  for (const [tableName, tableDef] of desired) {
    const liveTable = liveByName.get(tableName)

    if (!liveTable)
      continue

    const liveColumns = new Set(liveTable.columns.map(c => c.name))
    const legacy = liveTable.columns.map(c => `${tableName}_${c.name}_check`)
    const tableChecks = checksByTable.get(tableName) ?? []
    const owned = tableChecks.filter(c => HASHED_CHECK_RE.test(c.name) || legacy.some(prefix => isLegacyName(c.name, prefix)))
    const liveNames = new Set(tableChecks.map(c => c.name))
    const wanted = new Map<string, string>()

    for (const [colName, colDef] of columnEntries(tableDef.columns)) {
      const { renamedFrom } = getColumnMeta(colDef)
      const exists = liveColumns.has(colName) || (renamedFrom !== undefined && liveColumns.has(renamedFrom))

      if (!exists)
        continue

      for (const check of columnChecks(tableName, colName, colDef))
        wanted.set(check.name, check.expr)
    }

    for (const check of owned) {
      if (wanted.has(check.name))
        continue

      ops.push({
        type: 'drop_constraint',
        table: tableName,
        sql: buildDropConstraintSql(tableName, check.name),
        destructive: false,
        description: `Drop CHECK constraint "${check.name}" from "${tableName}"`,
      })
    }

    for (const [name, expr] of wanted) {
      if (liveNames.has(name))
        continue

      ops.push({
        type: 'add_constraint',
        table: tableName,
        sql: buildAddCheckSql(tableName, name, expr),
        destructive: false,
        description: `Add CHECK constraint "${name}" to "${tableName}"`,
      })
    }
  }

  return ops
}

function isLegacyName(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && DIGITS_RE.test(name.slice(prefix.length))
}
