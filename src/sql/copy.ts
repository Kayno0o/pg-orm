import { PLACEHOLDER_RE, replaceOutsideQuotes } from '../builder/_placeholders'
import { ValidationError } from '../errors/index'
import { BACKSLASH_RE, SINGLE_QUOTE_RE } from '../utils/regex'
import { serializePgArray } from './adapter'
import { bigintAsString, byteaHex, isJsonParam } from './json-param'

// COPY's text format ends a field at a tab and a row at a newline, and reads a backslash as an escape.
const COPY_SPECIAL_RE = /[\\\n\r\t]/g
const COPY_ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

function escapeCopy(text: string): string {
  return text.replace(COPY_SPECIAL_RE, ch => COPY_ESCAPES[ch]!)
}

// A value's text form, as Postgres reads it for the column type: an array literal for an array, `\x` hex for bytes, JSON for an object.
function valueText(value: unknown): string {
  if (Array.isArray(value))
    return serializePgArray(value)

  if (value instanceof Uint8Array)
    return byteaHex(value)

  if (value instanceof Date)
    return value.toISOString()

  if (typeof value === 'boolean')
    return value ? 't' : 'f'

  // Any other object bun:sql would encode to JSON, as it does for a json/jsonb value a WHERE compares.
  return typeof value === 'object' && value !== null ? JSON.stringify(value, bigintAsString) : String(value)
}

/** One value as a field of `COPY ... FROM STDIN` in text format, written as an INSERT would bind it: JSON text for a json column, an array literal for an array. */
export function copyField(value: unknown, json: boolean): string {
  if (value === null || value === undefined)
    return '\\N'

  return escapeCopy(json ? JSON.stringify(value, bigintAsString) : valueText(value))
}

/**
 * A bind parameter as a SQL literal, for `COPY (SELECT ...) TO STDOUT`, which Postgres runs without bind parameters.
 * An `E''` string escapes the same whatever `standard_conforming_strings` says, and stays untyped, so it takes the type its place asks for as a parameter does.
 */
function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined)
    return 'NULL'

  const text = isJsonParam(value) ? JSON.stringify(value.value, bigintAsString) : valueText(value)

  if (text.includes('\0'))
    throw new ValidationError('A value holding a NUL character cannot be sent to Postgres', 'copyTo')

  return `E'${text.replace(BACKSLASH_RE, '\\\\').replace(SINGLE_QUOTE_RE, '\'\'')}'`
}

/** `sql` with each `$n` placeholder replaced by its parameter as a literal, a `$n` inside a quoted literal or identifier (a raw fragment's) left as text. */
export function inlineParams(sql: string, params: unknown[]): string {
  return replaceOutsideQuotes(sql, PLACEHOLDER_RE, (_match, n) => sqlLiteral(params[Number(n) - 1]))
}
