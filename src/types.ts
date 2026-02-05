import type { SQL } from 'bun'
import type { QueryBuilder } from './query'

import type { SchemaMetadata } from './schema-metadata'

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
    | 'foreignKey'

export type CustomValidator<T = unknown> = (value: T) => boolean | string | Promise<boolean | string>

export interface ValidatorEntry<T = unknown> {
  validator: CustomValidator<T>
  message: string
}

export interface BaseFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> {
  type: FieldType
  nullable: Nullable
  unique: boolean
  hasDefault: HasDefault
  default?: SQLValue
  columnName?: string
  primary?: boolean
  validators?: ValidatorEntry<unknown>[]
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

export interface ForeignKeyFieldConfig<Nullable extends boolean = boolean, HasDefault extends boolean = boolean> extends BaseFieldConfig<Nullable, HasDefault> {
  type: 'foreignKey'
  foreignKey: {
    table: string
    column: string
    onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
    onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
  }
}

export type FieldConfig
  = | StringFieldConfig<boolean, boolean>
    | NumberFieldConfig<boolean, boolean>
    | BooleanFieldConfig<boolean, boolean>
    | JsonFieldConfig<unknown, boolean, boolean>
    | UuidFieldConfig<boolean, boolean>
    | TimestampFieldConfig<boolean, boolean>
    | DateFieldConfig<boolean, boolean>
    | ArrayFieldConfig<'string' | 'number' | 'boolean', boolean, boolean>
    | EnumFieldConfig<readonly string[], boolean, boolean>
    | BlobFieldConfig<boolean, boolean>
    | ForeignKeyFieldConfig<boolean, boolean>

export type EntitySchema = Record<string, FieldConfig>

export interface EntityMetadata {
  tableName: string
  schema: EntitySchema
  unique?: string[][]
}

interface FieldTypeMapping {
  string: string
  number: number
  boolean: boolean
  uuid: string
  timestamp: Date
  date: Date
  blob: Uint8Array
  foreignKey: number
}

type InferArrayType<AT extends 'string' | 'number' | 'boolean'>
  = AT extends 'string' ? string[]
    : AT extends 'number' ? number[]
      : AT extends 'boolean' ? boolean[]
        : never

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

export type MakeNullable<T, Config extends FieldConfig> = Config['nullable'] extends true ? T | null : T

export type InferField<T extends FieldConfig> = MakeNullable<InferFieldType<T>, T>

type IsOptionalField<C extends FieldConfig>
  = C['nullable'] extends true ? true
    : C['hasDefault'] extends true ? true
      : false

type IsRequiredField<C extends FieldConfig> = IsOptionalField<C> extends true ? false : true

// eslint-disable-next-line ts/consistent-type-definitions
type EmptyObject = {}

export type InferEntityBase<T extends EntitySchema> = Prettify<
  ('id' extends keyof T
    ? EmptyObject
    : {
      readonly id: number
    }) & {
      [K in keyof T]: InferField<T[K]>
    }
>

export type InferEntity<T extends EntitySchema, TTraits extends readonly TraitDefinition<any, any>[] = []> = Prettify<
  InferEntityBase<T> & UnionToIntersection<{
    [K in keyof TTraits]: TTraits[K] extends TraitDefinition<any, infer Methods>
      ? ConvertTraitMethods<Methods>
      : never
  }[number]>
>

export type QueryResult<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly [],
> = InferEntity<T, TTraits>

export type InferCreateData<T extends EntitySchema> = Prettify<
  {
    [K in keyof T as IsRequiredField<T[K]> extends true ? K : never]: InferFieldType<T[K]>
  } & {
    [K in keyof T as IsOptionalField<T[K]> extends true ? K : never]?: InferField<T[K]>
  }
>

export type InferUpdateData<
  T extends EntitySchema,
> = Prettify<Partial<
  { [K in keyof T]: InferField<T[K]> }
>>

type TupleToUnion<T extends readonly (keyof any)[]> = T[number]

export type InferProjection<
  T extends EntitySchema,
  Fields extends readonly (keyof T | 'id')[],
> = {
  [K in 'id' | keyof T as K extends TupleToUnion<Fields> ? K : never]:
  K extends 'id' ? number : K extends keyof T ? InferField<T[K]> : never
}

export type InferProjectionClean<
  T extends EntitySchema,
  Fields extends readonly (keyof T | 'id')[],
> = Prettify<InferProjection<T, Fields>>

export interface AggregationResult {
  count?: number
  sum?: number
  avg?: number
  min?: number
  max?: number
  [key: string]: number | undefined
}

export type GroupByResult<
  T extends EntitySchema,
  GroupFields extends readonly (keyof T | 'id')[],
> = Prettify<InferProjectionClean<T, GroupFields> & AggregationResult>

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

export interface AnyRepository {
  find: (id: number) => Promise<any>
  findBy: (options: any) => Promise<any[]>
  create: (data: any) => Promise<any>
  update: (id: number, data: any) => Promise<any>
  delete: (id: number) => Promise<void>
  [key: string]: any
}

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
  readonly fields: TFields
  readonly methods: TMethods
  readonly hooks?: Partial<EntityHooks<TFields>>
}

