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

export interface BaseFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> {
  type: FieldType
  nullable: Nullable
  unique: boolean
  hasDefault: HasDefault
  default?: SQLValue
  columnName?: string
  primary?: boolean
}

export interface StringFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'string'
  maxLength?: number
  minLength?: number
}

export interface NumberFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'number'
  min?: number
  max?: number
  integer?: boolean
  foreignKey?: {
    table: string
    column: string
    onDelete?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
    onUpdate?: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
  }
}

export interface BooleanFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'boolean'
}

export interface JsonFieldConfig<T = unknown, Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'json' | 'jsonb'
  schema?: T
}

export interface UuidFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'uuid'
  autoGenerate?: boolean
}

export interface TimestampFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'timestamp'
  autoUpdate?: boolean
}

export interface DateFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'date'
}

export interface ArrayFieldConfig<ArrayType extends 'string' | 'number' | 'boolean' = 'string' | 'number' | 'boolean', Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'array'
  arrayType: ArrayType
}

export interface EnumFieldConfig<Values extends readonly string[] = readonly string[], Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'enum'
  values: Values
}

export interface BlobFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'blob'
}

export type FieldConfig
  = | StringFieldConfig<any>
    | NumberFieldConfig<any>
    | BooleanFieldConfig<any>
    | JsonFieldConfig<any, any>
    | UuidFieldConfig<any>
    | TimestampFieldConfig<any>
    | DateFieldConfig<any>
    | ArrayFieldConfig<any, any>
    | EnumFieldConfig<any, any>
    | BlobFieldConfig<any>

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

// Type mapping for simple field types
interface FieldTypeMapping {
  string: string
  number: number
  boolean: boolean
  uuid: string
  timestamp: Date
  date: Date
  blob: Uint8Array
}

// Helper for array type inference
type InferArrayType<AT extends 'string' | 'number' | 'boolean'>
  = AT extends 'string' ? string[]
    : AT extends 'number' ? number[]
      : AT extends 'boolean' ? boolean[]
        : never

// Map field config to TypeScript type (base type without null)
export type InferFieldType<T extends FieldConfig>
  = T extends JsonFieldConfig<infer U>
    ? U
    : T extends ArrayFieldConfig<infer AT, any, any>
      ? InferArrayType<AT>
      : T extends EnumFieldConfig<infer Values, any, any>
        ? Values[number]
        : T extends { type: infer Type extends keyof FieldTypeMapping }
          ? FieldTypeMapping[Type]
          : never

// Make nullable if field is nullable (adds both null and undefined for better semantics)
export type MakeNullable<T, Config extends FieldConfig> = Config['nullable'] extends true ? T | null | undefined : T

// Infer complete field type with nullability (for entity types)
export type InferField<T extends FieldConfig> = MakeNullable<InferFieldType<T>, T>

// eslint-disable-next-line ts/consistent-type-definitions, ts/no-empty-object-type
type EmptyObject = {}

// Infer entity type from schema (without trait methods for now)
// If schema defines 'id', use it; otherwise add 'readonly id: number'
export type InferEntityBase<T extends EntitySchema> = Prettify<
  ('id' extends keyof T
    ? EmptyObject
    : {
      readonly id: number
    }) & {
      [K in keyof T]: InferField<T[K]>
    }
>

// Infer entity type with trait methods
export type InferEntity<T extends EntitySchema, TTraits extends readonly TraitDefinition<any, any>[] = []> = Prettify<
  InferEntityBase<T> & UnionToIntersection<{
    [K in keyof TTraits]: TTraits[K] extends TraitDefinition<any, infer Methods>
      ? ConvertTraitMethods<Methods>
      : never
  }[number]>
>

// Create data (without id, required fields are non-nullable, optional/nullable fields are optional)
export type InferCreateData<T extends EntitySchema> = Prettify<
  {
    // Required fields: not nullable AND no default
    [K in keyof T as T[K]['nullable'] extends true
      ? never
      : T[K]['hasDefault'] extends true
        ? never
        : K]: InferFieldType<T[K]>
  } & {
    // Optional fields: nullable OR has default
    [K in keyof T as T[K]['nullable'] extends true
      ? K
      : T[K]['hasDefault'] extends true
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
  id?:
    | number
    | number[]
    | {
      eq?: number
      ne?: number
      gt?: number
      gte?: number
      lt?: number
      lte?: number
      in?: number[]
      notIn?: number[]
    }
} & {
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
  id?: OrderDirection
} & {
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

export interface CursorPaginationResult<T> {
  data: T[]
  nextCursor?: number
  hasMore: boolean
  pageSize: number
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

// Forward declaration for Repository to avoid circular dependency
export interface AnyRepository {
  find: (id: number) => Promise<any>
  findBy: (options: any) => Promise<any[]>
  create: (data: any) => Promise<any>
  update: (id: number, data: any) => Promise<any>
  delete: (id: number) => Promise<void>
  [key: string]: any
}

// Trait method with repository context
// - 'this' is bound to the entity instance
// - 'repo' is the repository instance for database operations
export type TraitMethod<Entity = any, Args extends any[] = any[], Return = any> = (
  this: Entity,
  repo: AnyRepository,
  ...args: Args
) => Return

export type TraitMethods = Record<string, TraitMethod>

export interface TraitDefinition<
  TFields extends EntitySchema = EntitySchema,
  TMethods extends TraitMethods = TraitMethods,
> {
  readonly name: string
  readonly fields: TFields
  readonly methods: TMethods
}

// Helper to extract trait fields from a trait definition
export type InferTraitFields<T> = T extends TraitDefinition<infer Fields, any> ? Fields : never

// Helper to extract trait methods from a trait definition
export type InferTraitMethods<T> = T extends TraitDefinition<any, infer Methods> ? Methods : never

// Helper to convert trait method signatures to entity instance methods
// Removes the 'repo' parameter since it's injected automatically
export type ConvertTraitMethod<M> = M extends (this: infer This, repo: any, ...args: infer Args) => infer Return
  ? (this: This, ...args: Args) => Return
  : never

// Helper to convert all trait methods to entity instance methods
export type ConvertTraitMethods<TMethods extends TraitMethods> = {
  [K in keyof TMethods]: ConvertTraitMethod<TMethods[K]>
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

export interface EntityDefinition<
  T extends EntitySchema,
  TTraits extends readonly TraitDefinition<any, any>[] = readonly TraitDefinition<any, any>[],
> {
  readonly tableName: string
  readonly schema: T
  readonly hooks: EntityHooks<T>
  readonly traits: TTraits
  readonly unique?: string[][]
}

// ============================================================================
// Utility Types
// ============================================================================

// Convert union to intersection
export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never

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
  : T['hasDefault'] extends true
    ? false
    : true

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
