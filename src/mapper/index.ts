import type { AnyColumns } from '../types/index'

/**
 * JIT row mapper: pre-compile row-to-object mappers via `new Function()` at startup.
 * Each schema gets exactly one compiled mapper function. No per-row overhead.
 *
 * **Security model:** Column names are validated at `defineTable()` time against
 * `/^[a-zA-Z_][a-zA-Z0-9_]*$/` — only safe identifiers pass. They are additionally
 * escaped via `JSON.stringify()` when embedded into the Function source. User input
 * (query params, row values) never enters the Function source — only schema-defined
 * column names do. The compiled function only reads properties from the row object;
 * it does not execute arbitrary code.
 */

export type RowMapper<T> = (row: Record<string, unknown>) => T

// Compile a mapper for a specific set of columns (cached per shape fingerprint)
const MAPPER_CACHE_MAX = 1000
const _mapperCache = new Map<string, RowMapper<Record<string, unknown>>>()

// Build a JIT-compiled mapper for a set of columns.
// bun:sql returns rows as objects (column_name -> value), so the mapper
// remaps/validates the shape. For the simple case (no omit, no computed),
// identity is fastest.
// bun:sql returns int8/bigint columns as JS strings (since int64 exceeds Number.MAX_SAFE_INTEGER).
// Schemas declare these as bigint, so the mapper coerces in the JIT body.
function needsBigintCoercion(pgType: string): boolean {
  return pgType === 'int8' || pgType === 'bigserial'
}

function bigintAccessor(col: string): string {
  const key = JSON.stringify(col)

  return `(r[${key}] == null ? r[${key}] : typeof r[${key}] === 'bigint' ? r[${key}] : BigInt(r[${key}]))`
}

function needsJsonParse(pgType: string): boolean {
  return pgType === 'json' || pgType === 'jsonb'
}

function jsonAccessor(col: string): string {
  const key = JSON.stringify(col)

  return `(r[${key}] == null ? r[${key}] : typeof r[${key}] === 'string' ? JSON.parse(r[${key}]) : r[${key}])`
}

export function compileMapper<TColumns extends AnyColumns>(
  columns: TColumns,
  pick?: string[],
  omit?: string[],
): RowMapper<Record<string, unknown>> {
  const colNames = pick ?? Object.keys(columns)
  const filteredCols = omit ? colNames.filter(c => !omit.includes(c)) : colNames
  const allKeys = Object.keys(columns)
  const bigintCols = new Set(
    allKeys.filter(c => needsBigintCoercion(columns[c]!.pgType)),
  )
  const jsonCols = new Set(
    allKeys.filter(c => needsJsonParse(columns[c]!.pgType)),
  )

  // Fast path: full identity only when no coercion is needed.
  if (!pick && !omit && filteredCols.length === allKeys.length && bigintCols.size === 0 && jsonCols.size === 0) {
    return identityMapper
  }

  // JIT: compile a function that picks the needed fields, coercing int8/bigint
  // and json/jsonb columns. Column names are validated against
  // /^[a-zA-Z_][a-zA-Z0-9_]*$/ at defineTable() time, so they are safe to embed.
  // JSON.stringify adds an additional escaping layer.
  const assignments = filteredCols
    .map((c) => {
      const value = bigintCols.has(c)
        ? bigintAccessor(c)
        : jsonCols.has(c)
          ? jsonAccessor(c)
          : `r[${JSON.stringify(c)}]`

      return `  ${JSON.stringify(c)}: ${value}`
    })
    .join(',\n')
  const body = `return {\n${assignments}\n}`

  // JIT mapper: column names are validated at defineTable() time (not user input).
  // Compiled once per unique column shape, cached, and reused across all queries.
  // eslint-disable-next-line no-new-func -- JIT row mapper: source is built from schema-validated column names, not user input
  return new Function('r', body) as RowMapper<Record<string, unknown>>
}

function identityMapper(row: Record<string, unknown>): Record<string, unknown> {
  return row
}

// Apply mapper to an entire chunk at once (per-chunk, not per-row on stream path)
export function mapChunk(
  mapper: RowMapper<Record<string, unknown>>,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  // Fast path: skip allocation when identity mapper
  if (mapper === identityMapper)
    return rows

  const len = rows.length
  const out = new Array<Record<string, unknown>>(len)

  for (let i = 0; i < len; i++) {
    out[i] = mapper(rows[i]!)
  }

  return out
}

export function getOrCompileMapper<TColumns extends AnyColumns>(
  tableName: string,
  columns: TColumns,
  pick?: string[],
  omit?: string[],
): RowMapper<Record<string, unknown>> {
  const key = `${tableName}:${pick ? [...pick].sort().join(',') : '*'}:${omit ? [...omit].sort().join(',') : ''}`
  const cached = _mapperCache.get(key)

  if (cached !== undefined) {
    // LRU hit: promote to most-recently-used by re-inserting at the tail.
    _mapperCache.delete(key)
    _mapperCache.set(key, cached)

    return cached
  }

  const mapper = compileMapper(columns, pick, omit)

  _mapperCache.set(key, mapper)

  // Single-entry LRU eviction: drop the least-recently-used (head of insertion order).
  if (_mapperCache.size > MAPPER_CACHE_MAX) {
    const lruKey = _mapperCache.keys().next().value

    if (lruKey !== undefined)
      _mapperCache.delete(lruKey)
  }

  return mapper
}

export function clearMapperCache(): void {
  _mapperCache.clear()
}
