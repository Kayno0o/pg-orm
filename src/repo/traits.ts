import type { SelectBuilder } from '../builder/query'
import type { AnyColumns, AnyRelations, AnyTableDef } from '../types/index'
import { OrmError } from '../errors/index'

/** Read the optimistic-lock column name from a TableDef, or `null` if the trait isn't applied. */
export function getOptimisticLockColumn(table: AnyTableDef): string | null {
  const ol = table.meta?.optimisticLock as { column: string } | undefined

  return ol?.column ?? null
}

/** Read the soft-delete column name from a TableDef, or `null` if the trait isn't applied. */
export function getSoftDeleteColumn(table: AnyTableDef): string | null {
  const sd = table.meta?.softDelete as { column: string } | undefined

  return sd?.column ?? null
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
