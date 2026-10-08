import type { Dialect } from '../dialect'
import type { AnyColumns } from '../types/index'
import type { OptionalWhere } from './_where'
import type { BuilderState, QueryOp } from './state'
import { DialectError } from '../errors/index'
import { appendWhere, replaceWhere } from './_where'
import { assembleQuery } from './assembler'
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

  /**
   * The statement in the dialect's SQL, Postgres unless told otherwise; the repositories pass their database's.
   * Embedded as a subquery (`e.exists(q)`), it is given the placeholders before it, which its own are numbered after.
   */
  toSQL(dialect?: Dialect): { sql: string, params: unknown[] }
  toSQL(paramOffset: number, dialect?: Dialect): { sql: string, params: unknown[] }
  toSQL(offsetOrDialect?: number | Dialect, dialect?: Dialect): { sql: string, params: unknown[] } {
    if (typeof offsetOrDialect === 'number')
      return assembleQuery(this._state, dialect, offsetOrDialect)

    return assembleQuery(this._state, offsetOrDialect ?? dialect)
  }

  explain(opts?: { analyze?: boolean }, dialect: Dialect = 'postgres'): { sql: string, params: unknown[] } {
    const { sql, params } = this.toSQL(dialect)

    if (dialect === 'sqlite') {
      if (opts?.analyze)
        throw new DialectError('explain({ analyze: true })', dialect)

      return { sql: `EXPLAIN QUERY PLAN ${sql}`, params }
    }

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
  /**
   * Set the WHERE clause, as either `{ col: value }` (entries ANDed) or an
   * `ExprBuilder` callback. Replaces any existing WHERE; a falsy `cond` is a no-op.
   */
  where(cond: OptionalWhere<TColumns>): this {
    replaceWhere<TColumns>(this._state, cond)

    return this
  }

  /** AND an additional condition onto the WHERE clause. A falsy `cond` is a no-op. */
  andWhere(cond: OptionalWhere<TColumns>): this {
    appendWhere<TColumns>(this._state, [cond])

    return this
  }

  /** AND every truthy condition onto the WHERE clause. Falsy entries are skipped. */
  whereAll(...conds: OptionalWhere<TColumns>[]): this {
    appendWhere<TColumns>(this._state, conds)

    return this
  }
}
