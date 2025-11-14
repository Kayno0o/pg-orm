import type { SQL } from 'bun'

export type SQLInstance = SQL

export type SQLFragment = SQL.Query<unknown> | SQL.Helper<unknown>

export interface DatabaseRow extends Record<string, unknown> {
  id?: number
}

export type QueryResult<T> = Promise<T[]>

export type SingleResult<T> = Promise<T | null>

export type TransactionCallback<T = void> = (tx: SQL) => Promise<T>

export type QueryParameters = Record<string, SQLQueryBindings>

export type SQLQueryBindings
  = | string
    | number
    | boolean
    | null
    | undefined
    | Date
    | Uint8Array
    | SQLQueryBindings[]
    | { [key: string]: SQLQueryBindings }

export type SQLClause = SQLFragment | null

export type OrderDirection = 'ASC' | 'DESC'

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'

export type WhereOperator = 'AND' | 'OR'

export function isSQLFragment(value: unknown): value is SQLFragment {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  // eslint-disable-next-line github/no-then
  const hasPromiseInterface = 'then' in value && typeof (value as Record<string, unknown>).then === 'function'

  return hasPromiseInterface
}

export interface QueryBuildResult {
  query: string
  params: SQLQueryBindings[]
}
