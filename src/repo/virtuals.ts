import type { AnyTableDef } from '../types/index'
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
 * with the table + field name for easier debugging.
 */
export function applyVirtuals<T extends Record<string, unknown>>(table: AnyTableDef, rows: T[]): T[] {
  const entries = getVirtualEntries(table)

  if (entries.length === 0)
    return rows

  const tableName = table.name

  for (const row of rows) {
    for (const [key, virt] of entries) {
      Object.defineProperty(row, key, {
        get() {
          let value: unknown

          try {
            value = virt.compute(row)
          }
          catch (err) {
            throw new OrmError(
              `Virtual field "${key}" on table "${tableName}" threw during computation: ${err instanceof Error ? err.message : String(err)}`,
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
