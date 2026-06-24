import type { AnyTableDef } from '../../types/index'
import type { LiveTable, MigrationOp } from '../types'
import { buildDropTableSql, generateCreateTable } from '../ddl'
import { diffTableColumns } from './columns'

/**
 * Diff table-level operations: create, drop, and column-level changes.
 * Returns all table-related ops. Does not mutate inputs.
 */
export function diffTables(
  desired: ReadonlyMap<string, AnyTableDef>,
  liveTables: LiveTable[],
): MigrationOp[] {
  const liveTableMap = new Map(liveTables.map(t => [t.name, t]))
  const ops: MigrationOp[] = []
  const processedTables = new Set<string>()

  for (const [tableName, tableDef] of desired) {
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

    ops.push(...diffTableColumns(tableName, tableDef, liveTable))
    processedTables.add(tableName)
  }

  for (const liveTable of liveTables) {
    if (processedTables.has(liveTable.name))
      continue

    ops.push({
      type: 'drop_table',
      table: liveTable.name,
      sql: buildDropTableSql(liveTable.name),
      destructive: true,
      description: `Drop table "${liveTable.name}"`,
    })
  }

  return ops
}
