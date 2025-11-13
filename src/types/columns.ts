/**
 * Column type helpers and template literal types
 * Provides type-safe column name extraction and validation
 */

import type { AbstractEntity } from '../entity'

/**
 * Extract column names from entity as string literal type
 * Excludes methods and the 'id' field (handled separately)
 */
export type ColumnName<T> = Extract<
  {
    [K in keyof T]: T[K] extends (...args: never[]) => unknown ? never : K
  }[keyof T],
  string
>

/**
 * Extract all property names from entity including id
 */
export type PropertyName<T> = Extract<keyof T, string>

/**
 * Extract column names excluding methods and save/id
 */
export type DataColumnName<T extends AbstractEntity> = Exclude<
  ColumnName<T>,
  'id' | 'save'
>

/**
 * Partial record for query options
 * Allows specifying a subset of columns
 */
export type PartialRecord<K extends PropertyKey, T> = Partial<Record<K, T>>

/**
 * Column value types
 * Maps TypeScript types to PostgreSQL types
 */
export type ColumnValue
  = | string
    | number
    | boolean
    | null
    | Date
    | Uint8Array
    | unknown[]
    | Record<string, unknown>

/**
 * Create a type that makes specified fields required
 */
export type RequireFields<T, K extends keyof T> = T & Required<Pick<T, K>>

/**
 * Create a type that makes specified fields optional
 */
export type OptionalFields<T, K extends keyof T> = Omit<T, K>
  & Partial<Pick<T, K>>

/**
 * Deep partial type for nested objects
 */
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

/**
 * Nullable type helper
 */
export type Nullable<T> = T | null

/**
 * Non-nullable type helper
 */
export type NonNullable<T> = T extends null | undefined ? never : T

/**
 * Extract nullable fields from entity
 */
export type NullableFields<T> = {
  [K in keyof T]: null extends T[K] ? K : never
}[keyof T]

/**
 * Extract non-nullable fields from entity
 */
export type RequiredFields<T> = {
  [K in keyof T]: null extends T[K] ? never : K
}[keyof T]

/**
 * Create data type for entity (excludes id and save method)
 */
export type EntityData<T extends AbstractEntity> = Omit<T, 'id' | 'save'>

/**
 * Create type for entity creation (all fields except id and save)
 * Nullable fields are optional
 */
export type CreateData<T extends AbstractEntity> = {
  [K in RequiredFields<EntityData<T>>]: T[K]
} & {
  [K in NullableFields<EntityData<T>>]?: T[K]
}

/**
 * Create type for entity update (all fields optional except id)
 */
export type UpdateData<T extends AbstractEntity> = Partial<EntityData<T>>

/**
 * Type for WHERE conditions
 */
export type WhereConditions<T> = {
  [K in ColumnName<T>]?: T[K] | T[K][]
}

/**
 * Type for ORDER BY options
 */
export type OrderOptions<T> = PartialRecord<ColumnName<T>, 'ASC' | 'DESC'>

/**
 * Type for field selection
 */
export type SelectFields<T> = ColumnName<T>[]

/**
 * Type guard to check if value is a column name
 */
export function isColumnName<T extends object>(
  obj: T,
  key: PropertyKey,
): key is ColumnName<T> {
  return (
    typeof key === 'string'
    && key in obj
    && typeof (obj as Record<string, unknown>)[key] !== 'function'
  )
}

/**
 * Type guard to check if object has a specific column
 */
export function hasColumn<T extends object, K extends ColumnName<T>>(
  obj: T,
  column: K,
): obj is T & Record<K, NonNullable<T[K]>> {
  const record = obj as Record<string, unknown>

  return column in obj && record[column] !== null && record[column] !== undefined
}
