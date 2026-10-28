import type { AnyColumnDef, AnyTableDef, ForeignKeyRef, IndexDef, UniqueDef } from '../types/index'
import { typeSql } from '../schema/column-default'
import { getColumnMeta } from '../schema/column-meta'
import { escapeLiteralBody, quote } from '../sql/utils'
import { columnChecks } from './checks'
import { collectConstraints } from './constraint-collector'
import { ARRAY_SUFFIX_RE, DEFAULT_CAST_RE, DEFAULT_LITERAL_RE, LONE_LITERAL_RE, PLAIN_NUMBER_RE, PREDICATE_CAST_RE, PREDICATE_NOISE_RE, QUOTED_NUMBER_RE, SHORT_OFFSET_RE, TIME_ZONE_RE, TIMESTAMP_SEPARATOR_RE, TYPE_MODIFIER_RE, TYPE_PARTS_RE, TYPE_QUALIFIER_RE, WHITESPACE_RE } from './regex'

// Postgres truncates a longer identifier, which then never reads back as the name it was created under.
const MAX_IDENTIFIER_BYTES = 63

export function generateCreateTable(name: string, table: AnyTableDef): string {
  const { colDefs, pkCols, uniqueCols } = collectConstraints(table, (col, def) => generateColumnDDL(col, def, name))
  const constraints: string[] = []

  if (pkCols.length)
    constraints.push(`  PRIMARY KEY (${pkCols.join(', ')})`)

  for (const col of uniqueCols)
    constraints.push(`  UNIQUE (${quote(col)})`)

  for (const unique of table.uniques ?? [])
    constraints.push(`  CONSTRAINT ${quote(uniqueName(name, unique))} UNIQUE (${unique.columns.map(quote).join(', ')})`)

  // FK constraints are emitted as separate `add_fk` ops after all CREATE TABLEs,
  // so cross-table FK ordering is not constrained by declaration order.

  const all = [...colDefs, ...constraints].join(',\n')

  return `CREATE TABLE ${quote(name)} (\n${all}\n)`
}

/** A column's DDL. Given the table name, its CHECKs are named as `sync()` diffs them; without it they are left for PG to name. */
/** A column's type as DDL, an enum's name quoted. */
export function columnTypeSql(colDef: AnyColumnDef): string {
  return typeSql(colDef.pgType, getColumnMeta(colDef).enumName)
}

