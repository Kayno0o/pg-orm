import type { AnyColumns, InferSelect, InferUpdate } from '../types/index'
import { quote } from '../sql/utils'

// Marks values this module built, so a plain object written to a json column is never read as an expression.
const CONFLICT_VALUE: unique symbol = Symbol('pg-orm.ConflictValue')

/** A value an upsert's conflict update writes, built from the existing row and the incoming one. `sql` holds `?` placeholders for `params`. */
export interface ConflictValue<T> {
  readonly sql: string
  readonly params: readonly unknown[]
  readonly _type?: T
}

type Operand<T> = T | ConflictValue<T>

/** What an upsert writes on conflict: per column, a plain value or a `ConflictValue`. */
export type ConflictSet<TColumns extends AnyColumns> = {
  [K in keyof InferUpdate<TColumns>]?: InferUpdate<TColumns>[K] | ConflictValue<InferUpdate<TColumns>[K]>
}

/** The `u` an upsert's `set` callback gets: `u => ({ visits: u.add(u.existing('visits'), 1) })`. */
export interface ConflictExprBuilder<TColumns extends AnyColumns> {
  /** The column's value on the row already in the table. */
  existing: <K extends keyof TColumns & string>(col: K) => ConflictValue<InferSelect<TColumns>[K]>
  /** The column's value on the row being inserted (`EXCLUDED`). */
  excluded: <K extends keyof TColumns & string>(col: K) => ConflictValue<InferSelect<TColumns>[K]>
  add: <T extends number | bigint>(a: Operand<T>, b: Operand<T>) => ConflictValue<T>
  sub: <T extends number | bigint>(a: Operand<T>, b: Operand<T>) => ConflictValue<T>
  /** The first non-null value. */
  coalesce: <T>(...values: Operand<T>[]) => ConflictValue<T>
  /**
   * A raw SQL expression, `?` for each param. Columns must be qualified: `"table"."col"` or `EXCLUDED."col"`.
   *
   * @trusted The SQL is inlined verbatim. Pass only developer-authored SQL, never user input.
   */
  raw: <T = unknown>(sql: string, ...params: unknown[]) => ConflictValue<T>
}

export function isConflictValue(value: unknown): value is ConflictValue<unknown> {
  return typeof value === 'object' && value !== null && CONFLICT_VALUE in value
}

function conflictValue<T>(sql: string, params: readonly unknown[]): ConflictValue<T> {
  return { sql, params, [CONFLICT_VALUE]: true } as ConflictValue<T>
}

function operand(value: unknown): ConflictValue<unknown> {
  return isConflictValue(value) ? value : conflictValue('?', [value])
}

function binary<T>(op: string, a: unknown, b: unknown): ConflictValue<T> {
  const left = operand(a)
  const right = operand(b)

  return conflictValue(`(${left.sql} ${op} ${right.sql})`, [...left.params, ...right.params])
}

export function createConflictExprBuilder<TColumns extends AnyColumns>(table: string): ConflictExprBuilder<TColumns> {
  return {
    existing: col => conflictValue(`${quote(table)}.${quote(col)}`, []),
    excluded: col => conflictValue(`EXCLUDED.${quote(col)}`, []),
    add: (a, b) => binary('+', a, b),
    sub: (a, b) => binary('-', a, b),
    coalesce: (...values) => {
      const parts = values.map(operand)

      return conflictValue(`COALESCE(${parts.map(p => p.sql).join(', ')})`, parts.flatMap(p => p.params))
    },
    raw: (sql, ...params) => conflictValue(sql, params),
  }
}
