import type { AnyColumnDef, AnyTableDef, ForeignKeyRef, IndexDef } from '../types/index'
import { escapeLiteralBody } from '../sql/utils'
import { columnChecks } from './checks'
import { collectConstraints } from './constraint-collector'
import { BIGSERIAL_RE, BOOL_RE, DEFAULT_CAST_RE, FLOAT4_RE, FLOAT8_RE, INT2_RE, INT4_RE, INT8_RE, QUOTED_NUMBER_RE, SERIAL_RE, SPACE_RE, TIMESTAMPTZ_RE, TIMETZ_RE } from './regex'

export function generateCreateTable(name: string, table: AnyTableDef): string {
  const { colDefs, pkCols, uniqueCols } = collectConstraints(table, (col, def) => generateColumnDDL(col, def, name))
  const constraints: string[] = []

  if (pkCols.length)
    constraints.push(`  PRIMARY KEY (${pkCols.join(', ')})`)

  for (const col of uniqueCols)
    constraints.push(`  UNIQUE ("${col}")`)

  // FK constraints are emitted as separate `add_fk` ops after all CREATE TABLEs,
  // so cross-table FK ordering is not constrained by declaration order.

  const all = [...colDefs, ...constraints].join(',\n')

  return `CREATE TABLE "${name}" (\n${all}\n)`
}

/** A column's DDL. Given the table name, its CHECKs are named as `sync()` diffs them; without it they are left for PG to name. */
export function generateColumnDDL(name: string, colDef: AnyColumnDef, tableName?: string): string {
  const parts: string[] = [`"${name}"`, colDef.pgType]

  for (const c of colDef.constraints) {
    switch (c.type) {
      case 'not_null': parts.push('NOT NULL')

        break
      case 'default': parts.push(`DEFAULT ${c.value}`)

        break
      case 'generated': parts.push(`GENERATED ALWAYS AS (${c.value}) STORED`)

        break
      // check, primary_key, unique, references handled below or at table level
    }
  }

  for (const check of columnChecks(tableName ?? '', name, colDef))
    parts.push(tableName ? `CONSTRAINT "${check.name}" CHECK (${check.expr})` : `CHECK (${check.expr})`)

  return parts.join(' ')
}

export function normalizeDefault(pgDefault: string): string {
  return pgDefault.toLowerCase().replace(DEFAULT_CAST_RE, '').replace(SPACE_RE, '').replace(QUOTED_NUMBER_RE, '$1')
}

export function normalizeType(pgType: string): string {
  return pgType
    .toLowerCase()
    .replace(SERIAL_RE, 'integer')
    .replace(BIGSERIAL_RE, 'bigint')
    .replace(INT4_RE, 'integer')
    .replace(INT2_RE, 'smallint')
    .replace(INT8_RE, 'bigint')
    .replace(FLOAT4_RE, 'real')
    .replace(FLOAT8_RE, 'double precision')
    .replace(BOOL_RE, 'boolean')
    .replace(TIMESTAMPTZ_RE, 'timestamp with time zone')
    .replace(TIMETZ_RE, 'time with time zone')
}

// PostgreSQL can implicitly cast between many scalar types (int -> bigint,
// varchar -> text, etc.), but not from json/jsonb to an array type. When such
// a change is requested via ALTER COLUMN ... TYPE, Postgres requires an
// explicit USING expression.
export function needsUsingCast(liveType: string, desiredType: string): boolean {
  return (liveType === 'json' || liveType === 'jsonb') && desiredType.endsWith('[]')
}

// --- Table lifecycle ---

export function buildDropTableSql(name: string): string {
  return `DROP TABLE "${name}"`
}

// --- Column lifecycle ---

export function buildAddColumnSql(tableName: string, colName: string, colDef: AnyColumnDef): string {
  return `ALTER TABLE "${tableName}" ADD COLUMN ${generateColumnDDL(colName, colDef, tableName)}`
}

export function buildDropColumnSql(tableName: string, colName: string): string {
  return `ALTER TABLE "${tableName}" DROP COLUMN "${colName}"`
}

export function buildRenameColumnSql(tableName: string, oldName: string, newName: string): string {
  return `ALTER TABLE "${tableName}" RENAME COLUMN "${oldName}" TO "${newName}"`
}

