import type { Executable } from '../sql/executor'
import type { AnyColumnDef, AnyColumns, AnyTableDef, ColumnConstraint, IndexDef } from '../types/index'
import { DestructiveOpError, MigrationError } from '../errors/index'

// Internal migration tracking table name
const MIGRATION_TABLE = '_pgorm_migrations'

// Typed Object.entries for column maps
function columnEntries(columns: AnyColumns): [string, AnyColumnDef][] {
  return Object.entries(columns) as [string, AnyColumnDef][]
}

// --- Schema Introspection (from information_schema + pg_catalog) ---

interface LiveColumn {
  name: string
  dataType: string
  isNullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isUnique: boolean
  isGenerated: boolean
}

interface LiveTable {
  name: string
  columns: LiveColumn[]
}

interface LiveEnum {
  name: string
  values: string[]
}

interface LiveForeignKey {
  constraintName: string
  tableName: string
  columnName: string
  referencedTable: string
  referencedColumn: string
  onUpdate: string
  onDelete: string
}

interface LiveIndex {
  name: string
  tableName: string
  columns: string[]
  isUnique: boolean
  method: string
  definition: string
}

/** Introspect the live database schema via information_schema and pg_catalog. */
async function runIntrospectionQueries(executor: Executable, schema: string) {
  const colRows = await executor.query(`
    SELECT
      c.table_name, c.column_name, c.data_type, c.udt_name,
      c.is_nullable, c.column_default, c.is_generated, c.generation_expression,
      c.character_maximum_length, c.numeric_precision, c.numeric_scale
    FROM information_schema.columns c
    WHERE c.table_schema = $1
    ORDER BY c.table_name, c.ordinal_position
  `, [schema])

  const pkRows = await executor.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
  `, [schema])

  const uqRows = await executor.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1
  `, [schema])

  const enumRows = await executor.query(`
    SELECT t.typname AS enum_name, e.enumlabel AS enum_value, e.enumsortorder
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1
    ORDER BY t.typname, e.enumsortorder
  `, [schema])

  const fkRows = await executor.query(`
    SELECT
      tc.constraint_name,
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
  `, [schema])

  const indexRows = await executor.query(`
    SELECT
      i.relname AS index_name,
      t.relname AS table_name,
      am.amname AS method,
      ix.indisunique AS is_unique,
      pg_get_indexdef(ix.indexrelid) AS definition,
      array_agg(a.attname ORDER BY x.ordinality) AS columns
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
    WHERE n.nspname = $1
      AND NOT ix.indisprimary
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conindid = ix.indexrelid AND c.contype IN ('u', 'p')
      )
    GROUP BY i.relname, t.relname, am.amname, ix.indisunique, ix.indexrelid
  `, [schema])

  return { colRows, pkRows, uqRows, enumRows, fkRows, indexRows }
}

export async function introspectLiveSchema(executor: Executable, schema = 'public'): Promise<{
  tables: LiveTable[]
  enums: LiveEnum[]
  foreignKeys: LiveForeignKey[]
  indexes: LiveIndex[]
}> {
  const { colRows, pkRows, uqRows, enumRows, fkRows, indexRows } = await runIntrospectionQueries(executor, schema)

  const pkSet = new Set(pkRows.map(r => `${r.table_name}.${r.column_name}`))
  const uqSet = new Set(uqRows.map(r => `${r.table_name}.${r.column_name}`))

  return {
    tables: buildLiveTables(colRows, pkSet, uqSet),
    enums: buildLiveEnums(enumRows),
    foreignKeys: fkRows.map(r => ({
      constraintName: r.constraint_name as string,
      tableName: r.table_name as string,
      columnName: r.column_name as string,
      referencedTable: r.referenced_table as string,
      referencedColumn: r.referenced_column as string,
      onUpdate: (r.update_rule as string).toLowerCase().replace(/ /g, ' '),
      onDelete: (r.delete_rule as string).toLowerCase().replace(/ /g, ' '),
    })),
    indexes: indexRows.map(r => ({
      name: r.index_name as string,
      tableName: r.table_name as string,
      columns: r.columns as string[],
      isUnique: r.is_unique as boolean,
      method: r.method as string,
      definition: r.definition as string,
    })),
  }
}

