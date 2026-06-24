import type { AnyColumnDef, AnyTableDef, ColumnConstraint } from '../../types/index'
import type { LiveColumn, LiveTable, MigrationOp } from '../types'
import { getColumnMeta } from '../../schema/column-meta'
import {
  buildAddColumnSql,
  buildAddUniqueConstraintSql,
  buildAlterColumnTypeSql,
  buildDropColumnSql,
  buildDropConstraintSql,
  buildDropDefaultSql,
  buildDropNotNullSql,
  buildRenameColumnSql,
  buildSetDefaultSql,
  buildSetNotNullSql,
  needsUsingCast,
  normalizeDefault,
  normalizeType,
} from '../ddl'
import { columnEntries } from '../types'

export function diffTableColumns(
  tableName: string,
  tableDef: AnyTableDef,
  liveTable: LiveTable,
): MigrationOp[] {
  const liveColMap = new Map(liveTable.columns.map(c => [c.name, c]))
  const ops: MigrationOp[] = []
  const renameMap = new Map<string, string>()
  const processedColumns = new Set<string>()

  for (const [colName, colDef] of columnEntries(tableDef.columns)) {
    const { renamedFrom } = getColumnMeta(colDef)

    if (renamedFrom)
      renameMap.set(renamedFrom, colName)
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
          sql: buildRenameColumnSql(tableName, renamedFrom, colName),
          destructive: false,
          description: `Rename column "${renamedFrom}" to "${colName}" in "${tableName}"`,
        })
        processedColumns.add(renamedFrom)

        ops.push(...diffColumn(tableName, colName, colDef, renamedLiveCol))

        continue
      }

      ops.push({
        type: 'add_column',
        table: tableName,
        column: colName,
        sql: buildAddColumnSql(tableName, colName, colDef),
        destructive: false,
        description: `Add column "${colName}" to "${tableName}"`,
      })

      continue
    }

    ops.push(...diffColumn(tableName, colName, colDef, liveCol))
    processedColumns.add(colName)
  }

  for (const liveCol of liveTable.columns) {
    if (processedColumns.has(liveCol.name))
      continue

    if (renameMap.has(liveCol.name))
      continue

    ops.push({
      type: 'drop_column',
      table: tableName,
      column: liveCol.name,
      sql: buildDropColumnSql(tableName, liveCol.name),
      destructive: true,
      description: `Drop column "${liveCol.name}" from "${tableName}"`,
    })
  }

  return ops
}

export function diffColumnType(
  tableName: string,
  colName: string,
  ctx: { colDef: AnyColumnDef, desiredType: string, liveType: string },
): MigrationOp[] {
  if (ctx.desiredType.startsWith('vector') || ctx.liveType.startsWith('vector')) {
    return [
      {
        type: 'drop_column',
        table: tableName,
        column: colName,
        sql: buildDropColumnSql(tableName, colName),
        destructive: true,
        description: `Drop column "${colName}" from "${tableName}" (vector dimension change)`,
      },
      {
        type: 'add_column',
        table: tableName,
        column: colName,
        sql: buildAddColumnSql(tableName, colName, ctx.colDef),
        destructive: true,
        description: `Re-add column "${colName}" to "${tableName}" with new vector dimensions`,
      },
    ]
  }

  const usingClause = needsUsingCast(ctx.liveType, ctx.desiredType)
    ? ` USING "${colName}"::${ctx.colDef.pgType}`
    : ''

  return [{
    type: 'alter_column',
    table: tableName,
    column: colName,
    sql: buildAlterColumnTypeSql(tableName, colName, ctx.colDef.pgType, usingClause),
    destructive: true,
    description: `Change type of "${colName}" in "${tableName}" from ${ctx.liveType} to ${ctx.desiredType}`,
  }]
}

export function diffColumn(
  tableName: string,
  colName: string,
  colDef: AnyColumnDef,
  liveCol: LiveColumn,
): MigrationOp[] {
  const ops: MigrationOp[] = []
  const desiredType = normalizeType(colDef.pgType)
  const liveType = normalizeType(liveCol.dataType)

  if (desiredType !== liveType)
    ops.push(...diffColumnType(tableName, colName, { colDef, desiredType, liveType }))

  const desiredUnique = colDef.constraints.some((c: ColumnConstraint) => c.type === 'unique')

  if (desiredUnique && !liveCol.isUnique && !liveCol.isPrimaryKey) {
    ops.push({
      type: 'add_constraint',
      table: tableName,
      column: colName,
      sql: buildAddUniqueConstraintSql(tableName, colName),
      destructive: false,
      description: `Add UNIQUE constraint on "${colName}" in "${tableName}"`,
    })
  }
  else if (!desiredUnique && liveCol.isUnique && !liveCol.isPrimaryKey) {
    ops.push({
      type: 'drop_constraint',
      table: tableName,
      column: colName,
      sql: buildDropConstraintSql(tableName, `${tableName}_${colName}_key`),
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
      sql: buildSetNotNullSql(tableName, colName),
      destructive: false,
      description: `Set NOT NULL on "${colName}" in "${tableName}"`,
    })
  }
  else if (!desiredNotNull && !liveCol.isNullable && !liveCol.isPrimaryKey) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: buildDropNotNullSql(tableName, colName),
      destructive: false,
      description: `Drop NOT NULL from "${colName}" in "${tableName}"`,
    })
  }

  if (!liveCol.isPrimaryKey && !liveCol.isGenerated) {
    const desiredDefaultConstraint = colDef.constraints.find((c: ColumnConstraint) => c.type === 'default')
    const desiredDefault = desiredDefaultConstraint?.value ?? null
    const liveDefault = liveCol.defaultValue

    const normalizedDesired = desiredDefault !== null ? normalizeDefault(desiredDefault) : null
    const normalizedLive = liveDefault !== null ? normalizeDefault(liveDefault) : null

    if (normalizedDesired !== normalizedLive) {
      if (desiredDefault !== null) {
        ops.push({
          type: 'alter_column',
          table: tableName,
          column: colName,
          sql: buildSetDefaultSql(tableName, colName, desiredDefault),
          destructive: false,
          description: `Set default of "${colName}" in "${tableName}" to ${desiredDefault}`,
        })
      }
      else {
        ops.push({
          type: 'alter_column',
          table: tableName,
          column: colName,
          sql: buildDropDefaultSql(tableName, colName),
          destructive: false,
          description: `Drop default from "${colName}" in "${tableName}"`,
        })
      }
    }
  }

  return ops
}
