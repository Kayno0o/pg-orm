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
// Query Builder
// ============================================================================

export { ORM, orm } from './orm'

// ============================================================================
// Traits
// ============================================================================

export { QueryBuilder } from './query'

// ============================================================================
// Types
// ============================================================================

export { Repository, ValidationError } from './repository'

// ============================================================================
// Errors
// ============================================================================

export { createTrait, paranoid, publishable, sluggable, softDelete, sortable, timestamps, uuidPrimary, versionable } from './traits'
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

// ============================================================================
// Migrations
// ============================================================================

export type { ValidationErrorDetail } from './types'