function buildLiveTables(colRows: Record<string, unknown>[], pkSet: Set<string>, uqSet: Set<string>): LiveTable[] {
  const tableMap = new Map<string, LiveTable>()

  for (const row of colRows) {
    const tableName = row.table_name as string

    // Exclude internal migration tracking table from introspection
    if (tableName === MIGRATION_TABLE)
      continue

    if (!tableMap.has(tableName))
      tableMap.set(tableName, { name: tableName, columns: [] })

    tableMap.get(tableName)!.columns.push({
      name: row.column_name as string,
      dataType: resolveDataType(row),
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default as string | null,
      isPrimaryKey: pkSet.has(`${tableName}.${row.column_name}`),
      isUnique: uqSet.has(`${tableName}.${row.column_name}`),
      isGenerated: row.is_generated === 'ALWAYS',
    })
  }

  return Array.from(tableMap.values())
}

function buildLiveEnums(enumRows: Record<string, unknown>[]): LiveEnum[] {
  const enumMap = new Map<string, string[]>()

  for (const row of enumRows) {
    const name = row.enum_name as string

    if (!enumMap.has(name))
      enumMap.set(name, [])

    enumMap.get(name)!.push(row.enum_value as string)
  }

  return Array.from(enumMap.entries()).map(([name, values]) => ({ name, values }))
}

function resolveDataType(row: Record<string, unknown>): string {
  const udtName = row.udt_name as string
  const dataType = row.data_type as string
  const charLen = row.character_maximum_length as number | null
  const numPrec = row.numeric_precision as number | null
  const numScale = row.numeric_scale as number | null

  // Handle array types
  if (dataType === 'ARRAY')
    return `${udtName.replace(/^_/, '')}[]`

  // Handle user-defined types (enums, etc)
  if (dataType === 'USER-DEFINED')
    return udtName

  // Handle varchar with length
  if (udtName === 'varchar' && charLen)
    return `varchar(${charLen})`

  // Handle numeric with precision
  if (udtName === 'numeric' && numPrec) {
    return numScale ? `numeric(${numPrec},${numScale})` : `numeric(${numPrec})`
  }

  return udtName
}

// --- Schema Diff ---

export interface MigrationOp {
  type: 'create_table' | 'drop_table' | 'add_column' | 'drop_column' | 'alter_column'
    | 'create_enum' | 'alter_enum_add' | 'alter_enum_remove' | 'add_constraint' | 'drop_constraint'
    | 'add_fk' | 'drop_fk'
    | 'create_index' | 'drop_index'
    | 'rename_column'
  table?: string
  column?: string
  sql: string
  destructive: boolean
  description: string
}

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

  // Diff FK constraints for existing tables (new tables already include FKs in CREATE TABLE)
  if (live.foreignKeys) {
    diffForeignKeys(ops, desired, live.foreignKeys)
  }

  // Diff indexes
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

  // Build a map of renamedFrom -> newName for rename detection
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
      // Check if this column was renamed from another column
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

        // Still diff the column properties after rename
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
    // Skip columns that were renamed (already handled above)
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

  // Diff UNIQUE constraint
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
    if (ops.some(o => o.type === 'create_table' && o.table === tableName))
      continue

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

// --- Index Diffing ---

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

    // Collect indexes from column-level .index() and table-level .withIndexes()
    for (const idx of indexes) {
      const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)

      result.set(name, { tableName, idx })
    }

    // Also collect single-column unique constraints as unique indexes for diffing
    // (these are already handled by UNIQUE constraint, skip here)
  }

  return result
}

