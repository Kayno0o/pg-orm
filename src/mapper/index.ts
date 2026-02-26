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
export function compileMapper<TColumns extends AnyColumns>(
  columns: TColumns,
  pick?: string[],
  omit?: string[],
): RowMapper<Record<string, unknown>> {
  const colNames = pick ?? Object.keys(columns)
  const filteredCols = omit ? colNames.filter(c => !omit.includes(c)) : colNames

  // Fast path: if all columns are selected and no omit, return identity
  const allKeys = Object.keys(columns)

  if (!pick && !omit && filteredCols.length === allKeys.length) {
    return identityMapper
  }

  // JIT: compile a function that picks exactly the needed fields.
  // This avoids per-row property enumeration in the hot path.
  // Column names are validated against /^[a-zA-Z_][a-zA-Z0-9_]*$/ at defineTable()
  // time, so they are safe to embed. JSON.stringify adds an additional escaping layer.
  const assignments = filteredCols
    .map(c => `  ${JSON.stringify(c)}: r[${JSON.stringify(c)}]`)
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
  let mapper = _mapperCache.get(key)

  if (!mapper) {
    mapper = compileMapper(columns, pick, omit)
    _mapperCache.set(key, mapper)

    // Bounded eviction: remove oldest 100 entries when cache exceeds max
    if (_mapperCache.size > MAPPER_CACHE_MAX) {
      let evicted = 0

      for (const k of _mapperCache.keys()) {
        if (evicted >= 100)
          break

        _mapperCache.delete(k)
        evicted++
      }
    }
  }

  return mapper
}

export function clearMapperCache(): void {
  _mapperCache.clear()
}
