// ============================================================================
// Core ORM
// ============================================================================

export { closeDatabase, type DatabaseConfig, getDatabase, initializeDatabase, sql, SQL, transaction } from './db'

// ============================================================================
// Database
// ============================================================================

export { createEntitySchema, EntityBuilder } from './entity'

// ============================================================================
// Field Builders
// ============================================================================

export { DatabaseError, EntityNotFoundError, OptimisticLockError, QueryError } from './errors'
export { InvalidIdentifierError } from './errors'

// ============================================================================
// Entity Builder
// ============================================================================

export { field } from './field'

// ============================================================================
// Repository
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
// Query Builder
// ============================================================================

export type {
  DatabaseColumn,
  DatabaseConstraint,
  DatabaseIndex,
  DatabaseSchema,
  DatabaseTable,
  Migration,
  MigrationConfig,
  MigrationRecord,
  MigrationRunResult,
  MigrationStatus,
  PostgresType,
  PostgresTypeMapping,
  SchemaChange,
  SchemaChangeType,
  SchemaDiff,
} from './migration/types'

// ============================================================================
// Traits
// ============================================================================

export { ORM, orm } from './orm'

// ============================================================================
// Types
// ============================================================================

export { QueryBuilder } from './query'

// ============================================================================
// Relations
// ============================================================================

export { belongsTo, hasMany, hasOne } from './relations'

// ============================================================================
// Errors
// ============================================================================

export { Repository, ValidationError } from './repository'

// ============================================================================
// Traits
// ============================================================================

export { createTrait, paranoid, publishable, sluggable, softDelete, sortable, timestamps, uuidPrimary, versionable } from './traits'
export type {
  AfterCreateHook,
  AfterDeleteHook,
  AfterUpdateHook,
  AggregationResult,
  ArrayFieldConfig,
  BaseFieldConfig,
  BeforeCreateHook,
  BeforeDeleteHook,
  BeforeUpdateHook,
  BlobFieldConfig,
  BooleanFieldConfig,
  CursorPaginationResult,
  DatabaseRow,
  DateFieldConfig,
  EntityDefinition,
  EntityHooks,
  EntityMetadata,
  EntitySchema,
  EnumFieldConfig,
  FieldConfig,
  FieldType,
  GroupByResult,
  InferCreateData,
  InferEntity,
  InferField,
  InferFieldType,
  InferProjection,
  InferProjectionClean,
  InferUpdateData,
  JsonFieldConfig,
  NumberFieldConfig,
  OrderDirection,
  PaginationResult,
  Plugin,
  SQLInstance,
  SQLValue,
  StringFieldConfig,
  TimestampFieldConfig,
  TraitDefinition,
  TraitMethods,
  UuidFieldConfig,
} from './types'

// ============================================================================
// Migrations
// ============================================================================

export type { ValidationErrorDetail } from './types'
