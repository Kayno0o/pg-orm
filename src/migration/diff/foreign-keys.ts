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
  // A composite key is read back once per column pair: it goes once.
  const dropped = new Set<string>()
  const drop = (fk: LiveForeignKey, column: string, destructive: boolean, note = '') => {
    const id = `${fk.tableName}.${fk.constraintName}`

    if (dropped.has(id))
      return

    dropped.add(id)
    ops.push({
      type: 'drop_fk',
      table: fk.tableName,
      column,
      sql: buildDropFkSql(fk.tableName, fk.constraintName),
      destructive,
      description: `Drop FK constraint "${fk.constraintName}" on "${fk.tableName}"."${column}"${note}`,
    })
  }

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
        drop(liveFk, colName, true)

        continue
      }

      if (!ref)
        continue

      if (liveFk && fkChanged(liveFk, ref)) {
        drop(liveFk, colName, false)
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

  // A key whose column, or the column it points at, goes with the sync must go first: Postgres refuses to drop a column something depends on.
  const surviving = (table: string, column: string): boolean => {
    const def = desired.get(table)

    return def === undefined || columnEntries(def.columns).some(([name, colDef]) => name === column || getColumnMeta(colDef).renamedFrom === column)
  }

  for (const fk of liveFks) {
    if (!surviving(fk.tableName, fk.columnName) || !surviving(fk.referencedTable, fk.referencedColumn))
      drop(fk, fk.columnName, true, ' (a column it uses is dropped)')
  }

  return ops
}

function fkChanged(liveFk: LiveForeignKey, ref: ForeignKeyRef): boolean {
  const targetTable = ref.table()

  return liveFk.referencedTable !== targetTable.name
    || liveFk.referencedColumn !== ref.column
    || liveFk.onDelete !== (ref.onDelete ?? 'no action').toLowerCase()
    || liveFk.onUpdate !== (ref.onUpdate ?? 'no action').toLowerCase()
    || liveFk.deferrable !== ref.deferrable
}
