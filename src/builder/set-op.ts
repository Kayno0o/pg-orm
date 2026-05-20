import type { OrderDir, OrderEntry } from './state'
import { formatOrderBy, PLACEHOLDER_RE } from './state'

type SetOp = 'UNION' | 'UNION ALL' | 'INTERSECT' | 'INTERSECT ALL' | 'EXCEPT' | 'EXCEPT ALL'

interface SetOperand {
  sql: string
  params: unknown[]
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
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('UNION')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  static unionAll<T>(
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('UNION ALL')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  static intersect<T>(
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('INTERSECT')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  static except<T>(
    ...queries: { toSQL: () => { sql: string, params: unknown[] } }[]
  ): SetOperationBuilder<T> {
    const [first, ...rest] = queries
    const builder = new SetOperationBuilder<T>(first!.toSQL())

    for (const q of rest) {
      builder.operators.push('EXCEPT')
      builder.operands.push(q.toSQL())
    }

    return builder
  }

  orderBy(col: string, dir: OrderDir = 'asc', nulls?: 'first' | 'last'): this {
    this._orderBy.push({ col, dir, nulls })

    return this
  }

  limit(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`limit() requires a non-negative integer, got ${n}`)
    }

    this._limit = n

    return this
  }

  offset(n: number): this {
    if (!Number.isInteger(n) || n < 0) {
      throw new TypeError(`offset() requires a non-negative integer, got ${n}`)
    }

    this._offset = n

    return this
  }

  toSQL(): { sql: string, params: unknown[] } {
    const allParams: unknown[] = []
    const parts: string[] = []

    for (let i = 0; i < this.operands.length; i++) {
      if (i > 0)
        parts.push(this.operators[i - 1]!)

      const op = this.operands[i]!
      const offset = allParams.length
      const sql = op.sql.replace(PLACEHOLDER_RE, (_, n) => `$${Number(n) + offset}`)

      allParams.push(...op.params)
      parts.push(`(${sql})`)
    }

    if (this._orderBy.length)
      parts.push(`ORDER BY ${formatOrderBy(this._orderBy)}`)

    if (this._limit != null) {
      allParams.push(this._limit)
      parts.push(`LIMIT $${allParams.length}`)
    }

    if (this._offset != null) {
      allParams.push(this._offset)
      parts.push(`OFFSET $${allParams.length}`)
    }

    return { sql: parts.join(' '), params: allParams }
  }
}