export function buildAlterColumnTypeSql(
  tableName: string,
  colName: string,
  pgType: string,
  usingClause?: string,
): string {
  return `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" TYPE ${pgType}${usingClause ?? ''}`
}

export function buildSetNotNullSql(tableName: string, colName: string): string {
  return `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET NOT NULL`
}

export function buildDropNotNullSql(tableName: string, colName: string): string {
  return `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP NOT NULL`
}

export function buildSetDefaultSql(tableName: string, colName: string, value: string): string {
  return `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET DEFAULT ${value}`
}

export function buildDropDefaultSql(tableName: string, colName: string): string {
  return `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP DEFAULT`
}

// --- Constraint lifecycle ---

export function buildAddUniqueConstraintSql(tableName: string, colName: string): string {
  return `ALTER TABLE "${tableName}" ADD CONSTRAINT "${tableName}_${colName}_key" UNIQUE ("${colName}")`
}

export function buildAddCheckSql(tableName: string, name: string, expr: string): string {
  return `ALTER TABLE "${tableName}" ADD CONSTRAINT "${name}" CHECK (${expr})`
}

export function buildDropConstraintSql(tableName: string, constraintName: string): string {
  return `ALTER TABLE "${tableName}" DROP CONSTRAINT IF EXISTS "${constraintName}"`
}

// --- Foreign-key lifecycle ---

export function buildAddFkSql(tableName: string, colName: string, ref: ForeignKeyRef): string {
  const targetTable = ref.table()
  let sql = `ALTER TABLE "${tableName}" ADD CONSTRAINT "${tableName}_${colName}_fkey" FOREIGN KEY ("${colName}") REFERENCES "${targetTable.name}" ("${ref.column}")`

  if (ref.onDelete)
    sql += ` ON DELETE ${ref.onDelete.toUpperCase()}`

  if (ref.onUpdate)
    sql += ` ON UPDATE ${ref.onUpdate.toUpperCase()}`

  return sql
}

export function buildDropFkSql(tableName: string, constraintName: string): string {
  return `ALTER TABLE "${tableName}" DROP CONSTRAINT "${constraintName}"`
}

// --- Index lifecycle ---

export function buildIndexName(tableName: string, columns: string[], unique: boolean): string {
  const suffix = unique ? 'unique' : 'idx'

  return `${tableName}_${columns.join('_')}_${suffix}`
}

export function buildCreateIndexSql(tableName: string, idx: IndexDef): string {
  const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)
  const method = idx.method ?? 'btree'
  const unique = idx.unique ? 'UNIQUE ' : ''
  const cols = idx.columns.map(c => `"${c}"`).join(', ')
  let sql = `CREATE ${unique}INDEX "${name}" ON "${tableName}" USING ${method} (${cols})`

  if (idx.where)
    sql += ` WHERE ${idx.where}`

  return sql
}

export function buildDropIndexSql(name: string): string {
  return `DROP INDEX "${name}"`
}

// --- Enum lifecycle ---

export function buildCreateEnumSql(name: string, values: string[]): string {
  const escaped = values.map(v => `'${escapeEnumValue(v)}'`).join(', ')

  return `CREATE TYPE "${name}" AS ENUM (${escaped})`
}

export function buildAlterEnumAddSql(name: string, value: string): string {
  return `ALTER TYPE "${name}" ADD VALUE IF NOT EXISTS '${escapeEnumValue(value)}'`
}

export function buildEnumReplacementSqls(
  enumName: string,
  values: string[],
  usages: { table: string, column: string }[],
): string[] {
  const escapedValues = values.map(v => `'${escapeEnumValue(v)}'`).join(', ')
  const tmpName = `${enumName}_new`
  const sqls: string[] = [
    `CREATE TYPE "${tmpName}" AS ENUM (${escapedValues})`,
  ]

  for (const usage of usages) {
    sqls.push(
      `ALTER TABLE "${usage.table}" ALTER COLUMN "${usage.column}" TYPE "${tmpName}" USING "${usage.column}"::text::"${tmpName}"`,
    )
  }

  sqls.push(`DROP TYPE "${enumName}"`)
  sqls.push(`ALTER TYPE "${tmpName}" RENAME TO "${enumName}"`)

  return sqls
}

function escapeEnumValue(val: string): string {
  return escapeLiteralBody(val)
}
