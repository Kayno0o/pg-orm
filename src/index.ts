// ============================================================================
// Core ORM
// ============================================================================

export { closeDatabase, getDatabase, initializeDatabase, sql, SQL, transaction, type DatabaseConfig } from './db'

// ============================================================================
// Database
// ============================================================================

export { createEntitySchema, EntityBuilder } from './entity'

// ============================================================================
// Field Builders
// ============================================================================

export { DatabaseError, EntityNotFoundError, OptimisticLockError, QueryError } from './errors'
export { field } from './field'

// ============================================================================
// Entity Builder
// ============================================================================

export type {
  ArrayFieldBuilder,
  BlobFieldBuilder,
  BooleanFieldBuilder,
  DateFieldBuilder,
  EnumFieldBuilder,
  JsonFieldBuilder,
  NumberFieldBuilder,
  StringFieldBuilder,
  TimestampFieldBuilder,
  UuidFieldBuilder,
} from './field'

// ============================================================================
// Repository
// ============================================================================

export { ORM, orm } from './orm'

// ============================================================================
// Query Builder
// ============================================================================

export { QueryBuilder } from './query'

// ============================================================================
// Traits
// ============================================================================

export { Repository, ValidationError } from './repository'

// ============================================================================
// Types
// ============================================================================

export { createTrait, paranoid, publishable, sluggable, softDelete, sortable, timestamps, uuidPrimary, versionable } from './traits'

// ============================================================================
// Errors
// ============================================================================

export type {
  AfterCreateHook,
  AfterDeleteHook,
  AfterUpdateHook,
  ArrayFieldConfig,
  BaseFieldConfig,
  BeforeCreateHook,
  BeforeDeleteHook,
  BeforeUpdateHook,
  BlobFieldConfig,
  BooleanFieldConfig,
  DatabaseRow,
  DateFieldConfig,
  EntityDefinition,
  EntityHooks,
  EntityMetadata,
  EntitySchema,
  EnumFieldConfig,
  FieldConfig,
  FieldType,
  InferCreateData,
  InferEntity,
  InferField,
  InferFieldType,
  InferUpdateData,
  JsonFieldConfig,
  NumberFieldConfig,
  OrderBy,
  OrderDirection,
  PaginationResult,
  Plugin,
  QueryOptions,
  SQLInstance,
  SQLValue,
  StringFieldConfig,
  TimestampFieldConfig,
  TraitDefinition,
  TraitMethods,
  UuidFieldConfig,
  WhereCondition,
  WhereOperator,
  WhereValue,
} from './types'
export type { ValidationErrorDetail } from './types'
