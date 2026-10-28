import type { AnyColumnDef } from '../types/index'
import { ValidationError } from '../errors/index'
import { escapeLiteralBody, quoteLiteral } from '../sql/utils'
import { getColumnMeta } from './column-meta'

// The current time as the ISO string a Date binds as on SQLite, so a default and a written value compare alike.
const SQLITE_NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
// A version 4 UUID: random hex, its version nibble 4, its variant nibble one of 8, 9, a or b.
const SQLITE_UUID = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))))`

// Postgres functions a `defaultRaw()` commonly names, by their spelling lowercased and unspaced.
const SQLITE_FUNCTIONS = new Map<string, string>([
  ['now()', SQLITE_NOW],
  ['current_timestamp', SQLITE_NOW],
  ['localtimestamp', SQLITE_NOW],
  ['transaction_timestamp()', SQLITE_NOW],
  ['statement_timestamp()', SQLITE_NOW],
  ['clock_timestamp()', SQLITE_NOW],
  ['current_date', `(date('now'))`],
  ['gen_random_uuid()', SQLITE_UUID],
  ['uuid_generate_v4()', SQLITE_UUID],
])

const TRAILING_CAST_RE = /::[\w ]+(?:\(\d+(?:,\s*\d+)?\))?(?:\[\])*$/
const SPACES_RE = /\s+/g
// A literal SQLite takes as a column default without parentheses: a number, a string, NULL, TRUE or FALSE.
const SQLITE_LITERAL_RE = /^(?:[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?|'(?:[^']|'')*'|null|true|false)$/i

/** Convert a JS value to a SQL DEFAULT expression based on the column's pgType. */
export function toSQLDefault(value: unknown, pgType: string): string {
  if (value === null || value === undefined)
    return 'NULL'

  if (typeof value === 'number')
    return finiteNumber(value)

  if (typeof value === 'bigint')
    return String(value)

  if (typeof value === 'boolean')
    return value ? 'true' : 'false'

  if (value instanceof Date)
    return `'${value.toISOString()}'`

  if (Array.isArray(value)) {
    if (value.length === 0)
      return `ARRAY[]::${pgType}`

    return `ARRAY[${value.map(arrayItem).join(',')}]::${pgType}`
  }

  if (typeof value === 'object')
    return `'${escapeLiteralBody(JSON.stringify(value))}'::${pgType}`

  if (typeof value === 'string')
    return quoteLiteral(value)

  return String(value)
}

// A number printed into DDL: NaN and the infinities have no literal there, and a value typed past `number` must not reach the SQL.
function finiteNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ValidationError(`Invalid default: ${String(value)} is not a finite number.`, 'default', { value })

  return String(value)
}

// One item of an array default: a string, a finite number, a bigint, a boolean or null.
function arrayItem(item: unknown): string {
  if (item === null)
    return 'NULL'

  if (typeof item === 'string')
    return quoteLiteral(item)

  if (typeof item === 'bigint')
    return String(item)

  if (typeof item === 'boolean')
    return item ? 'true' : 'false'

  return finiteNumber(item)
}

// A JS default value as SQLite SQL: a boolean is TRUE or FALSE, a Date its ISO string and an array or an object its JSON text, the way each binds.
function sqliteLiteral(value: unknown): string {
  if (value === null || value === undefined)
    return 'NULL'

  if (typeof value === 'number')
    return finiteNumber(value)

  if (typeof value === 'bigint')
    return String(value)

  if (typeof value === 'boolean')
    return value ? 'TRUE' : 'FALSE'

  if (value instanceof Date)
    return quoteLiteral(value.toISOString())

  if (typeof value === 'string')
    return quoteLiteral(value)

  return quoteLiteral(JSON.stringify(value))
}

/**
 * A column's default as SQLite writes it, undefined without one. A `.default()` value is rendered for SQLite, a `defaultRaw()` naming a common Postgres function (`now()`, `gen_random_uuid()`) becomes its SQLite equivalent, a literal loses its cast, and any other expression is parenthesized as SQLite requires.
 */
export function sqliteDefaultSql(colDef: AnyColumnDef): string | undefined {
  const raw = colDef.constraints.find(c => c.type === 'default')?.value

  if (raw === undefined)
    return undefined

  const { defaultLiteral } = getColumnMeta(colDef)

  if (defaultLiteral)
    return sqliteLiteral(defaultLiteral.value)

  const known = SQLITE_FUNCTIONS.get(raw.toLowerCase().replace(SPACES_RE, '').replace(TRAILING_CAST_RE, ''))

  if (known)
    return known

  const bare = raw.trim().replace(TRAILING_CAST_RE, '')

  return SQLITE_LITERAL_RE.test(bare) ? bare : `(${raw})`
}

/** The SQLite value a `.backfill()` gives the rows a NOT NULL column without a default is added to, undefined when it needs none. */
export function sqliteBackfillSql(colDef: AnyColumnDef): string | undefined {
  const { backfill } = getColumnMeta(colDef)
  const needsFill = colDef.constraints.some(c => c.type === 'not_null') && !colDef.constraints.some(c => c.type === 'default' || c.type === 'generated')

  return backfill && needsFill ? sqliteLiteral(backfill.value) : undefined
}

/** Whether SQLite can add a column with this default in place: `ALTER TABLE ... ADD COLUMN` refuses an expression, which only a table rebuild can bring. */
export function isConstantSqliteDefault(sql: string): boolean {
  return !sql.startsWith('(')
}

/** The SQL a SQLite multi-row insert writes for each column a row leaves out: its default, else NULL, which an INTEGER PRIMARY KEY numbers like a serial. */
export function sqliteInsertDefaults(columns: Record<string, AnyColumnDef>): Record<string, string> {
  const defaults: Record<string, string> = {}

  for (const [name, colDef] of Object.entries(columns))
    defaults[name] = sqliteDefaultSql(colDef) ?? 'NULL'

  return defaults
}
