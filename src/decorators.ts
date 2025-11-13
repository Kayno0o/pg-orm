import type { ColumnMetadata } from './metadata'
import type { SQLQueryBindings } from './types'
import {
  getColumnMetadata,
  setColumnMetadata,
  setEntityMetadata,
} from './metadata'

type ClassConstructor = abstract new (...args: never[]) => object

export interface EntityOptions {
  unique?: string[][]
}

export interface ColumnOptions {
  nullable?: boolean
  unique?: boolean
  primary?: boolean
  default?: SQLQueryBindings
  name?: string
  reference?: {
    table: string
    key: string
  }
  autoUpdate?: boolean
  enumValues?: string[]
  arrayType?: 'text' | 'int' | 'float'
}

export function Entity(tableName: string, options?: EntityOptions) {
  return function <T extends ClassConstructor>(target: T) {
    const columns = getColumnMetadata(target)

    setEntityMetadata(target, {
      tableName,
      target,
      columns,
      uniqueConstraints: options?.unique,
    })

    return target
  }
}

export function Column(
  type: 'bool' | 'int' | 'float' | 'text' | 'blob' | 'json' | 'jsonb' | 'uuid' | 'timestamp' | 'array' | 'enum',
  options?: ColumnOptions,
) {
  return function (target: object, propertyKey: string) {
    const metadata: ColumnMetadata = {
      propertyKey,
      type,
      nullable: options?.nullable,
      unique: options?.unique,
      primary: options?.primary,
      default: options?.default,
      name: options?.name,
      reference: options?.reference,
      autoUpdate: options?.autoUpdate,
      enumValues: options?.enumValues,
      arrayType: options?.arrayType,
    }

    setColumnMetadata(target.constructor as ClassConstructor, propertyKey, metadata)
  }
}

export function JsonColumn(options?: Omit<ColumnOptions, 'arrayType' | 'enumValues'>) {
  return Column('jsonb', options)
}

export function UuidColumn(options?: Omit<ColumnOptions, 'arrayType' | 'enumValues'>) {
  return Column('uuid', options)
}

export function ArrayColumn(
  arrayType: 'text' | 'int' | 'float',
  options?: Omit<ColumnOptions, 'arrayType' | 'enumValues'>,
) {
  return Column('array', { ...options, arrayType })
}

export function EnumColumn(
  enumValues: string[] | Record<string, string | number>,
  options?: Omit<ColumnOptions, 'arrayType' | 'enumValues'>,
) {
  // Extract values from enum object if needed
  const values = Array.isArray(enumValues)
    ? enumValues
    : Object.values(enumValues).filter(v => typeof v === 'string') as string[]

  return Column('enum', { ...options, enumValues: values })
}

export function TimestampColumn(options?: Omit<ColumnOptions, 'arrayType' | 'enumValues'>) {
  return Column('timestamp', options)
}

export function CreatedAt(options?: Omit<ColumnOptions, 'default' | 'autoUpdate' | 'arrayType' | 'enumValues'>) {
  return Column('timestamp', { ...options, default: 'NOW()' })
}

export function UpdatedAt(options?: Omit<ColumnOptions, 'default' | 'autoUpdate' | 'arrayType' | 'enumValues'>) {
  return Column('timestamp', { ...options, default: 'NOW()', autoUpdate: true })
}

/**
 * Marks an entity as soft deletable
 * Adds a deleted_at timestamp column for soft delete functionality
 * Use with withSoftDelete() mixin on the repository
 */
export function SoftDelete(options?: Omit<ColumnOptions, 'default' | 'autoUpdate' | 'arrayType' | 'enumValues'>) {
  return Column('timestamp', { ...options, nullable: true, default: null })
}
