import type { SQL } from 'bun'

// ============================================================================
// Core Database Types
// ============================================================================

export type SQLValue
  = | string
    | number
    | boolean
    | null
    | undefined
    | Date
    | Uint8Array
    | SQLValue[]
    | { [key: string]: SQLValue }

export type DatabaseRow = Record<string, unknown>
export type SQLInstance = SQL

// ============================================================================
// Field Type System
// ============================================================================

export type FieldType
  = | 'string'
    | 'number'
    | 'boolean'
    | 'json'
    | 'jsonb'
    | 'uuid'
    | 'timestamp'
    | 'date'
    | 'array'
    | 'enum'
    | 'blob'

export interface BaseFieldConfig {
  type: FieldType
  nullable: boolean
  unique: boolean
  default?: SQLValue
  columnName?: string
  primary?: boolean
}

export interface StringFieldConfig extends BaseFieldConfig {
  type: 'string'
  maxLength?: number
  minLength?: number
}

export interface NumberFieldConfig extends BaseFieldConfig {
  type: 'number'
  min?: number
  max?: number
  integer?: boolean
}

export interface BooleanFieldConfig extends BaseFieldConfig {
  type: 'boolean'
}

export interface JsonFieldConfig<T = unknown> extends BaseFieldConfig {
  type: 'json' | 'jsonb'
  schema?: T
}

export interface UuidFieldConfig extends BaseFieldConfig {
  type: 'uuid'
  autoGenerate?: boolean
}

export interface TimestampFieldConfig extends BaseFieldConfig {
  type: 'timestamp'
  autoUpdate?: boolean
}

export interface DateFieldConfig extends BaseFieldConfig {
  type: 'date'
}

export interface ArrayFieldConfig<ArrayType extends 'string' | 'number' | 'boolean' = 'string' | 'number' | 'boolean'> extends BaseFieldConfig {
  type: 'array'
  arrayType: ArrayType
}

export interface EnumFieldConfig extends BaseFieldConfig {
  type: 'enum'
  values: readonly string[]
}

export interface BlobFieldConfig extends BaseFieldConfig {
  type: 'blob'
}

export type FieldConfig
  = | StringFieldConfig
    | NumberFieldConfig
    | BooleanFieldConfig
    | JsonFieldConfig
    | UuidFieldConfig
    | TimestampFieldConfig
    | DateFieldConfig
    | ArrayFieldConfig
    | EnumFieldConfig
    | BlobFieldConfig

// ============================================================================
// Entity Schema Types
// ============================================================================

export type EntitySchema = Record<string, FieldConfig>

export interface EntityMetadata {
  tableName: string
  schema: EntitySchema
  unique?: string[][]
}

// ============================================================================
// Type Inference from Schema
// ============================================================================

// Map field config to TypeScript type (base type without null)
export type InferFieldType<T extends FieldConfig> = T extends StringFieldConfig
  ? string
  : T extends NumberFieldConfig
    ? number
    : T extends BooleanFieldConfig
      ? boolean
      : T extends JsonFieldConfig<infer U>
        ? U
        : T extends UuidFieldConfig
          ? string
          : T extends TimestampFieldConfig
            ? Date
            : T extends DateFieldConfig
              ? Date
              : T extends ArrayFieldConfig
                ? T['arrayType'] extends 'string'
                  ? string[]
                  : T['arrayType'] extends 'number'
                    ? number[]
                    : T['arrayType'] extends 'boolean'
                      ? boolean[]
                      : never
                : T extends EnumFieldConfig
                  ? T['values'][number]
                  : T extends BlobFieldConfig
                    ? Uint8Array
                    : never

// Make nullable if field is nullable
export type MakeNullable<T, Config extends FieldConfig> = Config['nullable'] extends true ? T | null : T

// Infer complete field type with nullability (for entity types)
export type InferField<T extends FieldConfig> = MakeNullable<InferFieldType<T>, T>

// Infer entity type from schema
export type InferEntity<T extends EntitySchema> = Prettify<{
  readonly id: number
} & {
  [K in keyof T]: InferField<T[K]>
}>

// Helper: Check if field has a default value
type HasDefault<T extends FieldConfig> = T['default'] extends undefined ? false : true

// Create data (without id, required fields are non-nullable, optional/nullable fields are optional)
export type InferCreateData<T extends EntitySchema> = Prettify<
  {
    // Required fields: not nullable AND no default
    [K in keyof T as T[K]['nullable'] extends true
      ? never
      : HasDefault<T[K]> extends true
        ? never
        : K]: InferFieldType<T[K]>
  } & {
    // Optional fields: nullable OR has default
    [K in keyof T as T[K]['nullable'] extends true
      ? K
      : HasDefault<T[K]> extends true
        ? K
        : never]?: InferField<T[K]>
  }
