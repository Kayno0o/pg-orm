import type { AnyColumnDef, AnyTableDef, ColumnConstraint } from '../../types/index'
import type { LiveColumn, LiveTable, MigrationOp } from '../types'
import { getColumnMeta } from '../../schema/column-meta'
import { generateColumnDDL, normalizeType } from '../ddl'
import { columnEntries } from '../types'

export function diffTableColumns(ops: MigrationOp[], tableName: string, tableDef: AnyTableDef, liveTable: LiveTable): void {
  const liveColMap = new Map(liveTable.columns.map(c => [c.name, c]))

  const renameMap = new Map<string, string>()

  for (const [colName, colDef] of columnEntries(tableDef.columns)) {
    const { renamedFrom } = getColumnMeta(colDef)

    if (renamedFrom) {
      renameMap.set(renamedFrom, colName)
    }
  }

  for (const [colName, colDef] of columnEntries(tableDef.columns)) {
    const liveCol = liveColMap.get(colName)

    if (!liveCol) {
      const { renamedFrom } = getColumnMeta(colDef)
      const renamedLiveCol = renamedFrom ? liveColMap.get(renamedFrom) : undefined

      if (renamedFrom && renamedLiveCol) {
        ops.push({
          type: 'rename_column',
          table: tableName,
          column: colName,
          sql: `ALTER TABLE "${tableName}" RENAME COLUMN "${renamedFrom}" TO "${colName}"`,
          destructive: false,
          description: `Rename column "${renamedFrom}" to "${colName}" in "${tableName}"`,
        })
        liveColMap.delete(renamedFrom)

        diffColumn(ops, tableName, colName, colDef, renamedLiveCol)

        continue
      }

      ops.push({
        type: 'add_column',
        table: tableName,
        column: colName,
        sql: `ALTER TABLE "${tableName}" ADD COLUMN ${generateColumnDDL(colName, colDef)}`,
        destructive: false,
        description: `Add column "${colName}" to "${tableName}"`,
      })

      continue
    }

    diffColumn(ops, tableName, colName, colDef, liveCol)
    liveColMap.delete(colName)
  }

  for (const [colName] of liveColMap) {
    if (renameMap.has(colName))
      continue

    ops.push({
      type: 'drop_column',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`,
      destructive: true,
      description: `Drop column "${colName}" from "${tableName}"`,
    })
  }
}

function diffColumnType(ops: MigrationOp[], tableName: string, colName: string, ctx: { colDef: AnyColumnDef, desiredType: string, liveType: string }): void {
  if (ctx.desiredType.startsWith('vector') || ctx.liveType.startsWith('vector')) {
    ops.push({
      type: 'drop_column',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`,
      destructive: true,
      description: `Drop column "${colName}" from "${tableName}" (vector dimension change)`,
    })
    ops.push({
      type: 'add_column',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" ADD COLUMN ${generateColumnDDL(colName, ctx.colDef)}`,
      destructive: true,
      description: `Re-add column "${colName}" to "${tableName}" with new vector dimensions`,
    })
  }
  else {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${ctx.colDef.pgType}`,
      destructive: true,
      description: `Change type of "${colName}" in "${tableName}" from ${ctx.liveType} to ${ctx.desiredType}`,
    })
  }
}

export function diffColumn(ops: MigrationOp[], tableName: string, colName: string, colDef: AnyColumnDef, liveCol: LiveColumn): void {
  const desiredType = normalizeType(colDef.pgType)
  const liveType = normalizeType(liveCol.dataType)

  if (desiredType !== liveType) {
    diffColumnType(ops, tableName, colName, { colDef, desiredType, liveType })
  }

  const desiredUnique = colDef.constraints.some((c: ColumnConstraint) => c.type === 'unique')

  if (desiredUnique && !liveCol.isUnique && !liveCol.isPrimaryKey) {
    ops.push({
      type: 'add_constraint',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" ADD CONSTRAINT "${tableName}_${colName}_key" UNIQUE ("${colName}")`,
      destructive: false,
      description: `Add UNIQUE constraint on "${colName}" in "${tableName}"`,
    })
  }
  else if (!desiredUnique && liveCol.isUnique && !liveCol.isPrimaryKey) {
    ops.push({
      type: 'drop_constraint',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${tableName}_${colName}_key"`,
      destructive: true,
      description: `Drop UNIQUE constraint on "${colName}" in "${tableName}"`,
    })
  }

  const desiredNotNull = colDef.constraints.some((c: ColumnConstraint) => c.type === 'not_null')

  if (desiredNotNull && liveCol.isNullable) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET NOT NULL`,
      destructive: false,
      description: `Set NOT NULL on "${colName}" in "${tableName}"`,
    })
  }
  else if (!desiredNotNull && !liveCol.isNullable && !liveCol.isPrimaryKey) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP NOT NULL`,
      destructive: false,
      description: `Drop NOT NULL from "${colName}" in "${tableName}"`,
    })
  }
}