function indexChanged(liveIdx: LiveIndex, tableName: string, idx: IndexDef): boolean {
  const desiredMethod = idx.method ?? 'btree'

  if (liveIdx.method !== desiredMethod)
    return true

  const desiredCols = idx.columns
  const liveCols = liveIdx.columns

  if (desiredCols.length !== liveCols.length || desiredCols.some((c, i) => c !== liveCols[i]))
    return true

  if ((idx.unique ?? false) !== liveIdx.isUnique)
    return true

  // Compare WHERE clause — extract from live definition if present
  const whereIdx = liveIdx.definition.search(/\bWHERE\b/i)
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

    // New index needed
    ops.push({
      type: 'create_index',
      table: tableName,
      sql: buildCreateIndexSql(tableName, idx),
      destructive: false,
      description: `Create index "${name}" on "${tableName}" (${idx.columns.join(', ')})`,
    })
  }

  // Drop indexes that exist in live but not in desired (only for tables we manage)
  for (const [name, liveIdx] of liveIndexMap) {
    if (!desired.has(liveIdx.tableName))
      continue

    // Don't drop indexes on tables being dropped (table DROP handles it)
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

// --- DDL Generation ---

function generateCreateTable(name: string, table: AnyTableDef): string {
  const colDefs: string[] = []
  const constraints: string[] = []

  for (const [colName, colDef] of columnEntries(table.columns)) {
    colDefs.push(`  ${generateColumnDDL(colName, colDef)}`)
  }

  // Primary key constraint
  const pkCols = columnEntries(table.columns)
    .filter(([, col]) => col.constraints.some((c: ColumnConstraint) => c.type === 'primary_key'))
    .map(([name]) => `"${name}"`)

  if (pkCols.length) {
    constraints.push(`  PRIMARY KEY (${pkCols.join(', ')})`)
  }

  // Unique constraints
  const uqCols = columnEntries(table.columns)
    .filter(([, col]) => col.constraints.some((c: ColumnConstraint) => c.type === 'unique'))
    .map(([name]) => name)

  for (const col of uqCols) {
    constraints.push(`  UNIQUE ("${col}")`)
  }

  // Foreign key constraints
  for (const [colName, colDef] of columnEntries(table.columns)) {
    if (colDef.references) {
      const ref = colDef.references
      const targetTable = ref.table()
      let fkSql = `  FOREIGN KEY ("${colName}") REFERENCES "${targetTable.name}" ("${ref.column}")`

      if (ref.onDelete)
        fkSql += ` ON DELETE ${ref.onDelete.toUpperCase()}`

      if (ref.onUpdate)
        fkSql += ` ON UPDATE ${ref.onUpdate.toUpperCase()}`

      constraints.push(fkSql)
    }
  }

  const all = [...colDefs, ...constraints].join(',\n')

  return `CREATE TABLE "${name}" (\n${all}\n)`
}

function generateColumnDDL(name: string, colDef: AnyColumnDef): string {
  const parts: string[] = [`"${name}"`, colDef.pgType]

  for (const c of colDef.constraints) {
    switch (c.type) {
      case 'not_null': parts.push('NOT NULL')

        break
      case 'default': parts.push(`DEFAULT ${c.value}`)

        break
      case 'generated': parts.push(`GENERATED ALWAYS AS (${c.value}) STORED`)

        break
      case 'check': parts.push(`CHECK (${c.value})`)

        break
      // primary_key, unique, references handled at table level
    }
  }

  return parts.join(' ')
}

function normalizeType(pgType: string): string {
  // Normalize common type aliases and pseudo-types
  return pgType
    .toLowerCase()
    .replace(/^serial$/, 'integer')
    .replace(/^bigserial$/, 'bigint')
    .replace(/^int4$/, 'integer')
    .replace(/^int2$/, 'smallint')
    .replace(/^int8$/, 'bigint')
    .replace(/^float4$/, 'real')
    .replace(/^float8$/, 'double precision')
    .replace(/^bool$/, 'boolean')
    .replace(/^timestamptz$/, 'timestamp with time zone')
    .replace(/^timetz$/, 'time with time zone')
}

// Escape single quotes in enum values for safe DDL embedding
function escapeEnumValue(val: string): string {
  return val.replace(/'/g, '\'\'')
}

function extractEnumInfo(colDef: AnyColumnDef): { name: string, values: string[] } | null {
  const col = colDef as unknown as { _enumName?: string, _enumValues?: string[] }

  if (col._enumName && col._enumValues) {
    return { name: col._enumName, values: col._enumValues }
  }

  return null
}

// --- Migration Runner ---

export interface MigrationFile {
  name: string
  up: string
  down: string
}

/** Generate a timestamped migration file with up/down SQL from the schema diff. */
export async function generateMigration(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
  opts: { allowDestructive?: boolean } = {},
): Promise<MigrationFile | null> {
  const live = await introspectLiveSchema(executor)
  const ops = diffSchema(live, registry)

  if (ops.length === 0)
    return null

  const destructiveOps = ops.filter(o => o.destructive)

  if (destructiveOps.length && !opts.allowDestructive) {
    throw new DestructiveOpError(
      `Migration contains ${destructiveOps.length} destructive operation(s). Use --allow-destructive to proceed.`,
      'diff',
      destructiveOps.map(o => o.description),
    )
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const upSql = ops.map(o => `${o.sql};`).join('\n\n')
  const downSql = ops.reverse().map(o => generateReverseOp(o)).filter(Boolean).join('\n\n')

  return {
    name: `${timestamp}_migration`,
    up: upSql,
    down: downSql,
  }
}

function generateReverseOp(op: MigrationOp): string {
  switch (op.type) {
    case 'create_table': return `DROP TABLE IF EXISTS "${op.table}";`
    case 'drop_table': return `-- Cannot reverse DROP TABLE "${op.table}" without original schema`
    case 'add_column': return `ALTER TABLE "${op.table}" DROP COLUMN IF EXISTS "${op.column}";`
    case 'drop_column': return `-- Cannot reverse DROP COLUMN "${op.table}"."${op.column}" without original type`
    case 'create_enum': return `DROP TYPE IF EXISTS ${op.sql.match(/"(\w+)"/)?.[0] ?? 'unknown'};`
    case 'create_index': return `DROP INDEX IF EXISTS ${op.sql.match(/"(\w+)"/)?.[0] ?? 'unknown'};`
    case 'drop_index': return `-- Cannot reverse DROP INDEX without original definition`
    case 'rename_column': {
      // Extract old and new column names from the SQL
      const match = op.sql.match(/RENAME COLUMN "(\w+)" TO "(\w+)"/)

      return match ? `ALTER TABLE "${op.table}" RENAME COLUMN "${match[2]}" TO "${match[1]}";` : `-- Cannot reverse: ${op.description}`
    }
    default: return `-- Cannot automatically reverse: ${op.description}`
  }
}

/** Execute raw migration SQL against the database. Wraps errors in MigrationError. */
export async function applyMigration(executor: Executable, sql: string): Promise<void> {
  try {
    await executor.query(sql, [])
  }
  catch (err) {
    throw new MigrationError(
      `Migration apply failed: ${err instanceof Error ? err.message : String(err)}`,
      'apply',
      undefined,
      err,
    )
  }
}

// --- Migration History Tracking ---

/** Ensure the migration history table exists. */
export async function ensureMigrationTable(executor: Executable): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS "${MIGRATION_TABLE}" (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      sql_hash TEXT NOT NULL,
      up_sql TEXT NOT NULL,
      down_sql TEXT NOT NULL DEFAULT '',
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      direction TEXT NOT NULL DEFAULT 'up'
    )
  `, [])
}

/** Record a migration in the history table. */
export async function recordMigration(
  executor: Executable,
  entry: { name: string, sqlHash: string, upSql: string, downSql: string, direction?: 'up' | 'down' },
): Promise<void> {
  await executor.query(`
    INSERT INTO "${MIGRATION_TABLE}" (name, sql_hash, up_sql, down_sql, direction)
    VALUES ($1, $2, $3, $4, $5)
  `, [entry.name, entry.sqlHash, entry.upSql, entry.downSql, entry.direction ?? 'up'])
}

/** Get the migration history from the history table. */
export async function getMigrationHistory(executor: Executable): Promise<{
  id: number
  name: string
  sqlHash: string
  upSql: string
  downSql: string
  appliedAt: Date
  direction: 'up' | 'down'
}[]> {
  await ensureMigrationTable(executor)
  const rows = await executor.query(`
    SELECT id, name, sql_hash, up_sql, down_sql, applied_at, direction
    FROM "${MIGRATION_TABLE}"
    ORDER BY id ASC
  `, [])

  return rows.map(r => ({
    id: Number(r.id),
    name: r.name as string,
    sqlHash: r.sql_hash as string,
    upSql: r.up_sql as string,
    downSql: r.down_sql as string,
    appliedAt: r.applied_at as Date,
    direction: r.direction as 'up' | 'down',
  }))
}

/** Check if the live database has drifted from the desired schema. */
export async function getMigrationStatus(
  executor: Executable,
  registry: ReadonlyMap<string, AnyTableDef>,
): Promise<{
  drift: MigrationOp[]
  hasDrift: boolean
}> {
  const live = await introspectLiveSchema(executor)
  const drift = diffSchema(live, registry)

  return { drift, hasDrift: drift.length > 0 }
}
