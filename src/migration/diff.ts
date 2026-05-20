import type { AnyColumnDef, AnyTableDef, ColumnConstraint, IndexDef } from '../types/index'
import type { LiveColumn, LiveEnum, LiveForeignKey, LiveIndex, LiveTable, MigrationOp } from './types'
import { SINGLE_QUOTE_RE } from '../utils/regex'
import { generateColumnDDL, generateCreateTable, normalizeType } from './ddl'
import { WHERE_RE } from './regex'
import { columnEntries } from './types'

/**
 * Compare live database schema against desired table definitions and return migration operations.
 * Detects: create/drop tables, add/drop/alter columns, enum create/add/remove.
 * Destructive operations are flagged with `destructive: true`.
 */
export function diffSchema(
  live: { tables: LiveTable[], enums: LiveEnum[], foreignKeys?: LiveForeignKey[], indexes?: LiveIndex[] },
  desired: ReadonlyMap<string, AnyTableDef>,
): MigrationOp[] {
  const ops: MigrationOp[] = []
  const liveTableMap = new Map(live.tables.map(t => [t.name, t]))
  const liveEnumMap = new Map(live.enums.map(e => [e.name, e]))

  const neededEnums = new Map<string, string[]>()
  const enumUsages = new Map<string, { table: string, column: string }[]>()

  for (const [tableName, tableDef] of desired) {
    collectEnumInfo(tableDef, tableName, neededEnums, enumUsages)

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

  diffEnums(ops, neededEnums, enumUsages, liveEnumMap)

  // Diff FK constraints — emits add_fk ops for both new and existing tables.
  // Runs unconditionally so new-table FKs are still added when callers omit `foreignKeys`.
  diffForeignKeys(ops, desired, live.foreignKeys ?? [])

  diffIndexes(ops, desired, live.indexes ?? [])

  return ops
}

function collectEnumInfo(
  tableDef: AnyTableDef,
  tableName: string,
  neededEnums: Map<string, string[]>,
  enumUsages: Map<string, { table: string, column: string }[]>,
): void {
  for (const [colName, colDef] of columnEntries(tableDef.columns)) {
    const enumInfo = extractEnumInfo(colDef)

    if (enumInfo) {
      neededEnums.set(enumInfo.name, enumInfo.values)

      if (!enumUsages.has(enumInfo.name))
        enumUsages.set(enumInfo.name, [])

      enumUsages.get(enumInfo.name)!.push({ table: tableName, column: colName })
    }
  }
}

function diffTableColumns(ops: MigrationOp[], tableName: string, tableDef: AnyTableDef, liveTable: LiveTable): void {
  const liveColMap = new Map(liveTable.columns.map(c => [c.name, c]))

  const renameMap = new Map<string, string>()

  for (const [colName, colDef] of columnEntries(tableDef.columns)) {
    const renamedFrom = (colDef as unknown as { _renamedFrom?: string })._renamedFrom

    if (renamedFrom) {
      renameMap.set(renamedFrom, colName)
    }
  }

  for (const [colName, colDef] of columnEntries(tableDef.columns)) {
    const liveCol = liveColMap.get(colName)

    if (!liveCol) {
      const renamedFrom = (colDef as unknown as { _renamedFrom?: string })._renamedFrom
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

function diffColumn(ops: MigrationOp[], tableName: string, colName: string, colDef: AnyColumnDef, liveCol: LiveColumn): void {
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

function diffEnums(
  ops: MigrationOp[],
  neededEnums: Map<string, string[]>,
  enumUsages: Map<string, { table: string, column: string }[]>,
  liveEnumMap: Map<string, LiveEnum>,
): void {
  for (const [enumName, values] of neededEnums) {
    const liveEnum = liveEnumMap.get(enumName)

    if (!liveEnum) {
      ops.unshift({
        type: 'create_enum',
        sql: `CREATE TYPE "${enumName}" AS ENUM (${values.map(v => `'${escapeEnumValue(v)}'`).join(', ')})`,
        destructive: false,
        description: `Create enum type "${enumName}"`,
      })

      continue
    }

    for (const val of values) {
      if (!liveEnum.values.includes(val)) {
        ops.unshift({
          type: 'alter_enum_add',
          sql: `ALTER TYPE "${enumName}" ADD VALUE IF NOT EXISTS '${escapeEnumValue(val)}'`,
          destructive: false,
          description: `Add value '${val}' to enum "${enumName}"`,
        })
      }
    }

    // PG does not support ALTER TYPE ... DROP VALUE. Must: create new type,
    // alter all columns to use it, drop old type, rename new to old.
    const removedValues = liveEnum.values.filter(v => !values.includes(v))

    if (removedValues.length > 0)
      pushEnumRemovalOps(ops, enumName, values, removedValues, enumUsages)
  }
}

function pushEnumRemovalOps(
  ops: MigrationOp[],
  enumName: string,
  values: string[],
  removedValues: string[],
  enumUsages: Map<string, { table: string, column: string }[]>,
): void {
  const escapedValues = values.map(v => `'${escapeEnumValue(v)}'`).join(', ')
  const tmpName = `${enumName}_new`
  const usages = enumUsages.get(enumName) ?? []

  ops.push({
    type: 'alter_enum_remove',
    sql: `CREATE TYPE "${tmpName}" AS ENUM (${escapedValues})`,
    destructive: true,
    description: `Create replacement enum "${tmpName}" without values: ${removedValues.join(', ')}`,
  })

  for (const usage of usages) {
    ops.push({
      type: 'alter_enum_remove',
      sql: `ALTER TABLE "${usage.table}" ALTER COLUMN "${usage.column}" TYPE "${tmpName}" USING "${usage.column}"::text::"${tmpName}"`,
      destructive: true,
      description: `Migrate "${usage.table}"."${usage.column}" to replacement enum`,
    })
  }

  ops.push({
    type: 'alter_enum_remove',
    sql: `DROP TYPE "${enumName}"`,
    destructive: true,
    description: `Drop old enum type "${enumName}"`,
  })
  ops.push({
    type: 'alter_enum_remove',
    sql: `ALTER TYPE "${tmpName}" RENAME TO "${enumName}"`,
    destructive: true,
    description: `Rename "${tmpName}" to "${enumName}"`,
  })
}

function buildAddFkSql(tableName: string, colName: string, ref: { table: () => AnyTableDef, column: string, onDelete?: string, onUpdate?: string }): string {
  const targetTable = ref.table()
  let sql = `ALTER TABLE "${tableName}" ADD CONSTRAINT "${tableName}_${colName}_fkey" FOREIGN KEY ("${colName}") REFERENCES "${targetTable.name}" ("${ref.column}")`

  if (ref.onDelete)
    sql += ` ON DELETE ${ref.onDelete.toUpperCase()}`

  if (ref.onUpdate)
    sql += ` ON UPDATE ${ref.onUpdate.toUpperCase()}`

  return sql
}

function fkChanged(liveFk: LiveForeignKey, ref: { table: () => AnyTableDef, column: string, onDelete?: string, onUpdate?: string }): boolean {
  const targetTable = ref.table()

  return liveFk.referencedTable !== targetTable.name
    || liveFk.referencedColumn !== ref.column
    || liveFk.onDelete !== (ref.onDelete ?? 'no action').toLowerCase()
    || liveFk.onUpdate !== (ref.onUpdate ?? 'no action').toLowerCase()
}

function diffForeignKeys(
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

function buildIndexName(tableName: string, columns: string[], unique: boolean): string {
  const suffix = unique ? 'unique' : 'idx'

  return `${tableName}_${columns.join('_')}_${suffix}`
}

function buildCreateIndexSql(tableName: string, idx: IndexDef): string {
  const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)
  const method = idx.method ?? 'btree'
  const unique = idx.unique ? 'UNIQUE ' : ''
  const cols = idx.columns.map(c => `"${c}"`).join(', ')
  let sql = `CREATE ${unique}INDEX "${name}" ON "${tableName}" USING ${method} (${cols})`

  if (idx.where) {
    sql += ` WHERE ${idx.where}`
  }

  return sql
}

function collectDesiredIndexes(desired: ReadonlyMap<string, AnyTableDef>): Map<string, { tableName: string, idx: IndexDef }> {
  const result = new Map<string, { tableName: string, idx: IndexDef }>()

  for (const [tableName, tableDef] of desired) {
    const indexes = tableDef.indexes ?? []

    for (const idx of indexes) {
      const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)

      result.set(name, { tableName, idx })
    }
  }

  return result
}

function indexChanged(liveIdx: LiveIndex, _tableName: string, idx: IndexDef): boolean {
  const desiredMethod = idx.method ?? 'btree'

  if (liveIdx.method !== desiredMethod)
    return true

  const desiredCols = idx.columns
  const liveCols = liveIdx.columns

  if (desiredCols.length !== liveCols.length || desiredCols.some((c, i) => c !== liveCols[i]))
    return true

  if ((idx.unique ?? false) !== liveIdx.isUnique)
    return true

  const whereIdx = liveIdx.definition.search(WHERE_RE)
  const liveWhere = whereIdx >= 0 ? liveIdx.definition.slice(whereIdx + 6).trim() : undefined
  const desiredWhere = idx.where?.trim()

  if ((desiredWhere ?? '') !== (liveWhere ?? ''))
    return true

  return false
}

function diffIndexes(
  ops: MigrationOp[],
  desired: ReadonlyMap<string, AnyTableDef>,
  liveIndexes: LiveIndex[],
): void {
  const desiredIndexes = collectDesiredIndexes(desired)
  const liveIndexMap = new Map(liveIndexes.map(i => [i.name, i]))

  for (const [name, { tableName, idx }] of desiredIndexes) {
    if (liveIndexMap.has(name)) {
      const liveIdx = liveIndexMap.get(name)!

      if (indexChanged(liveIdx, tableName, idx)) {
        ops.push({
          type: 'drop_index',
          table: tableName,
          sql: `DROP INDEX "${name}"`,
          destructive: true,
          description: `Drop index "${name}" from "${tableName}" (changed)`,
        })
        ops.push({
          type: 'create_index',
          table: tableName,
          sql: buildCreateIndexSql(tableName, idx),
          destructive: false,
          description: `Recreate index "${name}" on "${tableName}" (${idx.columns.join(', ')})`,
        })
      }

      liveIndexMap.delete(name)

      continue
    }

    ops.push({
      type: 'create_index',
      table: tableName,
      sql: buildCreateIndexSql(tableName, idx),
      destructive: false,
      description: `Create index "${name}" on "${tableName}" (${idx.columns.join(', ')})`,
    })
  }

  for (const [name, liveIdx] of liveIndexMap) {
    if (!desired.has(liveIdx.tableName))
      continue

    if (ops.some(o => o.type === 'drop_table' && o.table === liveIdx.tableName))
      continue

    ops.push({
      type: 'drop_index',
      table: liveIdx.tableName,
      sql: `DROP INDEX "${name}"`,
      destructive: true,
      description: `Drop index "${name}" from "${liveIdx.tableName}"`,
    })
  }
}

function escapeEnumValue(val: string): string {
  return val.replace(SINGLE_QUOTE_RE, '\'\'')
}

function extractEnumInfo(colDef: AnyColumnDef): { name: string, values: string[] } | null {
  const col = colDef as unknown as { _enumName?: string, _enumValues?: string[] }

  if (col._enumName && col._enumValues) {
    return { name: col._enumName, values: col._enumValues }
  }

  return null
}
