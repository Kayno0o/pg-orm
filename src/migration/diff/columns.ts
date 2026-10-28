import type { AnyColumnDef, AnyTableDef, ColumnConstraint } from '../../types/index'
import type { LiveColumn, LiveTable, MigrationOp } from '../types'
import { toSQLDefault } from '../../schema/column-default'
import { getColumnMeta } from '../../schema/column-meta'
import {
  buildAddColumnSql,
  buildAddPrimaryKeySql,
  buildAddUniqueConstraintSql,
  buildAddUniqueSql,
  buildAlterColumnTypeSql,
  buildCommentSql,
  buildDropColumnSql,
  buildDropConstraintSql,
  buildDropDefaultSql,
  buildDropExpressionSql,
  buildDropNotNullSql,
  buildRenameColumnSql,
  buildSetDefaultSql,
  buildSetExpressionSql,
  buildSetNotNullSql,
  columnTypeSql,
  identitySql,
  normalizeExpression,
  normalizeType,
  primaryKeyName,
  sameDefault,
  uniqueConstraintName,
  uniqueName,
  usingClause,
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

  const uniques = diffUniques(tableName, tableDef, liveTable)

  return [...uniques.before, ...diffPrimaryKey(tableName, tableDef, liveTable, renameMap, ops), ...uniques.after, ...diffComment(tableName, undefined, tableDef.comment, liveTable.comment)]
}

// A UNIQUE over several columns is matched by name: one gone or over other columns is dropped before the columns change, a new one added after. Only the ones this ORM would have named are dropped, as with CHECKs: one made by hand under another name is left alone.
function diffUniques(tableName: string, tableDef: AnyTableDef, liveTable: LiveTable): { before: MigrationOp[], after: MigrationOp[] } {
  const desired = new Map((tableDef.uniques ?? []).map(u => [uniqueName(tableName, u), u]))
  const owned = (liveTable.uniques ?? []).filter(u => desired.has(u.name) || u.name === uniqueName(tableName, { columns: u.columns }))
  const live = new Map(owned.map(u => [u.name, u]))
  const same = (name: string) => desired.get(name)?.columns.join() === live.get(name)?.columns.join()
  const before: MigrationOp[] = [...live.keys()].filter(name => !same(name)).map(name => ({
    type: 'drop_constraint',
    table: tableName,
    sql: buildDropConstraintSql(tableName, name),
    destructive: true,
    description: `Drop UNIQUE constraint "${name}" from "${tableName}"`,
  }))
  const after: MigrationOp[] = [...desired].filter(([name]) => !same(name)).map(([name, unique]) => ({
    type: 'add_constraint',
    table: tableName,
    sql: buildAddUniqueSql(tableName, unique),
    destructive: false,
    description: `Add UNIQUE constraint "${name}" on (${unique.columns.join(', ')}) to "${tableName}"`,
  }))

  return { before, after }
}

