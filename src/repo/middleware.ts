import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { SelectBuilder } from '../builder/query'
import type { AnyColumns, AnyTableDef, InferUpdate } from '../types/index'
import { UpdateBuilder } from '../builder/query'
import { quote } from '../sql/utils'
import { getOptimisticLockColumn, getSoftDeleteColumn, getTraitMeta } from './traits'

/**
 * Pre-query hooks contributed by traits. Suites iterate the registered set
 * once per operation so trait behaviors (soft-delete filtering, optimistic-lock
 * version bump) can't silently drift apart across read/write/stream paths.
 */
export interface RepoMiddleware {
  /** Mutate a SELECT/COUNT/EXISTS/STREAM builder before it goes to SQL. */
  onSelect?: (b: SelectBuilder<any, any, any>) => void
  /** Mutate an UPDATE builder before it goes to SQL. */
  onUpdate?: (b: UpdateBuilder<any>) => void
}

/** Build the middleware chain for a table from its trait metadata. */
export function buildMiddleware(table: AnyTableDef): RepoMiddleware[] {
  const out: RepoMiddleware[] = []
  const meta = getTraitMeta(table)

  if (meta.softDelete) {
    const col = meta.softDelete.column

    out.push({
      onSelect: (b) => {
        if (!b.getState().withTrashed) {
          b.andWhere(e => e.isNull(col))
        }
      },
    })
  }

  if (meta.optimisticLock) {
    const col = meta.optimisticLock.column

    // Internal — runs AFTER `.set()` validation so user payloads can't
    // smuggle `__raw` through and the version bump itself bypasses the check.
    out.push({
      onUpdate: (b) => {
        b.setRaw(col, `${quote(col)} + 1`)
      },
    })
  }

  return out
}

/**
 * Per-table dispatcher for trait middleware. Built once per `Repository` and
 * surfaced on `RepositoryCtx.traits` so suites can call `traits.applyPreSelect(b)`
 * instead of hand-wiring each trait's filter at every call site.
 */
export class TraitDispatcher {
  private _mws: RepoMiddleware[]

  constructor(private table: AnyTableDef) {
    this._mws = buildMiddleware(table)
  }

  applyPreSelect(b: SelectBuilder<any, any, any>): void {
    for (const m of this._mws) m.onSelect?.(b)
  }

  applyPreUpdate(b: UpdateBuilder<any>): void {
    for (const m of this._mws) m.onUpdate?.(b)
  }

  /**
   * If the table has the soft-delete trait, return a pre-configured
   * UpdateBuilder that flips the soft-delete column. Returns `null` otherwise —
   * caller should fall through to a real DELETE.
   */
  rewriteDelete<TColumns extends AnyColumns>(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): UpdateBuilder<TColumns> | null {
    const col = getSoftDeleteColumn(this.table)

    if (col === null)
      return null

    return new UpdateBuilder<TColumns>(this.table.name)
      .set({ [col]: new Date() } as InferUpdate<TColumns>)
      .where(where)
      .returning()
  }

  /** Read the soft-delete column name, or `null` if the trait isn't applied. */
  getSoftDeleteColumn(): string | null {
    return getSoftDeleteColumn(this.table)
  }

  /** Read the optimistic-lock column name, or `null` if the trait isn't applied. */
  getOptimisticLockColumn(): string | null {
    return getOptimisticLockColumn(this.table)
  }
}
