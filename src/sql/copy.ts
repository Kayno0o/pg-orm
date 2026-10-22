import { serializePgArray } from './adapter'
import { bigintAsString, byteaHex } from './json-param'

// COPY's text format ends a field at a tab and a row at a newline, and reads a backslash as an escape.
const COPY_SPECIAL_RE = /[\\\n\r\t]/g
const COPY_ESCAPES: Record<string, string> = { '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

function escapeCopy(text: string): string {
  return text.replace(COPY_SPECIAL_RE, ch => COPY_ESCAPES[ch]!)
}

/** One value as a field of `COPY ... FROM STDIN` in text format, written as an INSERT would bind it: JSON text for a json column, an array literal for an array. */
export function copyField(value: unknown, json: boolean): string {
  if (value === null || value === undefined)
    return '\\N'

  if (json)
    return escapeCopy(JSON.stringify(value, bigintAsString))

  if (Array.isArray(value))
    return escapeCopy(serializePgArray(value))

  if (value instanceof Uint8Array)
    return escapeCopy(byteaHex(value))

  if (value instanceof Date)
    return value.toISOString()

  if (typeof value === 'boolean')
    return value ? 't' : 'f'

  return escapeCopy(String(value))
}
