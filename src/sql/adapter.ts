import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import { OrmError, wrapPgError } from '../errors/index'
import { BACKSLASH_RE, DOUBLE_QUOTE_RE } from '../utils/regex'
import { bigintAsString, isJsonParam } from './json-param'

/**
 * Typed surface for the bits of bun:sql we use. bun:sql's own types don't expose
 * `unsafe`/`begin`/`savepoint`/`close` on the SQL instance, so without this wrapper
 * every call site needs `as unknown as { ... }`. Centralizing the cast here makes
 * every caller fully typed.
 */
export interface BunSqlDriver {
  unsafe: (sqlStr: string, params: unknown[]) => Promise<unknown[]>
  begin: <T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  savepoint: <T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  close: (opts?: { timeout?: number }) => Promise<void>
}

export function asDriver(sql: InstanceType<typeof SQL>): BunSqlDriver {
  return sql as unknown as BunSqlDriver
}

/**
 * Serialize a JS array to a PostgreSQL array literal string, e.g.:
 *   ['a', 'b'] → '{"a","b"}'
 *   [1, 2, 3]  → '{1,2,3}'
 *
 * bun:sql's unsafe() does not natively serialize JS arrays to PG array literals —
 * it joins them with commas, producing malformed input like "a,b,c" instead of {"a","b","c"}.
 */
export function serializePgArray(val: unknown[]): string {
  const items = val.map((item) => {
    if (item === null || item === undefined)
      return 'NULL'

    if (Array.isArray(item))
      return serializePgArray(item)

    if (typeof item === 'string')
      return quoteElement(item)

    if (typeof item === 'boolean')
      return item ? 'true' : 'false'

    // A Date goes in as its ISO string and an object, a json or jsonb element, as its JSON text: String() would give neither.
    if (item instanceof Date)
      return quoteElement(item.toISOString())

    if (typeof item === 'object')
      return quoteElement(JSON.stringify(item, bigintAsString))

    return String(item)
  })

  return `{${items.join(',')}}`
}

function quoteElement(text: string): string {
  return `"${text.replace(BACKSLASH_RE, '\\\\').replace(DOUBLE_QUOTE_RE, '\\"')}"`
}

export function serializeParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    // A json/jsonb value goes to the driver as it is: bun encodes objects, arrays and strings to JSON itself, and anything done to it here would be encoded a second time.
    // A bare boolean or number bun binds with its own type, which a json column refuses, so one goes in as an object encoding to it.
    if (isJsonParam(p))
      return typeof p.value === 'boolean' || typeof p.value === 'number' ? { toJSON: () => p.value } : p.value

    return Array.isArray(p) ? serializePgArray(p) : p
  })
}

/**
 * bun:sql returns TypedArrays (Int32Array, Float64Array, etc.) for numeric array columns.
 * Normalize them to plain JS arrays so callers always get Array, never TypedArray.
 */
export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const val = row[key]

      if (ArrayBuffer.isView(val) && !(val instanceof DataView))
        row[key] = Array.from(val as unknown as ArrayLike<unknown>)
    }
  }

  return rows
}

// The SQLite driver binds the values itself and never returns typed arrays but for a blob, which stays one.
export async function unsafeQuery(
  sql: InstanceType<typeof SQL>,
  sqlStr: string,
  params: unknown[],
  dialect: Dialect = 'postgres',
): Promise<Record<string, unknown>[]> {
  try {
    if (dialect === 'sqlite')
      return await asDriver(sql).unsafe(sqlStr, params) as Record<string, unknown>[]

    const rows = await asDriver(sql).unsafe(sqlStr, serializeParams(params)) as Record<string, unknown>[]

    return normalizeRows(rows)
  }
  catch (err) {
    throw err instanceof OrmError ? err : wrapPgError(err, sqlStr, params)
  }
}
