import type { AnyTableDef } from '../types/index'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { OrmError } from '../errors/index'

type VirtualEntry = [string, { compute: (r: unknown) => unknown }]

/**
 * Per-repository virtual-entries cache. Replaces the previous module-level
 * WeakMap so each `Database` / `Repository` instance owns its own memoized
 * lookup — two databases sharing the same `AnyTableDef` no longer share
 * cache state, and an `invalidateCache()` call on one cannot disrupt
 * another's in-flight queries.
 *
 * The cache is keyed by `AnyTableDef` identity. Re-defining a table (via
 * `defineTable`) produces a new identity, so cache entries naturally tied
 * to the previous definition will be GC'd alongside it.
 */
export class VirtualEntriesCache {
  private _cache = new WeakMap<AnyTableDef, VirtualEntry[]>()

  entries(table: AnyTableDef): VirtualEntry[] {
    let entries = this._cache.get(table)

    if (!entries) {
      const virtuals = table.virtuals

      entries = virtuals ? Object.entries(virtuals) : []
      this._cache.set(table, entries)
    }

    return entries
  }

  clear(): void {
    this._cache = new WeakMap()
  }
}

/**
 * @deprecated The virtual-entries cache is now instance-scoped on each
 * `Repository`. This function is a no-op kept for one release for API
 * stability — use `db.invalidateCache()` or simply drop the call. Will be
 * removed in the next major.
 */
export function clearVirtualEntriesCache(): void {
  // No-op: nothing to clear at module scope anymore.
}

/**
 * Install virtual fields as lazy getters on each row. The first read computes
 * and replaces itself with the materialized value so subsequent reads are
 * plain property accesses. A throw inside `compute` is wrapped in OrmError
 * with the table, field name, and the row's primary-key value so bulk
 * failures (e.g., 1 bad row out of 10k in a findMany) are debuggable.
 *
 * The `cache` argument is the per-Repository memo. Passing it explicitly
 * means callers (suites) can never accidentally share state across
 * `Database` instances, which the old module-level cache silently did.
 */
export function applyVirtuals<T extends Record<string, unknown>>(
  table: AnyTableDef,
  rows: T[],
  cache: VirtualEntriesCache,
): T[] {
  const entries = cache.entries(table)

  if (entries.length === 0)
    return rows

  const tableName = table.name
  const pkColumn = table.primaryKey ?? DEFAULT_PRIMARY_KEY

  for (const row of rows) {
    for (const [key, virt] of entries) {
      Object.defineProperty(row, key, {
        get() {
          let value: unknown

          try {
            value = virt.compute(row)
          }
          catch (err) {
            // Use the underlying row to read the PK, not `this` — `this` may
            // be a row clone created by post-processing. `row` is the bound
            // closure target that was actually passed to compute().
            const pkValue = (row as Record<string, unknown>)[pkColumn]
            const rowRef = pkValue !== undefined
              ? `row ${tableName}.${pkColumn}=${formatPkValue(pkValue)}`
              : `row in table "${tableName}"`

            throw new OrmError(
              `Virtual field "${key}" on ${rowRef} threw during computation: ${err instanceof Error ? err.message : String(err)}`,
              err,
            )
          }

          Object.defineProperty(this, key, { value, writable: true, enumerable: true, configurable: true })

          return value
        },
        enumerable: true,
        configurable: true,
      })
    }
  }

  return rows
}

function formatPkValue(value: unknown): string {
  if (value === null)
    return 'null'

  if (typeof value === 'string')
    return `"${value}"`

  return String(value)
}
