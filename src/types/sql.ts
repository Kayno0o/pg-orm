/**
 * Bun SQL type definitions and type-safe query helpers
 */

import type { SQL } from 'bun'

export type SQLInstance = SQL

/**
 * SQL query from Bun's tagged template
 * Represents a Query object that can be awaited
 */
export type SQLFragment = SQL.Query<unknown> | SQL.Helper<unknown>

/**
 * Database row type
 * Represents a raw row returned from PostgreSQL
 */
export interface DatabaseRow extends Record<string, unknown> {
  id?: number
}

/**
 * Query result type
 * Generic type for query results with proper typing
 */
export type QueryResult<T> = Promise<T[]>

/**
 * Single result type
 * For queries that return a single entity or null
 */
export type SingleResult<T> = Promise<T | null>

/**
 * Transaction callback type
 * Function executed within a transaction context
 */
export type TransactionCallback<T = void> = (tx: SQL) => Promise<T>

/**
 * Query options for parameterized queries
 * Allows passing parameters safely to SQL queries
 */
export type QueryParameters = Record<string, SQLQueryBindings>

/**
 * Valid SQL parameter types
 * Types that can be safely passed as SQL parameters
 */
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

/**
 * SQL clause type
 * Represents a WHERE, HAVING, or other clause
 */
export type SQLClause = SQLFragment | null

/**
 * Order direction for ORDER BY clauses
 */
export type OrderDirection = 'ASC' | 'DESC'

/**
 * Join type for SQL joins
 */
export type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'

/**
 * Operator type for WHERE conditions
 */
export type WhereOperator = 'AND' | 'OR'

/**
 * Type guard to check if value is a SQL fragment
 */
export function isSQLFragment(value: unknown): value is SQLFragment {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  // eslint-disable-next-line github/no-then
  const hasPromiseInterface = 'then' in value && typeof (value as Record<string, unknown>).then === 'function'

  return hasPromiseInterface
}

/**
 * Type-safe query builder result
 * Contains both the query and its parameters
 */
export interface QueryBuildResult {
  query: string
  params: SQLQueryBindings[]
}
