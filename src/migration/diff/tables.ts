import type { AnyTableDef } from '../../types/index'
import type { LiveTable, MigrationOp } from '../types'
import { generateCreateTable } from '../ddl'
import { diffTableColumns } from './columns'

/**
 * Diff table-level operations: create, drop, and column-level changes.
 * Mutates `liveTableMap` by deleting entries it processed; remaining entries
 * are treated as live tables not in the desired set (drop candidates).
 */
export function diffTables(
  ops: MigrationOp[],
  desired: ReadonlyMap<string, AnyTableDef>,
  liveTableMap: Map<string, LiveTable>,
  onTable: (tableName: string, tableDef: AnyTableDef) => void,
): void {
  for (const [tableName, tableDef] of desired) {
    onTable(tableName, tableDef)

    const liveTable = liveTableMap.get(tableName)

    if (!liveTable) {
      ops.push({
        type: 'create_table',
        table: tableName,
        sql: generateCreateTable(tableName, tableDef),
        destructive: false,
        description: `Create table "${tableName}"`,
      })

      continue
    }

    diffTableColumns(ops, tableName, tableDef, liveTable)
    liveTableMap.delete(tableName)
  }

  for (const [tableName] of liveTableMap) {
    ops.push({
      type: 'drop_table',
      table: tableName,
      sql: `DROP TABLE "${tableName}"`,
      destructive: true,
      description: `Drop table "${tableName}"`,
    })
  }
}
