import type { ExprBuilder } from '../builder/expr'
import type { InsertBuilder, SelectBuilder, UpdateBuilder, WhereInput } from '../builder/query'
import type { AnyColumns, AnyTableDef, InferUpdate } from '../types/index'
import { compileWhere, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { OrmError } from '../errors/index'
import { tableMeta } from '../schema/inspect'
import { quote } from '../sql/utils'

/**
 * Deep module that owns the per-table, per-operation behavior introduced by
 * traits. The read/write pipelines delegate to this object instead of
 * hard-coding when to apply soft-delete filters, optimistic-lock version bumps,
 * or delete rewrites.
 *
 * The ordering contract that used to be implicit in the pipelines — e.g.
 * "applyPreUpdate must run after `.set()`" — now lives here and is enforced by
 * the method itself.
 */
export interface TableBehavior {
  /** Apply all pre-SELECT transforms (e.g. soft-delete filter). */
  prepareSelect: (builder: SelectBuilder<any, any, any>) => void

  /** Apply all pre-INSERT transforms. Currently a no-op seam for future traits. */
  prepareInsert: (builder: InsertBuilder<any>) => void

  /**
   * Apply all post-SET transforms for an UPDATE.
   *
   * Callers must invoke this **after** `.set()` and `.where()` so traits can
   * safely inject `setRaw` values that cannot be smuggled through user payloads.
   */
  prepareUpdate: (builder: UpdateBuilder<any>, set: Record<string, unknown>) => void

  /** Rewrite a DELETE into an UPDATE for soft-delete tables, or return `null`. */
  rewriteDelete: <TColumns extends AnyColumns>(
    where: WhereInput<TColumns>,
  ) => UpdateBuilder<TColumns> | null

  /**
   * Build the UPDATE used by `restore()`.
   *
   * Throws if the table does not have a soft-delete trait. The returned builder
   * already restricts the where to rows where the soft-delete column is not
   * null and has had post-SET transforms applied.
   */
  buildRestoreUpdate: <TColumns extends AnyColumns>(
    set: InferUpdate<TColumns>,
    where: WhereInput<TColumns>,
  ) => UpdateBuilder<TColumns>

  /** Return the optimistic-lock column name, or `null` if the trait is absent. */
  getOptimisticLockColumn: () => string | null

  /** Return the soft-delete column name, or `null` if the trait is absent. */
  getSoftDeleteColumn: () => string | null
}

/** Build the consolidated behavior object for a single table. */
export function buildTableBehavior(table: AnyTableDef): TableBehavior {
  const meta = tableMeta(table)
  const softDeleteColumn = meta.softDelete?.column ?? null
  const optimisticLockColumn = meta.optimisticLock?.column ?? null
  const hasSoftDelete = softDeleteColumn !== null
  const hasOptimisticLock = optimisticLockColumn !== null

  function prepareSelect(b: SelectBuilder<any, any, any>): void {
    if (hasSoftDelete && !b.getState().withTrashed) {
      b.andWhere(e => e.isNull(softDeleteColumn!))
    }
  }

  function prepareInsert(_b: InsertBuilder<any>): void {
    // No insert-time transforms currently exist. This is an extensibility seam
    // for future traits that need to inspect or mutate insert builders.
  }

  function prepareUpdate(b: UpdateBuilder<any>, _set: Record<string, unknown>): void {
    if (hasOptimisticLock) {
      // Internal — runs AFTER `.set()` validation so user payloads can't
      // smuggle `__raw` through and the version bump itself bypasses the check.
      b.setRaw(optimisticLockColumn!, `${quote(optimisticLockColumn!)} + 1`)
    }
  }

  function rewriteDelete<TColumns extends AnyColumns>(
    where: WhereInput<TColumns>,
  ): UpdateBuilder<TColumns> | null {
    if (!hasSoftDelete)
      return null

    return new UpdateBuilderCtor<TColumns>(table.name)
      .set({ [softDeleteColumn!]: new Date() } as InferUpdate<TColumns>)
      .where(where)
      .returning()
  }

  function buildRestoreUpdate<TColumns extends AnyColumns>(
    set: InferUpdate<TColumns>,
    where: WhereInput<TColumns>,
  ): UpdateBuilder<TColumns> {
    if (softDeleteColumn === null) {
      throw new OrmError(
        `restore() requires softDelete trait on table "${table.name}"`,
      )
    }

    const builder = new UpdateBuilderCtor<TColumns>(table.name)
      .set(set)
      .where((e: ExprBuilder<TColumns>) => e.and(compileWhere<TColumns>(where), e.isNotNull(softDeleteColumn)))

    prepareUpdate(builder, set as Record<string, unknown>)

    return builder
  }

  function getOptimisticLockColumn(): string | null {
    return optimisticLockColumn
  }

  function getSoftDeleteColumn(): string | null {
    return softDeleteColumn
  }

  return Object.freeze({
    prepareSelect,
    prepareInsert,
    prepareUpdate,
    rewriteDelete,
    buildRestoreUpdate,
    getOptimisticLockColumn,
    getSoftDeleteColumn,
  })
}
