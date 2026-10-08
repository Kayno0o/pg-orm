import type { Dialect } from '../dialect'
import type { OrderDir, OrderEntry } from './state'
import { ValidationError } from '../errors/index'
import { formatOrderBy, PLACEHOLDER_RE } from './state'

type SetOp = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'INTERSECT ALL' | 'EXCEPT' | 'EXCEPT ALL'

// Rendered when the set operation is, in its dialect.
interface SetOperand {
  toSQL: (dialect?: Dialect) => { sql: string, params: unknown[] }
}

export class SetOperationBuilder<_TResult = Record<string, unknown>> {
  private operands: SetOperand[] = []
  private operators: SetOp[] = []
  private _orderBy: OrderEntry[] = []
  private _limit: number | null = null
  private _offset: number | null = null

  private constructor(first: SetOperand) {
    this.operands.push(first)
  }

  static union<T>(
    ...queries: SetOperand[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!)

    for (const q of rest) {
      builder.operators.push('UNION')
      builder.operands.push(q)
    }

    return builder
  }

  static unionAll<T>(
    ...queries: SetOperand[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!)

    for (const q of rest) {
      builder.operators.push('UNION ALL')
      builder.operands.push(q)
    }

    return builder
  }

  static intersect<T>(
    ...queries: SetOperand[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!)

    for (const q of rest) {
      builder.operators.push('INTERSECT')
      builder.operands.push(q)
    }

    return builder
  }

  static except<T>(
    ...queries: SetOperand[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!)

    for (const q of rest) {
      builder.operators.push('EXCEPT')
      builder.operands.push(q)
    }

    return builder
  }

  orderBy(col: string, dir: OrderDir = 'asc', nulls?: 'first' | 'last'): this {
    this._orderBy.push({ col, dir, nulls })

    return this
  }

  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new ValidationError(`limit() requires a non-negative integer, got ${n}`, 'limit', { value: n })
    }

    this._limit = n

    return this
  }

  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new ValidationError(`offset() requires a non-negative integer, got ${n}`, 'offset', { value: n })
    }

    this._offset = n

    return this
  }

  toSQL(dialect: Dialect = 'postgres'): { sql: string, params: unknown[] } {
    const allParams: unknown[] = []
    const parts: string[] = []

    for (let i = 0; i < this.operands.length; i++) {
      if (i > 0)
        parts.push(this.operators[i - 1]!)

      const op = this.operands[i]!.toSQL(dialect)
      const offset = allParams.length
      const sql = op.sql.replace(PLACEHOLDER_RE, (_, n) => `$${Number(n) + offset}`)

      allParams.push(...op.params)
      // SQLite takes no parenthesized operand, but a subquery it selects from.
      parts.push(dialect === 'sqlite' ? `SELECT * FROM (${sql})` : `(${sql})`)
    }

    if (this._orderBy.length)
      parts.push(`ORDER BY ${formatOrderBy(this._orderBy)}`)

    if (this._limit != null) {
      allParams.push(this._limit)
      parts.push(`LIMIT $${allParams.length}`)
    }
    else if (this._offset != null && dialect === 'sqlite') {
      parts.push('LIMIT -1')
    }

    if (this._offset != null) {
      allParams.push(this._offset)
      parts.push(`OFFSET $${allParams.length}`)
    }

    return { sql: parts.join(' '), params: allParams }
  }
}