>

// Update data (all fields optional, preserve nullability)
export type InferUpdateData<T extends EntitySchema> = Prettify<Partial<{
  [K in keyof T]: InferField<T[K]>
}>>

// ============================================================================
// Query Types
// ============================================================================

export type WhereOperator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'ILIKE' | 'IN' | 'NOT IN'

export type WhereValue<T> = T | T[] | null

export type WhereCondition<T extends EntitySchema> = {
  [K in keyof T]?:
    | InferField<T[K]>
    | InferField<T[K]>[]
    | {
      eq?: InferField<T[K]>
      ne?: InferField<T[K]>
      gt?: InferFieldType<T[K]>
      gte?: InferFieldType<T[K]>
      lt?: InferFieldType<T[K]>
      lte?: InferFieldType<T[K]>
      in?: InferFieldType<T[K]>[]
      notIn?: InferFieldType<T[K]>[]
      like?: string
      ilike?: string
      isNull?: boolean
      isNotNull?: boolean
      contains?: InferField<T[K]> extends (infer U)[] ? U : never
      overlaps?: InferField<T[K]> extends (infer U)[] ? U[] : never
    }
}

export type OrderDirection = 'ASC' | 'DESC'

export type OrderBy<T extends EntitySchema> = {
  [K in keyof T]?: OrderDirection
}

export interface QueryOptions<T extends EntitySchema> {
  where?: WhereCondition<T>
  order?: OrderBy<T>
  limit?: number
  offset?: number
}

export interface PaginationResult<T> {
  data: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

// ============================================================================
// Hook Types
// ============================================================================

export type BeforeCreateHook<T extends EntitySchema> = (data: InferCreateData<T>) => void | Promise<void>

export type AfterCreateHook<T extends EntitySchema> = (entity: InferEntity<T>) => void | Promise<void>

export type BeforeUpdateHook<T extends EntitySchema> = (id: number, data: InferUpdateData<T>) => void | Promise<void>

export type AfterUpdateHook<T extends EntitySchema> = (entity: InferEntity<T>) => void | Promise<void>

export type BeforeDeleteHook<_T extends EntitySchema> = (id: number) => void | Promise<void>

export type AfterDeleteHook<_T extends EntitySchema> = (id: number) => void | Promise<void>

export interface EntityHooks<T extends EntitySchema> {
  beforeCreate: BeforeCreateHook<T>[]
  afterCreate: AfterCreateHook<T>[]
  beforeUpdate: BeforeUpdateHook<T>[]
  afterUpdate: AfterUpdateHook<T>[]
  beforeDelete: BeforeDeleteHook<T>[]
  afterDelete: AfterDeleteHook<T>[]
}

// ============================================================================
// Trait Types
// ============================================================================

export type TraitMethods = Record<string, (this: any, ...args: any[]) => any>

export interface TraitDefinition<Methods extends TraitMethods = TraitMethods> {
  name: string
  fields?: EntitySchema
  methods?: Methods
}

// ============================================================================
// Plugin Types
// ============================================================================

export interface Plugin {
  name: string
  applyToEntity?: <_T extends EntitySchema>(entity: EntityDefinition<_T>) => void
  applyToRepository?: <_T extends EntitySchema>(repository: any) => void
}

// ============================================================================
// Entity Definition (built by EntityBuilder)
// ============================================================================

export interface EntityDefinition<T extends EntitySchema> {
  readonly tableName: string
  readonly schema: T
  readonly hooks: EntityHooks<T>
  readonly traits: TraitDefinition[]
  readonly unique?: string[][]
}

// ============================================================================
// Utility Types
// ============================================================================

// Flatten intersection types for better IDE display
export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

// Deep readonly for immutable structures
export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K]
}

// Extract non-nullable type
export type NonNullable<T> = T extends null | undefined ? never : T

// Check if a field is required
export type IsRequired<T extends FieldConfig> = T['nullable'] extends true
  ? false
  : T['default'] extends undefined
    ? true
    : false

// Get all required field names from schema
export type RequiredFieldNames<T extends EntitySchema> = {
  [K in keyof T]: IsRequired<T[K]> extends true ? K : never
}[keyof T]

// Get all optional field names from schema
export type OptionalFieldNames<T extends EntitySchema> = {
  [K in keyof T]: IsRequired<T[K]> extends false ? K : never
}[keyof T]

// ============================================================================
// Validation Types
// ============================================================================

export interface ValidationErrorDetail {
  field: string
  constraint: string
  message: string
  value?: unknown
}