/** The op setting the comment of a table, or of one of its columns, when it differs from the live one; reverted by setting the live one back. */
export function diffComment(tableName: string, colName: string | undefined, desired: string | undefined, live: string | null | undefined): MigrationOp[] {
  // Postgres stores an empty comment as none.
  if ((desired || null) === (live ?? null))
    return []

  return [{
    type: 'comment',
    table: tableName,
    column: colName,
    sql: buildCommentSql(tableName, colName, desired ?? null),
    destructive: false,
    description: `${desired === undefined ? 'Remove' : 'Set'} the comment of ${colName === undefined ? `table "${tableName}"` : `"${colName}" in "${tableName}"`}`,
    down: buildCommentSql(tableName, colName, live ?? null),
  }]
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
      sql: buildDropConstraintSql(tableName, liveTable.primaryKeyConstraint ?? primaryKeyName(tableName)),
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
  const needsFill = has('not_null') && !has('default') && !has('generated') && !has('identity') && !SERIAL_TYPE_RE.test(colDef.pgType)
  const { backfill } = getColumnMeta(colDef)
  const fill = needsFill && backfill ? toSQLDefault(backfill.value, columnTypeSql(colDef)) : undefined
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
      down: buildSetDefaultSql(tableName, colName, fill),
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

  return [...ops, ...diffComment(tableName, colName, getColumnMeta(colDef).comment, null)]
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

  return [{
    type: 'alter_column',
    table: tableName,
    column: colName,
    sql: buildAlterColumnTypeSql(tableName, colName, columnTypeSql(ctx.colDef), usingClause(colName, ctx.liveType, ctx.desiredType, columnTypeSql(ctx.colDef))),
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

  const retyped = desiredType !== liveType
  // A default is not cast along with its column: it is dropped before the type changes and set again after. A vector column is added anew instead.
  const dropsDefault = retyped && !desiredType.startsWith('vector') && !liveType.startsWith('vector')
    && liveCol.defaultValue !== null && !isOwnSequenceDefault(colDef, liveCol.defaultValue)

  if (dropsDefault) {
    ops.push({
      type: 'alter_column',
      table: tableName,
      column: colName,
      sql: buildDropDefaultSql(tableName, colName),
      destructive: false,
      description: `Drop default from "${colName}" in "${tableName}" before its type changes`,
    })
  }

  if (retyped)
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
      sql: buildDropConstraintSql(tableName, liveCol.uniqueConstraint ?? uniqueConstraintName(tableName, colName)),
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
      down: buildDropNotNullSql(tableName, colName),
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
      down: buildSetNotNullSql(tableName, colName),
      destructive: false,
      description: `Drop NOT NULL from "${colName}" in "${tableName}"`,
    })
  }

  const desiredIdentity = colDef.constraints.find((c: ColumnConstraint) => c.type === 'identity')?.value as 'always' | 'by default' | undefined

  if ((!liveCol.isPrimaryKey || dropsDefault) && desiredExpr === undefined && desiredIdentity === undefined) {
    const desiredDefault = colDef.constraints.find((c: ColumnConstraint) => c.type === 'default')?.value ?? null
    const liveDefault = dropsDefault ? null : liveCol.defaultValue

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

  return [
    ...ops,
    ...diffIdentity(tableName, colName, desiredIdentity, liveCol),
    ...diffComment(tableName, colName, getColumnMeta(colDef).comment, liveCol.comment),
  ]
}

// A column made an identity loses its default first, a serial's sequence included, and its sequence starts past the values already there.
function diffIdentity(tableName: string, colName: string, desired: 'always' | 'by default' | undefined, liveCol: LiveColumn): MigrationOp[] {
  const live = liveCol.identity ?? null

  if ((desired ?? null) === live)
    return []

  const op = (sql: string, description: string): MigrationOp => ({ type: 'alter_column', table: tableName, column: colName, sql, destructive: false, description })
  const alter = `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}"`

  if (desired === undefined)
    return [op(`${alter} DROP IDENTITY IF EXISTS`, `Make "${colName}" in "${tableName}" a plain column, no longer an identity`)]

  if (live !== null)
    return [op(`${alter} SET GENERATED ${desired === 'always' ? 'ALWAYS' : 'BY DEFAULT'}`, `Generate "${colName}" in "${tableName}" ${desired}`)]

  return [
    ...liveCol.defaultValue === null ? [] : [op(buildDropDefaultSql(tableName, colName), `Drop default from "${colName}" in "${tableName}" before it becomes an identity`)],
    op(`${alter} ADD ${identitySql(desired)}`, `Make "${colName}" in "${tableName}" an identity column`),
    // The identity's own sequence, found by its internal dependency: a former serial's sequence stays owned by the column too.
    op(`SELECT setval(d.objid::regclass, (SELECT COALESCE(MAX("${colName}"), 0) + 1 FROM "${tableName}"), false) FROM pg_depend d JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid WHERE d.refobjid = '"${tableName}"'::regclass AND a.attname = '${colName}' AND d.deptype = 'i' AND d.classid = 'pg_class'::regclass`, `Start the identity of "${colName}" in "${tableName}" past its values`),
  ]
}

// A serial column's default is the `nextval()` of the sequence Postgres made for it, which the schema never spells out.
function isOwnSequenceDefault(colDef: AnyColumnDef, liveDefault: string): boolean {
  return SERIAL_TYPE_RE.test(colDef.pgType) && liveDefault.startsWith('nextval(')
}
