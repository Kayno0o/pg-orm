import type { AnyColumnDef, AnyTableDef } from '../types/index'
import type { MigrationOp } from './types'
import { getColumnMeta } from '../schema/column-meta'
import { escapeLiteralBody } from '../sql/utils'
import { QUOTED_IDENT_RE, RENAME_COLUMN_RE } from '../utils/regex'
import { collectConstraints } from './constraint-collector'
import { BIGSERIAL_RE, BOOL_RE, FLOAT4_RE, FLOAT8_RE, INT2_RE, INT4_RE, INT8_RE, SERIAL_RE, TIMESTAMPTZ_RE, TIMETZ_RE } from './regex'

export function generateCreateTable(name: string, table: AnyTableDef): string {
  const { colDefs, pkCols, uniqueCols } = collectConstraints(table, generateColumnDDL)
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

export function generateColumnDDL(name: string, colDef: AnyColumnDef): string {
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

  const meta = getColumnMeta(colDef)
  const checks: string[] = []

  if (meta.min != null)
    checks.push(`"${name}" >= ${meta.min}`)

  if (meta.max != null)
    checks.push(`"${name}" <= ${meta.max}`)

  if (meta.minLength != null)
    checks.push(`length("${name}") >= ${meta.minLength}`)

  if (meta.maxLength != null)
    checks.push(`length("${name}") <= ${meta.maxLength}`)

  if (meta.pattern != null)
    checks.push(`"${name}" ~ '${escapeLiteralBody(meta.pattern)}'`)

  if (meta.oneOf != null) {
    const vals = meta.oneOf.map(v =>
      typeof v === 'string' ? `'${escapeLiteralBody(v)}'` : String(v),
    ).join(', ')

    checks.push(`"${name}" IN (${vals})`)
  }

  if (checks.length > 0)
    parts.push(`CHECK (${checks.join(' AND ')})`)

  return parts.join(' ')
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

export function generateReverseOp(op: MigrationOp): string {
  switch (op.type) {
    case 'create_table': return `DROP TABLE IF EXISTS "${op.table}";`
    case 'drop_table': return `-- Cannot reverse DROP TABLE "${op.table}" without original schema`
    case 'add_column': return `ALTER TABLE "${op.table}" DROP COLUMN IF EXISTS "${op.column}";`
    case 'drop_column': return `-- Cannot reverse DROP COLUMN "${op.table}"."${op.column}" without original type`
    case 'create_enum': return `DROP TYPE IF EXISTS ${op.sql.match(QUOTED_IDENT_RE)?.[0] ?? 'unknown'};`
    case 'create_index': return `DROP INDEX IF EXISTS ${op.sql.match(QUOTED_IDENT_RE)?.[0] ?? 'unknown'};`
    case 'drop_index': return `-- Cannot reverse DROP INDEX without original definition`
    case 'add_fk': return `ALTER TABLE "${op.table}" DROP CONSTRAINT IF EXISTS "${op.table}_${op.column}_fkey";`
    case 'rename_column': {
      const match = op.sql.match(RENAME_COLUMN_RE)

      return match ? `ALTER TABLE "${op.table}" RENAME COLUMN "${match[2]}" TO "${match[1]}";` : `-- Cannot reverse: ${op.description}`
    }
    default: return `-- Cannot automatically reverse: ${op.description}`
  }
}
