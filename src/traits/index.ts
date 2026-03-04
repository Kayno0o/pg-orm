import type { ColumnTypes } from '../schema/columns'
import type { AnyColumns, AnyTableDef, ColumnDef, HasDefault, IsNullable, NoDefault, NotGenerated, NotNullable, NotPrimaryKey, VirtualDef } from '../types/index'
import { ColumnBuilder, createColumnTypes } from '../schema/columns'
import { validateIdentifier } from '../schema/validate'

/**
 * A trait is a composable table behavior that adds columns, hooks, virtuals, and metadata.
 * Apply with `table.withTrait(myTrait)`. Built-in traits: `softDelete()`, `timestamps()`, `optimisticLock()`.
 * The generic `TCols` carries the type-level column definitions for proper inference via `withTrait`.
 */
export interface Trait<TCols extends AnyColumns = {}> {
  readonly _cols?: TCols
  columns?: (t: ColumnTypes) => Record<string, ColumnBuilder<any, any, any, any, any>>
  hooks?: (table: AnyTableDef) => void
  virtuals?: Record<string, (row: any) => any>
  meta?: Record<string, unknown>
}

// Apply a trait to a table definition (mutates the table)
export function applyTrait(table: AnyTableDef, trait: Trait<any>): void {
  // Merge columns
  if (trait.columns) {
    const t = createColumnTypes()
    const builders = trait.columns(t)
    const columns = table.columns as Record<string, unknown>

    for (const key in builders) {
      validateIdentifier(key, 'column')
      const b = builders[key]

      if (b instanceof ColumnBuilder) {
        columns[key] = b._build()
      }
    }
  }

  // Register hooks
  if (trait.hooks) {
    trait.hooks(table)
  }

  // Merge virtuals
  if (trait.virtuals) {
    const virtuals = table.virtuals as Record<string, VirtualDef>

    for (const key in trait.virtuals) {
      virtuals[key] = { _kind: 'virtual', compute: trait.virtuals[key]! } as VirtualDef
    }
  }

  // Merge meta
  if (trait.meta) {
    const meta = (table as any).meta as Record<string, unknown>

    for (const key in trait.meta) {
      meta[key] = trait.meta[key]
    }
  }
}

// --- Built-in Traits ---

/**
 * Soft delete trait. Adds a nullable timestamp column and an `isDeleted` virtual.
 * When applied, `deleteMany`/`deleteOne` will SET the column instead of DELETE.
 * Use `.withTrashed()` on queries to include soft-deleted rows.
 * Use `.forceDelete()` for a real DELETE.
 */
export function softDelete<C extends string = 'deletedAt'>(column: C = 'deletedAt' as C): Trait<Record<C, ColumnDef<Date, IsNullable, NoDefault, NotPrimaryKey, NotGenerated>>> {
  return {
    columns: t => ({ [column]: t.timestamptz().nullable() }),
    virtuals: {
      isDeleted: (row: any) => row[column] != null,
    },
    meta: { softDelete: { column } },
  }
}

/**
 * Optimistic locking trait. Adds an integer version column (default 1)
 * that auto-increments on every update. Use `repo.updateWithLock()` to
 * ensure the version matches before updating — throws `StaleRecordError` on conflict.
 */
export function optimisticLock<C extends string = 'version'>(column: C = 'version' as C): Trait<Record<C, ColumnDef<number, NotNullable, HasDefault, NotPrimaryKey, NotGenerated>>> {
  return {
    columns: t => ({ [column]: t.int4().notNull().default(1) }),
    meta: { optimisticLock: { column } },
  }
}

/**
 * Timestamps trait. Adds `createdAt` and `updatedAt` columns (both default to `now()`).
 * Registers a `beforeUpdate` hook that sets `updatedAt` to the current time on every update.
 */
export function timestamps<C extends string = 'createdAt', U extends string = 'updatedAt'>(opts?: { createdAt?: C, updatedAt?: U }): Trait<Record<C | U, ColumnDef<Date, NotNullable, HasDefault, NotPrimaryKey, NotGenerated>>> {
  const createdAt = (opts?.createdAt ?? 'createdAt') as C
  const updatedAt = (opts?.updatedAt ?? 'updatedAt') as U

  return {
    columns: t => ({
      [createdAt]: t.timestamptz().notNull().defaultRaw('now()'),
      [updatedAt]: t.timestamptz().notNull().defaultRaw('now()'),
    }),
    hooks: (table) => {
      table.hook('beforeUpdate' as any, ((row: any) => {
        row[updatedAt] = new Date()

        return row
      }) as any)
    },
    meta: { timestamps: { createdAt, updatedAt } },
  }
}
