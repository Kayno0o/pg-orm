// Expression builder
export {
  type AggResult,
  type AssembledExpr,
  createExprBuilder,
  type ExprBuilder,
  type ExprOp,
  type ExprTape,
  type SubqueryRef,
  type TsQueryRef,
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
  type RawExpr,
  rawExpr,
  SelectBuilder,
  SetOperationBuilder,
  UpdateBuilder,
  UpsertBuilder,
  type WhereFn,
  type WhereInput,
  type WhereObject,
  type WhereOps,
} from './builder/query'
// Config
export { defineConfig, type PgOrmConfig } from './define-config'
// Errors
export {
  AfterHookError,
  BeforeHookError,
  CheckError,
  ConnectionError,
  ConstraintError,
  DataError,
  DeadlockError,
  DestructiveOpError,
  ForeignKeyError,
  isRetryable,
  MigrationError,
  NotFoundError,
  NotNullError,
  OrmError,
  QueryError,
  ResourceError,
  type RetryableError,
  sanitizePgErrorMessage,
  SerializationError,
  setParamRedactor,
  StaleRecordError,
  TimeoutError,
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
  type PaginateCursorOptions,
  type PaginateCursorResult,
  type PaginateOptions,
  type PaginateResult,
  type TrashedOptions,
} from './repo/read-pipeline'

export { type UpsertUpdate } from './repo/write-pipeline'

export { type ColumnTypes } from './schema/column-types'

// Schema
export { defineTable, isTableDef } from './schema/index'

// Schema introspection — typed access to trait metadata and column types.
export {
  columnBaseType,
  hasTrait,
  type TableMeta,
  tableMeta,
  traitColumns,
  writableColumns,
} from './schema/inspect'

export { createRelationTypes, type RelationTypes } from './schema/relations'

// Execution engine
export {
  Database,
  type DbConfig,
  type Executable,
  formatQuery,
  type FormatQueryOptions,
  type JsonParam,
  jsonParam,
  type QueryErrorEvent,
  type QueryEvent,
  SavepointClient,
  SavepointRollback,
  type SlowQueryEvent,
  TransactionClient,
  type TransactionOptions,
} from './sql/index'

// Testing: a database of its own per test file, copied from one migrated and seeded once
export { type TestDatabase, testDatabase, type TestDatabaseOptions } from './testing/test-database'

// Traits
export { optimisticLock, softDelete, timestamps, type Trait } from './traits/index'

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
  HookEvent,
  HookHandler,
  HookRegistry,
  IndexDef,
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
  IsGenerated,
  IsNullable,
  IsPrimaryKey,
  NoDefault,
  NotGenerated,
  NotNullable,
  NotPrimaryKey,
  RelationDef,
  RelationKind,
  TableDef,
  UpdateOptions,
  VirtualDef,
  WithIncludes,
  WithVirtuals,
  WriteReturnOptions,
} from './types/index'
