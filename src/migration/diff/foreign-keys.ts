import type { AnyTableDef } from '../../types/index'
import type { LiveForeignKey, MigrationOp } from '../types'
import { columnEntries } from '../types'

interface FkRef { table: () => AnyTableDef, column: string, onDelete?: string, onUpdate?: string }

function buildAddFkSql(tableName: string, colName: string, ref: FkRef): string {
  const targetTable = ref.table()
  let sql = `ALTER TABLE "${tableName}" ADD CONSTRAINT "${tableName}_${colName}_fkey" FOREIGN KEY ("${colName}") REFERENCES "${targetTable.name}" ("${ref.column}")`

  if (ref.onDelete)
    sql += ` ON DELETE ${ref.onDelete.toUpperCase()}`

  if (ref.onUpdate)
    sql += ` ON UPDATE ${ref.onUpdate.toUpperCase()}`

  return sql
}

function fkChanged(liveFk: LiveForeignKey, ref: FkRef): boolean {
  const targetTable = ref.table()

  return liveFk.referencedTable !== targetTable.name
    || liveFk.referencedColumn !== ref.column
    || liveFk.onDelete !== (ref.onDelete ?? 'no action').toLowerCase()
    || liveFk.onUpdate !== (ref.onUpdate ?? 'no action').toLowerCase()
}

export function diffForeignKeys(
  ops: MigrationOp[],
  desired: ReadonlyMap<string, AnyTableDef>,
  liveFks: LiveForeignKey[],
): void {
  const liveFkMap = new Map<string, LiveForeignKey>()

  for (const fk of liveFks) {
    liveFkMap.set(`${fk.tableName}.${fk.columnName}`, fk)
  }

  for (const [tableName, tableDef] of desired) {
    for (const [colName, colDef] of columnEntries(tableDef.columns)) {
      const key = `${tableName}.${colName}`
      const liveFk = liveFkMap.get(key)
      const ref = colDef.references

      if (!ref && !liveFk)
        continue

      if (!ref && liveFk) {
        ops.push({
          type: 'drop_fk',
          table: tableName,
          column: colName,
          sql: `ALTER TABLE "${tableName}" DROP CONSTRAINT "${liveFk.constraintName}"`,
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
          sql: `ALTER TABLE "${tableName}" DROP CONSTRAINT "${liveFk.constraintName}"`,
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
}
