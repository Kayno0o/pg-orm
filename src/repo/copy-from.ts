import type { AnyTableDef, ColumnConstraint } from '../types/index'
import { columnValue } from '../builder/state'
import { ValidationError } from '../errors/index'
import { columnOf } from '../schema/inspect'
import { copyField } from '../sql/copy'

// The size a COPY's rows are batched to before each write to the stream.
const COPY_CHUNK_CHARS = 64 * 1024

async function* prepend<T>(first: T, rest: Iterator<T> | AsyncIterator<T>): AsyncGenerator<T> {
  try {
    yield first

    for (let next = await rest.next(); !next.done; next = await rest.next())
      yield next.value
  }
  finally {
    await rest.return?.()
  }
}

// A COPY's column list is fixed by its first row, so every later one must set exactly those columns.
function assertCopyRow(row: Record<string, unknown>, columns: string[], expected: ReadonlySet<string>): void {
  let set = 0

  for (const key in row) {
    if (row[key] === undefined)
      continue

    if (!expected.has(key))
      throw new ValidationError(`copyFrom rows must all set the columns the first one sets (${columns.join(', ')}): one also sets "${key}"`, 'copyFrom', { field: key })

    set++
  }

  if (set !== columns.length)
    throw new ValidationError(`copyFrom rows must all set the columns the first one sets (${columns.join(', ')}): one leaves ${columns.filter(c => row[c] === undefined).join(', ')} unset`, 'copyFrom')
}

/** The columns a COPY writes: the ones the first row sets, none of them generated. */
export function copyColumns(table: AnyTableDef, row: Record<string, unknown>): string[] {
  const columns = Object.keys(row).filter(key => row[key] !== undefined)

  if (columns.length === 0)
    throw new ValidationError(`copyFrom on "${table.name}" got a row setting no column`, 'copyFrom')

  for (const name of columns) {
    const col = columnOf(table, name, 'copyFrom')

    if (col.constraints.some((c: ColumnConstraint) => c.type === 'generated'))
      throw new ValidationError(`"${table.name}"."${name}" is a generated column, which COPY cannot write`, 'copyFrom', { field: name })
  }

  return columns
}

/** The rows as COPY text, batched into chunks of about `COPY_CHUNK_CHARS`. */
export async function* copyChunks(table: AnyTableDef, first: Record<string, unknown>, rest: Iterator<unknown> | AsyncIterator<unknown>, columns: string[]): AsyncGenerator<string> {
  const types = columns.map(name => table.columns[name]!.pgType)
  const json = types.map(type => type === 'json' || type === 'jsonb')
  const expected = new Set(columns)
  let buffer = ''

  for await (const value of prepend(first, rest)) {
    const row = value as Record<string, unknown>

    assertCopyRow(row, columns, expected)
    // copyField writes a json value's text itself; any other goes through the encoding an INSERT gives it (a vector's `[1,2]`).
    buffer += `${columns.map((name, i) => copyField(json[i] ? row[name] : columnValue(types[i], row[name]), json[i]!)).join('\t')}\n`

    if (buffer.length >= COPY_CHUNK_CHARS) {
      yield buffer
      buffer = ''
    }
  }

  if (buffer)
    yield buffer
}
