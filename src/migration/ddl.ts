import type { AnyColumnDef, AnyTableDef, ForeignKeyRef, IndexDef } from '../types/index'
import { escapeLiteralBody } from '../sql/utils'
import { columnChecks } from './checks'
import { collectConstraints } from './constraint-collector'
import { DEFAULT_CAST_RE, DEFAULT_LITERAL_RE, LONE_LITERAL_RE, PLAIN_NUMBER_RE, PREDICATE_CAST_RE, PREDICATE_NOISE_RE, QUOTED_NUMBER_RE, SHORT_OFFSET_RE, TIME_ZONE_RE, TIMESTAMP_SEPARATOR_RE, TYPE_PARTS_RE, TYPE_QUALIFIER_RE, WHITESPACE_RE } from './regex'

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

// Each alias Postgres accepts for a type, by the name format_type() prints it under.
const TYPE_ALIASES: Record<string, string> = {
  int2: 'smallint',
  smallserial: 'smallint',
  serial2: 'smallint',
  int: 'integer',
  int4: 'integer',
  serial: 'integer',
  serial4: 'integer',
  int8: 'bigint',
  bigserial: 'bigint',
  serial8: 'bigint',
  float4: 'real',
  float8: 'double precision',
  bool: 'boolean',
  decimal: 'numeric',
  timestamp: 'timestamp without time zone',
  timestamptz: 'timestamp with time zone',
  time: 'time without time zone',
  timetz: 'time with time zone',
  char: 'character',
  bpchar: 'character',
  varchar: 'character varying',
  varbit: 'bit varying',
}

// Types whose bare name means a length of one.
const LENGTH_ONE_TYPES = new Set(['character', 'bit'])

/** A type in the spelling format_type() prints it in, so a schema type and a live one compare as text: `varchar(10)[]` and `character varying(10)[]` are one type. */
export function normalizeType(pgType: string): string {
  const unqualified = pgType.toLowerCase().replaceAll('"', '').trim().replace(TYPE_QUALIFIER_RE, '')
  const parts = TYPE_PARTS_RE.exec(unqualified)

  // A modifier inside the name (`timestamp(3) with time zone`) is left as written.
  if (!parts)
    return unqualified

  const [, rawName = '', rawModifier, brackets] = parts
  const name = TYPE_ALIASES[rawName.trim()] ?? rawName.trim()
  let modifier = rawModifier?.replace(WHITESPACE_RE, '')

  if (name === 'numeric' && modifier && !modifier.includes(','))
    modifier = `${modifier},0`
  else if (modifier === undefined && LENGTH_ONE_TYPES.has(name))
    modifier = '1'

  // Postgres keeps no array dimensions: `text[][]` is `text[]`.
  return `${name}${modifier !== undefined ? `(${modifier})` : ''}${brackets ? '[]' : ''}`
}

/** A default expression with spacing, case and casts dropped outside its quoted literals, and redundant outer parentheses removed. */
export function normalizeDefault(pgDefault: string): string {
  const joined = pgDefault
    .split(DEFAULT_LITERAL_RE)
    .map((part, i) => i % 2 === 1 ? part : part.replace(WHITESPACE_RE, '').toLowerCase().replace(DEFAULT_CAST_RE, ''))
    .join('')

  return unwrapParens(joined).replace(QUOTED_NUMBER_RE, '$1')
}

function unwrapParens(expr: string): string {
  while (expr.startsWith('(') && closingParen(expr) === expr.length - 1)
    expr = expr.slice(1, -1)

  return expr
}

// Where the parenthesis opening `expr` closes, skipping quoted literals.
function closingParen(expr: string): number {
  let depth = 0
  let quoted = false

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]

    if (ch === '\'')
      quoted = !quoted
    else if (!quoted && ch === '(')
      depth++
    else if (!quoted && ch === ')' && --depth === 0)
      return i
  }

  return -1
}

