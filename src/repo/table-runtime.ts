import type { WhereObject } from '../builder/query'
import type { AnyColumns, AnyTableDef, HookEvent } from '../types/index'
import type { TableBehavior } from './table-behavior'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { AfterHookError, BeforeHookError, OrmError, ValidationError } from '../errors/index'
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
  /** The primary key split into its columns: one entry, or one per part of a composite key. */
  readonly pkColumns: readonly string[]

  // Trait behavior surface
  readonly behavior: TableBehavior

  /** WHERE matching one row by primary key. A composite key takes an object holding each part. */
  pkWhere: (id: unknown) => WhereObject<AnyColumns>

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
  const pkColumns = primaryKey.split(',').map(col => col.trim())

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

  // One lazy getter per virtual, shared by every row: it computes from the row it is read on, then replaces itself with the value.
  const virtualDescriptors: PropertyDescriptorMap = {}

  for (const [key, virt] of virtualEntries) {
    virtualDescriptors[key] = {
      get(this: Record<string, unknown>) {
        let value: unknown

        try {
          value = virt.compute(this)
        }
        catch (err) {
          const pkValue = this[primaryKey]
          const rowRef = pkValue !== undefined
            ? `row ${table.name}.${primaryKey}=${formatPkValue(pkValue)}`
            : `row in table "${table.name}"`

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
    }
  }

  function applyVirtuals<T extends Record<string, unknown>>(rows: T[]): T[] {
    if (virtualEntries.length === 0)
      return rows

    for (const row of rows) Object.defineProperties(row, virtualDescriptors)

    return rows
  }

  function pkWhere(id: unknown): WhereObject<AnyColumns> {
    if (pkColumns.length === 1)
      return { [pkColumns[0]!]: id }

    if (typeof id !== 'object' || id === null) {
      throw new ValidationError(
        `Table "${table.name}" has the composite primary key (${pkColumns.join(', ')}); pass an object holding each part.`,
        'primaryKey',
        { value: id },
      )
    }

    const where: Record<string, unknown> = {}

    for (const col of pkColumns) {
      const part = (id as Record<string, unknown>)[col]

      if (part === undefined) {
        throw new ValidationError(
          `Composite primary key on "${table.name}" is missing part "${col}".`,
          'primaryKey',
          { field: col, value: id },
        )
      }

      where[col] = part
    }

    return where
  }

  return Object.freeze({
    table,
    primaryKey,
    pkColumns,
    behavior,
    pkWhere,
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
