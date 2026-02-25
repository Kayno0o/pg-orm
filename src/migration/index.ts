import type { Executable } from '../sql/executor'
import type { AnyColumnDef, AnyColumns, AnyTableDef, ColumnConstraint } from '../types/index'
import { DestructiveOpError, MigrationError } from '../errors/index'

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

/** Introspect the live database schema via information_schema and pg_catalog. */
export async function introspectLiveSchema(executor: Executable, schema = 'public'): Promise<{
  tables: LiveTable[]
  enums: LiveEnum[]
  foreignKeys: LiveForeignKey[]
}> {
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
  }
}

function buildLiveTables(colRows: Record<string, unknown>[], pkSet: Set<string>, uqSet: Set<string>): LiveTable[] {
  const tableMap = new Map<string, LiveTable>()

  for (const row of colRows) {
    const tableName = row.table_name as string

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
  live: { tables: LiveTable[], enums: LiveEnum[], foreignKeys?: LiveForeignKey[] },
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

  for (const [colName, colDef] of columnEntries(tableDef.columns)) {
    const liveCol = liveColMap.get(colName)

    if (!liveCol) {
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

function diffColumn(ops: MigrationOp[], tableName: string, colName: string, colDef: AnyColumnDef, liveCol: LiveColumn): void {
  const desiredType = normalizeType(colDef.pgType)
  const liveType = normalizeType(liveCol.dataType)

  if (desiredType !== liveType) {
    if (desiredType.startsWith('vector') || liveType.startsWith('vector')) {
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
        sql: `ALTER TABLE "${tableName}" ADD COLUMN ${generateColumnDDL(colName, colDef)}`,
        destructive: true,
        description: `Re-add column "${colName}" to "${tableName}" with new vector dimensions`,
      })
    }
    else {
      ops.push({
        type: 'alter_column',
        table: tableName,
        column: colName,
        sql: `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${colDef.pgType}`,
        destructive: true,
        description: `Change type of "${colName}" in "${tableName}" from ${liveType} to ${desiredType}`,
      })
    }
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
        if (ops.some(o => o.type === 'add_column' && o.table === tableName && o.column === colName))
          continue

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
