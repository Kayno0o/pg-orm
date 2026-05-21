import type { AnyTableDef } from '../types/index'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { OrmError } from '../errors/index'

type VirtualEntry = [string, { compute: (r: unknown) => unknown }]

// Per-table cache: avoids re-running Object.entries on every result set.
let _cache = new WeakMap<AnyTableDef, VirtualEntry[]>()

export function clearVirtualEntriesCache(): void {
  _cache = new WeakMap()
}

export function getVirtualEntries(table: AnyTableDef): VirtualEntry[] {
  let entries = _cache.get(table)

  if (!entries) {
    const virtuals = table.virtuals

    entries = virtuals ? Object.entries(virtuals) : []
    _cache.set(table, entries)
  }

  return entries
}

/**
 * Install virtual fields as lazy getters on each row. The first read computes
 * and replaces itself with the materialized value so subsequent reads are
 * plain property accesses. A throw inside `compute` is wrapped in OrmError
 * with the table, field name, and the row's primary-key value so bulk
 * failures (e.g., 1 bad row out of 10k in a findMany) are debuggable.
 */
export function applyVirtuals<T extends Record<string, unknown>>(table: AnyTableDef, rows: T[]): T[] {
  const entries = getVirtualEntries(table)

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
