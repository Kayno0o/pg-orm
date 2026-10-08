import type { AnyTableDef, ForeignKeyRef } from '../../types/index'
import type { LiveForeignKey, LiveTable, MigrationOp } from '../types'
import { getColumnMeta } from '../../schema/column-meta'
import { buildAddFkSql, buildDropFkSql } from '../ddl'
import { columnEntries } from '../types'

export function diffForeignKeys(
  desired: ReadonlyMap<string, AnyTableDef>,
  liveFks: LiveForeignKey[],
  liveTables: LiveTable[] = [],
): MigrationOp[] {
  const ops: MigrationOp[] = []
  const liveFkMap = new Map<string, LiveForeignKey>()
  const liveColumns = new Set(liveTables.flatMap(t => t.columns.map(c => `${t.name}.${c.name}`)))

  for (const fk of liveFks)
    liveFkMap.set(`${fk.tableName}.${fk.columnName}`, fk)

  for (const [tableName, tableDef] of desired) {
    for (const [colName, colDef] of columnEntries(tableDef.columns)) {
      const key = `${tableName}.${colName}`
      const { renamedFrom } = getColumnMeta(colDef)
      // A column the sync renames keeps its foreign key, still filed under the old name.
      const renamed = renamedFrom !== undefined && !liveColumns.has(key) && liveColumns.has(`${tableName}.${renamedFrom}`)
      const liveFk = liveFkMap.get(key) ?? (renamed ? liveFkMap.get(`${tableName}.${renamedFrom}`) : undefined)
      const ref = colDef.references

      if (!ref && !liveFk)
        continue

      if (!ref && liveFk) {
        ops.push({
          type: 'drop_fk',
          table: tableName,
          column: colName,
          sql: buildDropFkSql(tableName, liveFk.constraintName),
          destructive: true,
          description: `Drop FK constraint "${liveFk.constraintName}" on "${tableName}"."${colName}"`,
        })

        continue
      }

      if (!ref)
        continue

      if (liveFk && fkChanged(liveFk, ref)) {
        ops.push({
          type: 'drop_fk',
          table: tableName,
          column: colName,
          sql: buildDropFkSql(tableName, liveFk.constraintName),
          destructive: false,
          description: `Drop FK constraint "${liveFk.constraintName}" on "${tableName}"."${colName}"`,
        })
        ops.push({
          type: 'add_fk',
          table: tableName,
          column: colName,
          sql: buildAddFkSql(tableName, colName, ref),
          destructive: false,
          description: `Add FK constraint on "${tableName}"."${colName}" → "${ref.table().name}"."${ref.column}"`,
        })
      }
      else if (!liveFk) {
        ops.push({
          type: 'add_fk',
          table: tableName,
          column: colName,
          sql: buildAddFkSql(tableName, colName, ref),
          destructive: false,
          description: `Add FK constraint on "${tableName}"."${colName}" → "${ref.table().name}"."${ref.column}"`,
        })
      }
    }
  }

  return ops
}

function fkChanged(liveFk: LiveForeignKey, ref: ForeignKeyRef): boolean {
  const targetTable = ref.table()

  return liveFk.referencedTable !== targetTable.name
    || liveFk.referencedColumn !== ref.column
    || liveFk.onDelete !== (ref.onDelete ?? 'no action').toLowerCase()
    || liveFk.onUpdate !== (ref.onUpdate ?? 'no action').toLowerCase()
}