export type InferTraitFields<T> = T extends TraitDefinition<infer Fields, any> ? Fields : never

export type InferTraitMethods<T> = T extends TraitDefinition<any, infer Methods> ? Methods : never

export type ConvertTraitMethod<M> = M extends (this: infer This, repo: any, ...args: infer Args) => infer Return
  ? (this: This, ...args: Args) => Return
  : never

export type ConvertTraitMethods<TMethods extends TraitMethods> = {
  [K in keyof TMethods]: ConvertTraitMethod<TMethods[K]>
}

// Scope function that takes a query builder and returns it (with added filters)
export type ScopeDefinition<T extends EntitySchema> = (query: QueryBuilder<T, any, any>) => QueryBuilder<T, any, any>

export interface EntityDefinition<
  T extends EntitySchema,
  TTraits extends readonly TraitDefinition<any, any>[] = readonly TraitDefinition<any, any>[],
  _TScopes extends string = string,
> {
  readonly tableName: string
  readonly schema: T
  readonly hooks: EntityHooks<T>
  readonly traits: TTraits
  readonly unique?: string[][]
  readonly scopes: Map<string, ScopeDefinition<T>>
  readonly metadata: SchemaMetadata<T>
}

export type UnionToIntersection<U> = (U extends any ? (k: U) => void : never) extends (k: infer I) => void ? I : never

export type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

export type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K]
}

export type NonNullable<T> = T extends null | undefined ? never : T

export type IsRequired<T extends FieldConfig> = T['nullable'] extends true
  ? false
  : T['hasDefault'] extends true
    ? false
    : true

export type RequiredFieldNames<T extends EntitySchema> = {
  [K in keyof T]: IsRequired<T[K]> extends true ? K : never
}[keyof T]

export type OptionalFieldNames<T extends EntitySchema> = {
  [K in keyof T]: IsRequired<T[K]> extends false ? K : never
}[keyof T]

export interface ValidationErrorDetail {
  field: string
  constraint: string
  message: string
  value?: unknown
}

export function hasColumnName(config: FieldConfig): config is FieldConfig & { columnName: string } {
  return 'columnName' in config && typeof config.columnName === 'string'
}

export function isArrayFieldConfig(config: FieldConfig): config is ArrayFieldConfig {
  return config.type === 'array'
}

export function hasForeignKey(config: FieldConfig): config is NumberFieldConfig & { foreignKey: NonNullable<NumberFieldConfig['foreignKey']> } {
  return config.type === 'number' && 'foreignKey' in config && config.foreignKey !== undefined
}
