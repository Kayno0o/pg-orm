/**
 * Type system and helpers for the ORM
 */

import type { SQL } from 'bun'
import type {
  OrderOptions,
  PartialRecord as PartialRecordType,
  WhereConditions,
} from './types/columns'

export type { PartialRecordType as PartialRecord }

/**
 * Base interface for all entities (has an id)
 */
export interface Identifiable {
  id: number
}

/**
 * Valid SQL query parameter types
 * Re-exported from types/sql.ts for backward compatibility
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
 * Column definition metadata
 * Extended to support all PostgreSQL types
 */
export interface DBField {
  type:
    | 'bool'
    | 'int'
    | 'float'
    | 'text'
    | 'blob'
    | 'json'
    | 'jsonb'
    | 'uuid'
    | 'timestamp'
    | 'array'
    | 'enum'
  nullable?: boolean
  unique?: boolean
  primary?: boolean
  default?: SQLQueryBindings
  name?: string
  reference?: string | { key: string, table: string }
  arrayType?: 'text' | 'int' | 'float'
  enumValues?: string[]
  autoUpdate?: boolean
}

/**
 * Query options for findAllBy and findOneBy
 * Enhanced with better type safety
 */
export interface QueryOptions<T> {
  where?: WhereConditions<T>
  order?: OrderOptions<T>
  notNull?: PartialRecordType<keyof T, boolean>
  limit?: number
  offset?: number
}

/**
 * Transaction context type
 * Represents a SQL instance within a transaction
 */
export type TransactionContext = SQL

/**
 * Pagination result metadata
 */
export interface PaginationMeta {
  total: number
  page: number
  pageSize: number
  totalPages: number
  hasNext: boolean
  hasPrevious: boolean
}

/**
 * Paginated result type
 */
export interface PaginatedResult<T> {
  data: T[]
  meta: PaginationMeta
}

/**
 * Validation error details
 */
export interface ValidationErrorDetail {
  field: string
  constraint: string
  message: string
  value?: unknown
}

/**
 * Hook type for lifecycle events
 */
export type HookType
  = | 'beforeInsert'
    | 'afterInsert'
    | 'beforeUpdate'
    | 'afterUpdate'
    | 'beforeDelete'
    | 'afterDelete'
    | 'beforeSave'
    | 'afterSave'

/**
 * Hook metadata
 */
export interface HookMetadata {
  type: HookType
  method: string
}

/**
 * Validation constraint metadata
 */
export interface ValidationMetadata {
  propertyKey: string
  constraints: ValidationConstraint[]
}

/**
 * Individual validation constraint
 */
export interface ValidationConstraint {
  type: string
  options?: Record<string, unknown>
  message?: string
}