export function generateColumnDDL(name: string, colDef: AnyColumnDef, tableName?: string): string {
  const parts: string[] = [quote(name), columnTypeSql(colDef)]

  for (const c of colDef.constraints) {
    switch (c.type) {
      case 'not_null': parts.push('NOT NULL')

        break
      case 'default': parts.push(`DEFAULT ${c.value}`)

        break
      case 'generated': parts.push(`GENERATED ALWAYS AS (${c.value}) STORED`)

        break
      case 'identity': parts.push(identitySql(c.value))

        break
      // check, primary_key, unique, references handled below or at table level
    }
  }

  for (const check of columnChecks(tableName ?? '', name, colDef))
    parts.push(tableName ? `CONSTRAINT ${quote(check.name)} CHECK (${check.expr})` : `CHECK (${check.expr})`)

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

  // A time type's precision goes inside its name, as format_type() prints it: `timestamp(3) with time zone`.
  const zoneAt = name.indexOf(' with')

  if (modifier !== undefined && zoneAt > 0)
    return `${name.slice(0, zoneAt)}(${modifier})${name.slice(zoneAt)}${brackets ? '[]' : ''}`

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

// Types Postgres casts between on assignment, which ALTER COLUMN ... TYPE uses without a USING clause and which, unlike an explicit cast, refuses a string too long instead of cutting it.
const TYPE_FAMILIES: Record<string, string> = {
  'text': 'string',
  'character varying': 'string',
  'character': 'string',
  'smallint': 'number',
  'integer': 'number',
  'bigint': 'number',
  'numeric': 'number',
  'real': 'number',
  'double precision': 'number',
  'date': 'time',
  'timestamp without time zone': 'time',
  'timestamp with time zone': 'time',
}

/**
 * The USING clause changing a column from `liveType` to `desiredType` (both normalized) needs: none within a family Postgres casts on assignment, an explicit cast otherwise (text to integer, uuid, boolean or an enum).
 * A json array becomes a Postgres one through its text, brackets turned into braces, as json has no cast to an array.
 */
export function usingClause(colName: string, liveType: string, desiredType: string, pgType: string): string {
  const live = liveType.replace(TYPE_MODIFIER_RE, '')
  const desired = desiredType.replace(TYPE_MODIFIER_RE, '')
  const family = TYPE_FAMILIES[live.replace(ARRAY_SUFFIX_RE, '')]

  if (live === desired || (family !== undefined && live.endsWith('[]') === desired.endsWith('[]') && family === TYPE_FAMILIES[desired.replace(ARRAY_SUFFIX_RE, '')]))
    return ''

  if ((live === 'json' || live === 'jsonb') && desired.endsWith('[]'))
    return ` USING translate(${quote(colName)}::text, '[]', '{}')::${pgType}`

  return ` USING ${quote(colName)}::${pgType}`
}

// --- Table lifecycle ---

export function buildDropTableSql(name: string): string {
  return `DROP TABLE ${quote(name)}`
}

// --- Column lifecycle ---

/** `fill` is a default the column is added with, filling the rows already there, which the caller drops right after. */
export function buildAddColumnSql(tableName: string, colName: string, colDef: AnyColumnDef, fill?: string): string {
  return `ALTER TABLE ${quote(tableName)} ADD COLUMN ${generateColumnDDL(colName, colDef, tableName)}${fill === undefined ? '' : ` DEFAULT ${fill}`}`
}

export function buildDropColumnSql(tableName: string, colName: string): string {
  return `ALTER TABLE ${quote(tableName)} DROP COLUMN ${quote(colName)}`
}

export function buildRenameColumnSql(tableName: string, oldName: string, newName: string): string {
  return `ALTER TABLE ${quote(tableName)} RENAME COLUMN ${quote(oldName)} TO ${quote(newName)}`
}

export function buildAlterColumnTypeSql(
  tableName: string,
  colName: string,
  pgType: string,
  usingClause?: string,
): string {
  return `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(colName)} TYPE ${pgType}${usingClause ?? ''}`
}

export function buildSetExpressionSql(tableName: string, colName: string, expr: string): string {
  return `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(colName)} SET EXPRESSION AS (${expr})`
}

export function buildDropExpressionSql(tableName: string, colName: string): string {
  return `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(colName)} DROP EXPRESSION`
}

export function buildSetNotNullSql(tableName: string, colName: string): string {
  return `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(colName)} SET NOT NULL`
}

export function buildDropNotNullSql(tableName: string, colName: string): string {
  return `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(colName)} DROP NOT NULL`
}

export function buildSetDefaultSql(tableName: string, colName: string, value: string): string {
  return `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(colName)} SET DEFAULT ${value}`
}

export function buildDropDefaultSql(tableName: string, colName: string): string {
  return `ALTER TABLE ${quote(tableName)} ALTER COLUMN ${quote(colName)} DROP DEFAULT`
}

// --- Constraint lifecycle ---

/** `<base><suffix>` cut to Postgres' 63-byte limit, a hash of the full name kept so two long names stay apart and the name reads back as it was created. */
export function fitIdentifier(base: string, suffix: string): string {
  const full = `${base}${suffix}`

  // Identifiers are ASCII, validated at definition time, so a character is a byte.
  if (full.length <= MAX_IDENTIFIER_BYTES)
    return full

  const hash = new Bun.CryptoHasher('sha256').update(full).digest('hex').slice(0, 8)

  return `${base.slice(0, MAX_IDENTIFIER_BYTES - suffix.length - hash.length - 1)}_${hash}${suffix}`
}

export function uniqueConstraintName(tableName: string, colName: string): string {
  return fitIdentifier(`${tableName}_${colName}`, '_key')
}

export function primaryKeyName(tableName: string): string {
  return fitIdentifier(tableName, '_pkey')
}

export function fkConstraintName(tableName: string, colName: string): string {
  return fitIdentifier(`${tableName}_${colName}`, '_fkey')
}

/** The name of a UNIQUE over several columns: its own, or `<table>_<columns>_key` as Postgres would name it. */
export function uniqueName(tableName: string, unique: UniqueDef): string {
  return unique.name ?? fitIdentifier(`${tableName}_${unique.columns.join('_')}`, '_key')
}

export function buildAddUniqueSql(tableName: string, unique: UniqueDef): string {
  return `ALTER TABLE ${quote(tableName)} ADD CONSTRAINT ${quote(uniqueName(tableName, unique))} UNIQUE (${unique.columns.map(quote).join(', ')})`
}

export function identitySql(kind: string | undefined): string {
  return `GENERATED ${kind === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`
}

/** `COMMENT ON` a table, or one of its columns, to `text`, or none when null. */
export function buildCommentSql(tableName: string, colName: string | undefined, text: string | null): string {
  const target = colName === undefined ? `TABLE ${quote(tableName)}` : `COLUMN ${quote(tableName)}.${quote(colName)}`

  return `COMMENT ON ${target} IS ${text === null ? 'NULL' : `'${escapeLiteralBody(text)}'`}`
}

export function buildRenameTableSql(oldName: string, newName: string): string {
  return `ALTER TABLE ${quote(oldName)} RENAME TO ${quote(newName)}`
}

export function buildAddUniqueConstraintSql(tableName: string, colName: string): string {
  return `ALTER TABLE ${quote(tableName)} ADD CONSTRAINT ${quote(uniqueConstraintName(tableName, colName))} UNIQUE (${quote(colName)})`
}

export function buildAddPrimaryKeySql(tableName: string, columns: string[]): string {
  return `ALTER TABLE ${quote(tableName)} ADD CONSTRAINT ${quote(primaryKeyName(tableName))} PRIMARY KEY (${columns.map(quote).join(', ')})`
}

export function buildAddCheckSql(tableName: string, name: string, expr: string): string {
  return `ALTER TABLE ${quote(tableName)} ADD CONSTRAINT ${quote(name)} CHECK (${expr})`
}

export function buildDropConstraintSql(tableName: string, constraintName: string): string {
  return `ALTER TABLE ${quote(tableName)} DROP CONSTRAINT IF EXISTS ${quote(constraintName)}`
}

// --- Foreign-key lifecycle ---

export function buildAddFkSql(tableName: string, colName: string, ref: ForeignKeyRef): string {
  const targetTable = ref.table()
  let sql = `ALTER TABLE ${quote(tableName)} ADD CONSTRAINT ${quote(fkConstraintName(tableName, colName))} FOREIGN KEY (${quote(colName)}) REFERENCES ${quote(targetTable.name)} (${quote(ref.column)})`

  if (ref.onDelete)
    sql += ` ON DELETE ${ref.onDelete.toUpperCase()}`

  if (ref.onUpdate)
    sql += ` ON UPDATE ${ref.onUpdate.toUpperCase()}`

  if (ref.deferrable)
    sql += ` DEFERRABLE INITIALLY ${ref.deferrable === 'deferred' ? 'DEFERRED' : 'IMMEDIATE'}`

  return sql
}

export function buildDropFkSql(tableName: string, constraintName: string): string {
  return `ALTER TABLE ${quote(tableName)} DROP CONSTRAINT ${quote(constraintName)}`
}

// --- Index lifecycle ---

export function buildIndexName(tableName: string, columns: string[], unique: boolean): string {
  return fitIdentifier(`${tableName}_${columns.join('_')}`, unique ? '_unique' : '_idx')
}

// `concurrently` builds it alongside writes, outside any transaction, skipping a name a racing migration already built.
export function buildCreateIndexSql(tableName: string, idx: IndexDef, concurrently = false): string {
  const name = idx.name ?? buildIndexName(tableName, idx.columns, idx.unique ?? false)
  const method = idx.method ?? 'btree'
  const unique = idx.unique ? 'UNIQUE ' : ''
  const keys = [
    ...idx.columns.map(c => `${quote(c)}${idx.opclass?.[c] ? ` ${idx.opclass[c]}` : ''}${idx.desc?.includes(c) ? ' DESC' : ''}`),
    ...(idx.expressions ?? []).map(e => `(${e})`),
  ].join(', ')
  let sql = `CREATE ${unique}INDEX ${concurrently ? 'CONCURRENTLY IF NOT EXISTS ' : ''}${quote(name)} ON ${quote(tableName)} USING ${method} (${keys})`

  if (idx.include?.length)
    sql += ` INCLUDE (${idx.include.map(quote).join(', ')})`

  if (idx.where)
    sql += ` WHERE ${idx.where}`

  return sql
}

export function buildDropIndexSql(name: string, concurrently = false): string {
  return `DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}IF EXISTS ${quote(name)}`
}

// --- Enum lifecycle ---

export function buildCreateEnumSql(name: string, values: string[]): string {
  const escaped = values.map(v => `'${escapeEnumValue(v)}'`).join(', ')

  return `CREATE TYPE ${quote(name)} AS ENUM (${escaped})`
}

export function buildAlterEnumAddSql(name: string, value: string): string {
  return `ALTER TYPE ${quote(name)} ADD VALUE IF NOT EXISTS '${escapeEnumValue(value)}'`
}

/** A live column typed with an enum, or an array of it. */
export interface EnumUsage {
  table: string
  column: string
  array: boolean
  /** Whether it has a default, which cannot be cast to the new type and is dropped first. */
  hasDefault: boolean
  /** The default it gets back once the type is replaced: its definition's. */
  restoreDefault?: string
}

export function buildEnumReplacementSqls(enumName: string, values: string[], usages: EnumUsage[]): string[] {
  const escapedValues = values.map(v => `'${escapeEnumValue(v)}'`).join(', ')
  const tmpName = fitIdentifier(enumName, '_new')
  const sqls: string[] = [
    `CREATE TYPE ${quote(tmpName)} AS ENUM (${escapedValues})`,
  ]

  for (const usage of usages) {
    const brackets = usage.array ? '[]' : ''

    if (usage.hasDefault)
      sqls.push(buildDropDefaultSql(usage.table, usage.column))

    sqls.push(`ALTER TABLE ${quote(usage.table)} ALTER COLUMN ${quote(usage.column)} TYPE ${quote(tmpName)}${brackets} USING ${quote(usage.column)}::text${brackets}::${quote(tmpName)}${brackets}`)
  }

  sqls.push(`DROP TYPE ${quote(enumName)}`)
  sqls.push(`ALTER TYPE ${quote(tmpName)} RENAME TO ${quote(enumName)}`)

  for (const usage of usages) {
    if (usage.restoreDefault !== undefined)
      sqls.push(buildSetDefaultSql(usage.table, usage.column, usage.restoreDefault))
  }

  return sqls
}

function escapeEnumValue(val: string): string {
  return escapeLiteralBody(val)
}
