import type { ExprBuilder } from '../builder/expr'
import type { DeleteBuilder, SelectBuilder, UpdateBuilder, WhereInput } from '../builder/query'
import type { ScopeFilter } from '../builder/state'
import type { AnyColumns, AnyTableDef, InferUpdate, ScopeOptions } from '../types/index'
import { BulkUpdateBuilder } from '../builder/bulk-update'
import { compileWhere, UpdateBuilder as UpdateBuilderCtor } from '../builder/query'
import { SOFT_DELETE_SCOPE } from '../constants'
import { OrmError } from '../errors/index'
import { tableMeta, tableScopes } from '../schema/inspect'
import { queryContextStorage } from '../sql/base-executor'
import { quote } from '../sql/utils'

/** Any UPDATE a trait can add a raw SET to: the single-statement builder or the per-row bulk one. */
interface RawSettable {
  setRaw: (column: string, sqlExpression: string) => unknown
}

/** The scopes a call lifts. */
export function liftedScopes(opts?: ScopeOptions): string[] {
  const lifted = opts?.withoutScopes ?? []

  return opts?.withTrashed ? [...lifted, SOFT_DELETE_SCOPE] : lifted
}

/** The table's scopes, each WHERE built now against the request context; `qualifier` names the alias the table is joined under. */
export function resolveScopes(table: AnyTableDef, qualifier?: string): ScopeFilter[] {
  const ctx = queryContextStorage.getStore() ?? {}

  return Object.entries(tableScopes(table)).map(([name, scope]) => ({ name, tape: compileWhere(e => scope(e, ctx), table.columns), qualifier }))
}

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
  /** Apply all pre-SELECT transforms: the table's scopes, which the assembler applies unless `withoutScope()` lifted them, before or after. */
  prepareSelect: (builder: SelectBuilder<any, any, any>) => void

  /**
   * Apply all post-SET transforms for an UPDATE.
   *
   * Callers must invoke this **after** `.set()` and `.where()` so traits can
   * safely inject `setRaw` values that cannot be smuggled through user payloads.
   */
  prepareUpdate: (builder: RawSettable, set: Record<string, unknown>) => void

  /** Keep an UPDATE or DELETE to the rows the table's scopes hold for, but those `lifted`. */
  guardWrite: (builder: UpdateBuilder<any> | DeleteBuilder<any> | BulkUpdateBuilder, lifted: string[]) => void

  /** The SET a soft delete writes (the deletion timestamp), or `null` when the table hard-deletes. Run it through `beforeUpdate` hooks, then hand it to `rewriteDelete`. */
  softDeleteSet: <TColumns extends AnyColumns>() => InferUpdate<TColumns> | null

  /** Build the UPDATE a soft delete runs: restricted to rows not already trashed and to the scopes not `lifted`, post-SET transforms (version bump) included. A `null` where trashes every row. */
  rewriteDelete: <TColumns extends AnyColumns>(
    set: InferUpdate<TColumns>,
    where: WhereInput<TColumns> | null,
    lifted: string[],
  ) => UpdateBuilder<TColumns>

  /**
   * Build the UPDATE used by `restore()`.
   *
   * Throws if the table does not have a soft-delete trait. The returned builder
   * already restricts the where to rows where the soft-delete column is not
   * null and to the other scopes not `lifted`, and has had post-SET transforms applied.
   */
  buildRestoreUpdate: <TColumns extends AnyColumns>(
    set: InferUpdate<TColumns>,
    where: WhereInput<TColumns>,
    lifted: string[],
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
  const columnNames = Object.keys(table.columns)

  function prepareSelect(b: SelectBuilder<any, any, any>): void {
    const state = b.getState()

    state.tableColumns = columnNames
    state.scopes = resolveScopes(table)
  }

  function prepareUpdate(b: RawSettable, _set: Record<string, unknown>): void {
    if (hasOptimisticLock) {
      // Internal — runs AFTER `.set()` validation so user payloads can't
      // smuggle `__raw` through and the version bump itself bypasses the check.
      b.setRaw(optimisticLockColumn!, `${quote(optimisticLockColumn!)} + 1`)
    }
  }

  function guardWrite(b: UpdateBuilder<any> | DeleteBuilder<any> | BulkUpdateBuilder, lifted: string[]): void {
    for (const { name, tape } of resolveScopes(table)) {
      if (lifted.includes(name))
        continue

      if (b instanceof BulkUpdateBuilder)
        b.andWhere(tape)
      else
        b.andWhere(() => tape)
    }
  }

  function softDeleteSet<TColumns extends AnyColumns>(): InferUpdate<TColumns> | null {
    return hasSoftDelete ? { [softDeleteColumn!]: new Date() } as InferUpdate<TColumns> : null
  }

  function rewriteDelete<TColumns extends AnyColumns>(
    set: InferUpdate<TColumns>,
    where: WhereInput<TColumns> | null,
    lifted: string[],
  ): UpdateBuilder<TColumns> {
    const builder = new UpdateBuilderCtor<TColumns>(table)
      .set(set)
      .where((e: ExprBuilder<TColumns>) => where ? e.and(compileWhere<TColumns>(where, table.columns as TColumns), e.isNull(softDeleteColumn!)) : e.isNull(softDeleteColumn!))

    guardWrite(builder, [...lifted, SOFT_DELETE_SCOPE])
    prepareUpdate(builder, set as Record<string, unknown>)

    return builder
  }

  function buildRestoreUpdate<TColumns extends AnyColumns>(
    set: InferUpdate<TColumns>,
    where: WhereInput<TColumns>,
    lifted: string[],
  ): UpdateBuilder<TColumns> {
    if (softDeleteColumn === null) {
      throw new OrmError(
        `restore() requires softDelete trait on table "${table.name}"`,
      )
    }

    const builder = new UpdateBuilderCtor<TColumns>(table)
      .set(set)
      .where((e: ExprBuilder<TColumns>) => e.and(compileWhere<TColumns>(where, table.columns as TColumns), e.isNotNull(softDeleteColumn)))

    guardWrite(builder, [...lifted, SOFT_DELETE_SCOPE])
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
    prepareUpdate,
    guardWrite,
    softDeleteSet,
    rewriteDelete,
    buildRestoreUpdate,
    getOptimisticLockColumn,
    getSoftDeleteColumn,
  })
}
