import type { AnyColumns } from '../types/index'
import type { ExprBuilder, ExprTape } from './expr'
import type { BuilderState, QueryOp } from './state'
import { assembleQuery } from './assembler'
import { createExprBuilder } from './expr'
import { cloneState, createState } from './state'

export abstract class BaseBuilder {
  /** @internal */ _state: BuilderState

  constructor(op: QueryOp, table: string) {
    this._state = createState(op, table)
  }

  getState(): BuilderState {
    return this._state
  }

  /** Create an independent copy of this builder; further chaining doesn't affect the original. */
  branch(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this

    copy._state = cloneState(this._state)

    return copy
  }

  toSQL(): { sql: string, params: unknown[] } {
    return assembleQuery(this._state)
  }

  explain(opts?: { analyze?: boolean }): { sql: string, params: unknown[] } {
    const { sql, params } = this.toSQL()
    const analyze = opts?.analyze ? 'ANALYZE, ' : ''

    return { sql: `EXPLAIN (${analyze}FORMAT JSON) ${sql}`, params }
  }
}

export abstract class MutationBuilder extends BaseBuilder {
  // returning() typed overloads stay per-subclass; bodies delegate here.
  protected _setReturning(cols: string[]): this {
    this._state.returning = cols.length ? cols : []

    return this
  }
}

export abstract class WhereableMutationBuilder<TColumns extends AnyColumns = AnyColumns> extends MutationBuilder {
  where(fn: (e: ExprBuilder<TColumns>) => ExprTape): this {
    const builder = createExprBuilder<TColumns>()

    this._state.whereTape = fn(builder)

    return this
  }
}
