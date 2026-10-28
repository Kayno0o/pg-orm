// Expression builder
export {
  type AggResult,
  type AssembledExpr,
  type ColumnRef,
  createExprBuilder,
  type ExprBuilder,
  type ExprOp,
  type ExprTape,
  type RelationTarget,
  type RelationWhere,
  type SubqueryRef,
  type TsQueryRef,
  type TypedExpr,
  type VectorMetric,
  type VectorType,
  type VectorValue,
} from './builder/expr'
// Query builders
export {
  compileWhere,
  type ConflictExprBuilder,
  type ConflictSet,
  type ConflictUpdate,
  type ConflictValue,
  DeleteBuilder,
  type IncludeCallback,
  type IncludeEntry,
  InsertBuilder,
  MergeBuilder,
  OnConflictBuilder,
  type OptionalWhere,
  type OptionalWhereObject,
  type RawExpr,
  rawExpr,
  type RelationAggregateOptions,
  SelectBuilder,
  SetOperationBuilder,
  type SetValues,
  UpdateBuilder,
  whereColumn,
  type WhereFn,
  type WhereInput,
  type WhereObject,
  type WhereOps,
} from './builder/query'

export type { VectorSearchOptions } from './builder/vector-search'
// Config
export { defineConfig, type PgOrmConfig } from './define-config'
export { type Dialect } from './dialect'
// Errors
export {
  AbortError,
  AfterHookError,
  AuthenticationError,
  BeforeHookError,
  CheckError,
  ConnectionError,
  ConstraintError,
  DataError,
  DeadlockError,
  DestructiveOpError,
  DialectError,
  ExclusionError,
  ForeignKeyError,
  InvalidQueryError,
  isRetryable,
  MigrationError,
  MultipleRowsError,
  NotFoundError,
  NotNullError,
  OrmError,
  QueryError,
  ResourceError,
  type RetryableError,
  sanitizePgErrorMessage,
  SerializationError,
  StaleRecordError,
  TimeoutError,
  TransactionAbortedError,
  UniqueError,
  ValidationError,
} from './errors/index'
// Hooks
export { hasHooks, runHooks, runHooksAsync } from './hooks/index'

// JIT Mapper
export { type RowMapper } from './mapper/index'

// Migration
export {
  applyMigration,
  diffSchema,
  ensureMigrationTable,
  generateMigration,
  getMigrationHistory,
  getMigrationStatus,
  introspectLiveSchema,
  type MigrationFile,
  type MigrationOp,
  recordMigration,
} from './migration/index'

export { Repository } from './repo/index'
// Repository
export {
  type CopyToOptions,
  type CursorOf,
  type NearestOptions,
  type PaginateCursorOptions,
  type PaginateCursorResult,
  type PaginateOptions,
  type PaginatePage,
  type PaginateResult,
  type StreamCursorOptions,
} from './repo/read-pipeline'

export type { LinkOptions, LinkTarget, SyncResult } from './repo/relation-links'
export { type UpsertUpdate } from './repo/write-pipeline'

export { type ColumnTypes } from './schema/column-types'

// Schema
export { defineTable, isTableDef } from './schema/index'

// Schema introspection — typed access to trait metadata and column types.
export {
  columnBaseType,
  hasTrait,
  isColumn,
  type TableMeta,
  tableMeta,
  tableScopes,
  traitColumns,
  writableColumns,
} from './schema/inspect'

export { createRelationTypes, type RelationTypes } from './schema/relations'

// Execution engine
export {
  type CallbackErrorEvent,
  Database,
  type DbConfig,
  type Executable,
  formatQuery,
  type FormatQueryOptions,
  type JsonParam,
  jsonParam,
  type QueryErrorEvent,
  type QueryEvent,
  type SlowQueryEvent,
  TransactionClient,
  type TransactionOptions,
} from './sql/index'

// Testing: a database of its own per test file, copied from one migrated and seeded once
export { type TestDatabase, testDatabase, type TestDatabaseOptions } from './testing/test-database'

// Traits
export { embedding, type EmbeddingOptions, optimisticLock, softDelete, timestamps, type Trait } from './traits/index'

// Types
export type {
  AnyColumnDef,
  AnyColumns,
  AnyRelationDef,
  AnyRelations,
  AnyTableDef,
  AnyVirtuals,
  ColumnConstraint,
  ColumnDef,
  ColumnNames,
  ColumnType,
  ForeignKeyRef,
  HasDefault,
  HookContext,
  HookEvent,
  HookHandler,
  HookRegistry,
  IndexDef,
  IndexParams,
  InferEntity,
  InferInsert,
  InferInsertFromTable,
  InferPrimaryKey,
  InferRelationResult,
  InferSelect,
  InferSelectFromTable,
  InferUpdate,
  InferUpdateById,
  InferUpdateFromTable,
  InferVirtuals,
  InferWhere,
  InsertOptions,
  IsGenerated,
  IsNullable,
  IsPrimaryKey,
  NoDefault,
  NotGenerated,
  NotNullable,
  NotPrimaryKey,
  RelationDef,
  RelationKind,
  Scope,
  ScopeContext,
  ScopedWriteOptions,
  ScopeOptions,
  SingleRowOptions,
  TableDef,
  UpdateOptions,
  VirtualDef,
  WithIncludes,
  WithVirtuals,
  WriteReturnOptions,
} from './types/index'
