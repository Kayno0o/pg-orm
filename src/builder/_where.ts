import type { AnyColumns } from '../types/index'
import type { ExprBuilder, ExprOp, ExprTape } from './expr'
import type { BuilderState } from './state'
import { createExprBuilder, OP_AND } from './expr'

/** A WHERE callback. */
export type WhereFn<TColumns extends AnyColumns> = (e: ExprBuilder<TColumns>) => ExprTape

/**
 * A WHERE callback, or any falsy value meaning "skip this condition". Lets
 * optional filters be written inline (`q.andWhere(status && (e => e.eq('status', status)))`)
 * instead of branching around the builder.
 */
export type OptionalWhere<TColumns extends AnyColumns> = WhereFn<TColumns> | null | undefined | false | '' | 0

/** Compile the truthy callbacks in `conds` to tapes, dropping the falsy ones. */
function compile<TColumns extends AnyColumns>(conds: OptionalWhere<TColumns>[]): ExprTape[] {
  const tapes: ExprTape[] = []

  for (const cond of conds) {
    if (cond)
      tapes.push(cond(createExprBuilder<TColumns>()))
  }

  return tapes
}

/** Replace `state.whereTape` with `fn`'s tape. A falsy `fn` leaves it untouched. */
export function replaceWhere<TColumns extends AnyColumns>(state: BuilderState, fn: OptionalWhere<TColumns>): void {
  if (fn)
    state.whereTape = fn(createExprBuilder<TColumns>())
}

/** AND the truthy conditions onto `state.whereTape`, keeping any existing clause. */
export function appendWhere<TColumns extends AnyColumns>(state: BuilderState, conds: OptionalWhere<TColumns>[]): void {
  const tapes = compile(conds)

  if (state.whereTape)
    tapes.unshift(state.whereTape)

  if (tapes.length === 0)
    return

  if (tapes.length === 1) {
    state.whereTape = tapes[0]!

    return
  }

  const combined: ExprTape = [{ op: OP_AND, count: tapes.length } as ExprOp]

  for (const tape of tapes) combined.push(...tape)

  state.whereTape = combined
}
