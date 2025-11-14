import type { SQL } from 'bun'
import type {
  OrderOptions,
  PartialRecord as PartialRecordType,
  WhereConditions,
} from './types/columns'

export type { PartialRecordType as PartialRecord }

export interface Identifiable {
  id: number
}

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

export interface QueryOptions<T> {
  where?: WhereConditions<T>
  order?: OrderOptions<T>
  notNull?: PartialRecordType<keyof T, boolean>
  limit?: number
  offset?: number
}

export type TransactionContext = SQL

export interface PaginationMeta {
  total: number
  page: number
  pageSize: number
  totalPages: number
  hasNext: boolean
  hasPrevious: boolean
}

export interface PaginatedResult<T> {
  data: T[]
  meta: PaginationMeta
}

export interface ValidationErrorDetail {
  field: string
  constraint: string
  message: string
  value?: unknown
}

export type HookType
  = | 'beforeInsert'
    | 'afterInsert'
    | 'beforeUpdate'
    | 'afterUpdate'
    | 'beforeDelete'
    | 'afterDelete'
    | 'beforeSave'
    | 'afterSave'

export interface HookMetadata {
  type: HookType
  method: string
}

export interface ValidationMetadata {
  propertyKey: string
  constraints: ValidationConstraint[]
}

export interface ValidationConstraint {
  type: string
  options?: Record<string, unknown>
  message?: string
}
