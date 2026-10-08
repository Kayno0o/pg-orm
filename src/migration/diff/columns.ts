import type { AnyColumnDef, AnyTableDef, ColumnConstraint } from '../../types/index'
import type { LiveColumn, LiveTable, MigrationOp } from '../types'
import { toSQLDefault } from '../../schema/column-default'
import { getColumnMeta } from '../../schema/column-meta'
import {
  buildAddColumnSql,
  buildAddPrimaryKeySql,
  buildAddUniqueConstraintSql,
  buildAlterColumnTypeSql,
  buildDropColumnSql,
  buildDropConstraintSql,
  buildDropDefaultSql,
  buildDropExpressionSql,
  buildDropNotNullSql,
  buildRenameColumnSql,
  buildSetDefaultSql,
  buildSetExpressionSql,
  buildSetNotNullSql,
  needsUsingCast,
  normalizeExpression,
  normalizeType,
  sameDefault,
} from '../ddl'
import { SERIAL_TYPE_RE } from '../regex'
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

      ops.push(...addColumn(tableName, colName, colDef))

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

  return diffPrimaryKey(tableName, tableDef, liveTable, renameMap, ops)
}

// The old key is dropped before the column changes, so a column leaving it can drop its NOT NULL, and the new one added after them, once its columns exist.
function diffPrimaryKey(tableName: string, tableDef: AnyTableDef, liveTable: LiveTable, renameMap: Map<string, string>, columnOps: MigrationOp[]): MigrationOp[] {
  const desired = columnEntries(tableDef.columns).filter(([, colDef]) => isPrimaryKey(colDef)).map(([name]) => name)
  const live = liveTable.columns.filter(c => c.isPrimaryKey).map(c => renameMap.get(c.name) ?? c.name)

  if (desired.length === live.length && desired.every(name => live.includes(name)))
    return columnOps

  const before: MigrationOp[] = live.length === 0
    ? []
    : [{
      type: 'drop_constraint',
      table: tableName,
      sql: buildDropConstraintSql(tableName, liveTable.primaryKeyConstraint ?? `${tableName}_pkey`),
      destructive: true,
      description: `Drop primary key (${live.join(', ')}) of "${tableName}"`,
    }]
  const after: MigrationOp[] = desired.length === 0
    ? []
    : [{
      type: 'add_constraint',
      table: tableName,
      sql: buildAddPrimaryKeySql(tableName, desired),
      destructive: false,
      description: `Add primary key (${desired.join(', ')}) to "${tableName}"`,
    }]

  return [...before, ...columnOps, ...after]
}

function isPrimaryKey(colDef: AnyColumnDef): boolean {
  return colDef.constraints.some((c: ColumnConstraint) => c.type === 'primary_key')
}

// A NOT NULL column without a default fails to be added to a table with rows, unless `.backfill()` fills them through a default dropped right after.
function addColumn(tableName: string, colName: string, colDef: AnyColumnDef): MigrationOp[] {
  const has = (type: ColumnConstraint['type']) => colDef.constraints.some((c: ColumnConstraint) => c.type === type)
  const needsFill = has('not_null') && !has('default') && !has('generated') && !SERIAL_TYPE_RE.test(colDef.pgType)
  const { backfill } = getColumnMeta(colDef)
  const fill = needsFill && backfill ? toSQLDefault(backfill.value, colDef.pgType) : undefined
  const ops: MigrationOp[] = [{
    type: 'add_column',
    table: tableName,
    column: colName,
    sql: buildAddColumnSql(tableName, colName, colDef, fill),
    destructive: false,
    description: needsFill && !backfill
      ? `Add column "${colName}" to "${tableName}" (NOT NULL without a default or a .backfill(): fails if the table has rows)`
      : `Add column "${colName}" to "${tableName}"`,
  }]

  if (fill !== undefined) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: buildDropDefaultSql(tableName, colName),
      destructive: false,
      description: `Drop the backfill default of "${colName}" in "${tableName}"`,
    })
  }

  if (has('unique') && !has('primary_key')) {
    ops.push({
      type: 'add_constraint',
      table: tableName,
      column: colName,
      sql: buildAddUniqueConstraintSql(tableName, colName),
      destructive: false,
      description: `Add UNIQUE constraint on "${colName}" in "${tableName}"`,
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
  const desiredExpr = colDef.constraints.find((c: ColumnConstraint) => c.type === 'generated')?.value

  // Postgres cannot turn a plain column into a generated one in place: the column is added anew, its values computed.
  if (desiredExpr !== undefined && !liveCol.isGenerated) {
    return [
      {
        type: 'drop_column',
        table: tableName,
        column: colName,
        sql: buildDropColumnSql(tableName, colName),
        destructive: true,
        description: `Drop column "${colName}" from "${tableName}" (becomes generated)`,
      },
      ...addColumn(tableName, colName, colDef),
    ]
  }

  const ops: MigrationOp[] = []
  const desiredType = normalizeType(colDef.pgType)
  const liveType = normalizeType(liveCol.dataType)

  if (desiredExpr === undefined && liveCol.isGenerated) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: buildDropExpressionSql(tableName, colName),
      destructive: false,
      description: `Make "${colName}" in "${tableName}" a plain column, keeping its values`,
    })
  }
  else if (desiredExpr !== undefined && normalizeExpression(desiredExpr) !== normalizeExpression(liveCol.generationExpression)) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: buildSetExpressionSql(tableName, colName, desiredExpr),
      destructive: false,
      description: `Change the expression of generated column "${colName}" in "${tableName}"`,
    })
  }

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
      sql: buildDropConstraintSql(tableName, liveCol.uniqueConstraint ?? `${tableName}_${colName}_key`),
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
  else if (!desiredNotNull && !liveCol.isNullable && !isPrimaryKey(colDef)) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: buildDropNotNullSql(tableName, colName),
      destructive: false,
      description: `Drop NOT NULL from "${colName}" in "${tableName}"`,
    })
  }

  if (!liveCol.isPrimaryKey && desiredExpr === undefined) {
    const desiredDefault = colDef.constraints.find((c: ColumnConstraint) => c.type === 'default')?.value ?? null
    const liveDefault = liveCol.defaultValue

    if (desiredDefault === null && liveDefault !== null && !isOwnSequenceDefault(colDef, liveDefault)) {
      ops.push({
        type: 'alter_column',
        table: tableName,
        column: colName,
        sql: buildDropDefaultSql(tableName, colName),
        destructive: false,
        description: `Drop default from "${colName}" in "${tableName}"`,
      })
    }
    else if (desiredDefault !== null && (liveDefault === null || !sameDefault(desiredDefault, liveDefault, colDef.pgType))) {
      ops.push({
        type: 'alter_column',
        table: tableName,
        column: colName,
        sql: buildSetDefaultSql(tableName, colName, desiredDefault),
        destructive: false,
        description: `Set default of "${colName}" in "${tableName}" to ${desiredDefault}`,
      })
    }
  }

  return ops
}

// A serial column's default is the `nextval()` of the sequence Postgres made for it, which the schema never spells out.
function isOwnSequenceDefault(colDef: AnyColumnDef, liveDefault: string): boolean {
  return SERIAL_TYPE_RE.test(colDef.pgType) && liveDefault.startsWith('nextval(')
}
