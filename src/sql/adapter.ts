import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import { AbortError, OrmError, wrapPgError } from '../errors/index'
import { BACKSLASH_RE, DOUBLE_QUOTE_RE } from '../utils/regex'
import { isCancellation, querySignalStorage, throwIfAborted } from './abort'
import { bigintAsString, byteaHex, isJsonParam } from './json-param'

/** A statement bun:sql has queued or sent; Postgres ones can be cancelled, SQLite ones run synchronously and cannot. */
export type DriverQuery = Promise<unknown[]> & { cancel?: () => void }

/**
 * Typed surface for the bits of bun:sql we use. bun:sql's own types don't expose
 * `unsafe`/`begin`/`savepoint`/`close` on the SQL instance, so without this wrapper
 * every call site needs `as unknown as { ... }`. Centralizing the cast here makes
 * every caller fully typed.
 */
export interface BunSqlDriver {
  unsafe: (sqlStr: string, params: unknown[]) => DriverQuery
  begin: <T>(fn: (tx: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  savepoint: <T>(fn: (sp: InstanceType<typeof SQL>) => Promise<T>) => Promise<T>
  close: (opts?: { timeout?: number }) => Promise<void>
  /** One pooled connection held until `release()`, for session state such as a search_path or an advisory lock. */
  reserve: () => Promise<{ unsafe: (sqlStr: string, params: unknown[]) => Promise<unknown[]>, release: () => void }>
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

    if (item instanceof Uint8Array)
      return quoteElement(byteaHex(item))

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

// A numeric array column (int4[], float4[]) bun:sql returns as a typed array; a bytea comes back as a Buffer, which stays one.
function isNumericArray(val: unknown): val is ArrayLike<unknown> {
  return ArrayBuffer.isView(val) && !(val instanceof Uint8Array) && !(val instanceof DataView)
}

/**
 * Turn the typed arrays bun:sql returns for numeric array columns into plain arrays, so callers always get an Array.
 * Every row shares its columns and each column its type, so the first non-null value of a column says whether it needs a pass: most results need none.
 */
export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const first = rows[0]

  if (!first)
    return rows

  for (const key in first) {
    const sample = rows.find(row => row[key] != null)?.[key]

    if (!isNumericArray(sample))
      continue

    for (const row of rows) {
      const val = row[key]

      if (isNumericArray(val))
        row[key] = Array.from(val)
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
  const signal = querySignalStorage.getStore()

  try {
    throwIfAborted(signal, sqlStr, params)

    if (dialect === 'sqlite')
      return await asDriver(sql).unsafe(sqlStr, params) as Record<string, unknown>[]

    const query = asDriver(sql).unsafe(sqlStr, serializeParams(params))
    const rows = await (signal ? untilAborted(query, signal) : query) as Record<string, unknown>[]

    return normalizeRows(rows)
  }
  catch (err) {
    if (signal?.aborted && isCancellation(err))
      throw new AbortError(sqlStr, params, signal.reason)

    throw err instanceof OrmError ? err : wrapPgError(err, sqlStr, params)
  }
}

async function untilAborted(query: DriverQuery, signal: AbortSignal): Promise<unknown[]> {
  // A listener returning the query, as `cancel()` does, makes Bun report its rejection as uncaught even though it is awaited below.
  const cancel = (): void => {
    query.cancel?.()
  }

  signal.addEventListener('abort', cancel, { once: true })

  try {
    return await query
  }
  finally {
    signal.removeEventListener('abort', cancel)
  }
}
