import type { ColumnTypes } from '../schema/columns'
import type { AnyTableDef, VirtualDef } from '../types/index'
import { ColumnBuilder, createColumnTypes } from '../schema/columns'
import { validateIdentifier } from '../schema/validate'

// A trait is a composable table behavior — adds columns, hooks, virtuals, and metadata
export interface Trait {
  columns?: (t: ColumnTypes) => Record<string, ColumnBuilder<any, any, any, any, any>>
  hooks?: (table: AnyTableDef) => void
  virtuals?: Record<string, (row: any) => any>
  meta?: Record<string, unknown>
}

// Apply a trait to a table definition (mutates the table)
export function applyTrait(table: AnyTableDef, trait: Trait): void {
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

// Soft delete: adds a deletedAt column and isDeleted virtual
export function softDelete(column = 'deletedAt'): Trait {
  return {
    columns: t => ({ [column]: t.timestamptz().nullable() }),
    virtuals: {
      isDeleted: (row: any) => row[column] != null,
    },
    meta: { softDelete: { column } },
  }
}

// Optimistic locking: adds a version column that auto-increments on update
export function optimisticLock(column = 'version'): Trait {
  return {
    columns: t => ({ [column]: t.int4().notNull().default('1') }),
    meta: { optimisticLock: { column } },
  }
}

// Timestamps: adds createdAt and updatedAt columns with auto-update hook
export function timestamps(opts?: { createdAt?: string, updatedAt?: string }): Trait {
  const createdAt = opts?.createdAt ?? 'createdAt'
  const updatedAt = opts?.updatedAt ?? 'updatedAt'

  return {
    columns: t => ({
      [createdAt]: t.timestamptz().notNull().default('now()'),
      [updatedAt]: t.timestamptz().notNull().default('now()'),
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