// Compares expressions as Postgres prints them back (an index predicate, a generated column), so one spelled differently is not rewritten on every sync. Dropping every parenthesis is a heuristic: it cannot tell `(a OR b) AND c` from `a OR (b AND c)`.
export function normalizeExpression(expr: string | null | undefined): string {
  return (expr ?? '').toLowerCase().replace(PREDICATE_CAST_RE, '').replace(PREDICATE_NOISE_RE, '')
}

const EMPTY_ARRAY_DEFAULTS = new Set(['array[]', '\'{}\''])

/** Whether a schema default and a live one, as Postgres prints it back, give the same value: Postgres respells literals (a jsonb's key order, a timestamp's format, an empty array as `'{}'`). */
export function sameDefault(desired: string, live: string, pgType: string): boolean {
  const a = normalizeDefault(desired)
  const b = normalizeDefault(live)

  if (a === b)
    return true

  if (EMPTY_ARRAY_DEFAULTS.has(a) && EMPTY_ARRAY_DEFAULTS.has(b))
    return true

  if (PLAIN_NUMBER_RE.test(a) && PLAIN_NUMBER_RE.test(b))
    return Number(a) === Number(b)

  const desiredBody = LONE_LITERAL_RE.exec(a)?.[1]
  const liveBody = LONE_LITERAL_RE.exec(b)?.[1]

  if (desiredBody === undefined || liveBody === undefined)
    return false

  return sameLiteral(desiredBody.replaceAll('\'\'', '\''), liveBody.replaceAll('\'\'', '\''), normalizeType(pgType))
}

function sameLiteral(desired: string, live: string, type: string): boolean {
  switch (type) {
    case 'json':
    case 'jsonb': {
      const canonical = canonicalJson(desired)

      return canonical !== undefined && canonical === canonicalJson(live)
    }
    case 'date':
      return desired.slice(0, 10) === live.slice(0, 10)
    case 'timestamp with time zone':
      return sameInstant(desired, live, false)
    case 'timestamp without time zone':
      return sameInstant(desired, live, true)
    default:
      return false
  }
}

function canonicalJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), (_key, value: unknown) => isPlainObject(value)
      ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0))
      : value)
  }
  catch {
    return undefined
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameInstant(desired: string, live: string, ignoreZone: boolean): boolean {
  const a = parseTimestamp(desired, ignoreZone)

  return !Number.isNaN(a) && a === parseTimestamp(live, ignoreZone)
}

// A time without a zone, or whose zone a `timestamp without time zone` ignores, is read as UTC on both sides.
function parseTimestamp(text: string, ignoreZone: boolean): number {
  const [date, time = '00:00:00'] = text.replace(TIMESTAMP_SEPARATOR_RE, '$1T').split('T')
  const zoned = ignoreZone ? time.replace(TIME_ZONE_RE, '') : time.replace(SHORT_OFFSET_RE, '$1:00')

  return Date.parse(`${date}T${TIME_ZONE_RE.test(zoned) ? zoned : `${zoned}Z`}`)
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

/** `fill` is a default the column is added with, filling the rows already there, which the caller drops right after. */
export function buildAddColumnSql(tableName: string, colName: string, colDef: AnyColumnDef, fill?: string): string {
  return `ALTER TABLE "${tableName}" ADD COLUMN ${generateColumnDDL(colName, colDef, tableName)}${fill === undefined ? '' : ` DEFAULT ${fill}`}`
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

export function buildSetExpressionSql(tableName: string, colName: string, expr: string): string {
  return `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" SET EXPRESSION AS (${expr})`
}

export function buildDropExpressionSql(tableName: string, colName: string): string {
  return `ALTER TABLE "${tableName}" ALTER COLUMN "${colName}" DROP EXPRESSION`
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

export function buildAddPrimaryKeySql(tableName: string, columns: string[]): string {
  return `ALTER TABLE "${tableName}" ADD CONSTRAINT "${tableName}_pkey" PRIMARY KEY (${columns.map(c => `"${c}"`).join(', ')})`
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
