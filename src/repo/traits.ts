import type { SelectBuilder } from '../builder/query'
import type { AnyColumns, AnyRelations, AnyTableDef } from '../types/index'
import { OrmError } from '../errors/index'

/**
 * Typed snapshot of every built-in trait's metadata for a table. Each entry is
 * `undefined` when the trait hasn't been applied. Single source of truth for
 * the `table.meta` shape — callers should go through `getTraitMeta` (or the
 * trait-specific helpers below) rather than reading `table.meta` directly.
 */
export interface TraitMeta {
  softDelete?: { column: string }
  optimisticLock?: { column: string }
  timestamps?: { createdAt: string, updatedAt: string }
}

/** Read all trait metadata off a table. Missing traits come back as `undefined`. */
export function getTraitMeta(table: AnyTableDef): TraitMeta {
  const meta = table.meta as Record<string, unknown> | undefined

  return {
    softDelete: meta?.softDelete as TraitMeta['softDelete'],
    optimisticLock: meta?.optimisticLock as TraitMeta['optimisticLock'],
    timestamps: meta?.timestamps as TraitMeta['timestamps'],
  }
}

/** Read the optimistic-lock column name from a TableDef, or `null` if the trait isn't applied. */
export function getOptimisticLockColumn(table: AnyTableDef): string | null {
  return getTraitMeta(table).optimisticLock?.column ?? null
}

/** Read the soft-delete column name from a TableDef, or `null` if the trait isn't applied. */
export function getSoftDeleteColumn(table: AnyTableDef): string | null {
  return getTraitMeta(table).softDelete?.column ?? null
}

/** Same as `getSoftDeleteColumn` but throws if the trait is missing. */
export function requireSoftDeleteColumn(table: AnyTableDef, operation: string): string {
  const col = getSoftDeleteColumn(table)

  if (col === null) {
    throw new OrmError(`${operation} requires softDelete trait on table`)
  }

  return col
}

/**
 * Auto-filter soft-deleted rows on a SELECT builder. Skipped when the builder
 * has `.withTrashed()` set so callers can opt out.
 */
export function applySoftDeleteFilter<TColumns extends AnyColumns, TRelations extends AnyRelations>(
  table: AnyTableDef,
  builder: SelectBuilder<TColumns, TRelations, any>,
): void {
  const col = getSoftDeleteColumn(table)

  if (col && !builder.getState().withTrashed) {
    builder.andWhere(e => e.isNull(col))
  }
}
