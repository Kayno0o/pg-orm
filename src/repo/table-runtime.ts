import type { AnyTableDef, HookEvent } from '../types/index'
import type { TableBehavior } from './table-behavior'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { AfterHookError, BeforeHookError, OrmError } from '../errors/index'
import { hasHooks, runHooksAsync } from '../hooks/index'
import { buildTableBehavior } from './table-behavior'

type VirtualEntry = [string, { compute: (r: unknown) => unknown }]

/**
 * Frozen per-table runtime: one object per `Repository` that absorbs trait
 * behavior, hook orchestration, and virtual installation. Built once at
 * `Repository` construction, queried many times, no scattered state — suites
 * depend on one thing, not three.
 */
export interface TableRuntime {
  readonly table: AnyTableDef
  readonly primaryKey: string

  // Trait behavior surface
  readonly behavior: TableBehavior

  // Hook surface
  runBefore: <T>(event: HookEvent, value: T) => Promise<T>
  runBeforeMany: <T>(event: HookEvent, values: T[]) => Promise<T[]>
  runAfter: (event: HookEvent, rows?: unknown[]) => Promise<void>

  // Virtual surface
  applyVirtuals: <T extends Record<string, unknown>>(rows: T[]) => T[]
}

/** Build the consolidated runtime for a single table. */
export function buildTableRuntime(table: AnyTableDef): TableRuntime {
  const primaryKey = table.primaryKey ?? DEFAULT_PRIMARY_KEY
  const behavior = buildTableBehavior(table)

  // Pre-compute virtual entries once — table.virtuals is frozen at schema
  // declaration, so re-defining a table produces a new runtime and there is
  // nothing to invalidate at runtime.
  const virtualEntries: VirtualEntry[] = table.virtuals ? Object.entries(table.virtuals) : []

  async function runBefore<T>(event: HookEvent, value: T): Promise<T> {
    if (!hasHooks(table, event))
      return value

    try {
      return await runHooksAsync(table, event, value)
    }
    catch (err) {
      throw new BeforeHookError(table.name, event, err)
    }
  }

  async function runBeforeMany<T>(event: HookEvent, values: T[]): Promise<T[]> {
    if (!hasHooks(table, event))
      return values

    try {
      return await Promise.all(values.map(row => runHooksAsync(table, event, row)))
    }
    catch (err) {
      throw new BeforeHookError(table.name, event, err)
    }
  }

  async function runAfter(event: HookEvent, rows?: unknown[]): Promise<void> {
    if (!hasHooks(table, event))
      return

    try {
      await runHooksAsync(table, event, rows)
    }
    catch (err) {
      throw new AfterHookError(table.name, event, err)
    }
  }

  function applyVirtuals<T extends Record<string, unknown>>(rows: T[]): T[] {
    if (virtualEntries.length === 0)
      return rows

    const tableName = table.name

    for (const row of rows) {
      for (const [key, virt] of virtualEntries) {
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
              const pkValue = (row as Record<string, unknown>)[primaryKey]
              const rowRef = pkValue !== undefined
                ? `row ${tableName}.${primaryKey}=${formatPkValue(pkValue)}`
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

  return Object.freeze({
    table,
    primaryKey,
    behavior,
    runBefore,
    runBeforeMany,
    runAfter,
    applyVirtuals,
  })
}

function formatPkValue(value: unknown): string {
  if (value === null)
    return 'null'

  if (typeof value === 'string')
    return `"${value}"`

  return String(value)
}
