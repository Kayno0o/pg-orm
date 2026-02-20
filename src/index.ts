// Expression builder
export {
  type AssembledExpr,
  assembleExpr,
  createExprBuilder,
  type ExprBuilder,
  type ExprOp,
  type ExprTape,
  type SubqueryRef,
  type TsQueryRef,
} from './builder/expr'
// Query builders
export {
  assembleQuery,
  DeleteBuilder,
  type IncludeEntry,
  InsertBuilder,
  MergeBuilder,
  OnConflictBuilder,
  SelectBuilder,
  UpdateBuilder,
  UpsertBuilder,
} from './builder/query'
// Errors
export {
  CheckError,
  ConnectionError,
  ConstraintError,
  DestructiveOpError,
  ForeignKeyError,
  MigrationError,
  NotNullError,
  OrmError,
  QueryError,
  TimeoutError,
  UniqueError,
  wrapPgError,
} from './errors/index'
// Hooks
export { hasHooks, runHooks } from './hooks/index'

// JIT Mapper
export { clearMapperCache, compileMapper, getOrCompileMapper, mapChunk, type RowMapper } from './mapper/index'

// Migration
export {
  applyMigration,
  diffSchema,
  generateMigration,
  getMigrationStatus,
  introspectLiveSchema,
  type MigrationFile,
  type MigrationOp,
} from './migration/index'

// Repository
export { Repository } from './repo/index'

export { type ColumnTypes } from './schema/columns'

// Schema
export { defineTable } from './schema/index'

export { createRelationTypes, type RelationTypes } from './schema/relations'

export { sanitizeMigrationName, validateIdentifier, validateTsLanguage } from './schema/validate'

// Prepared statement cache
export { type CacheEntry, PreparedStatementCache } from './sql/cache'

// Execution engine
export {
  Database,
  type DbConfig,
  type Executable,
  SavepointClient,
  SavepointRollback,
  TransactionClient,
  type TransactionOptions,
} from './sql/index'

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
  InferEntity,
  InferInsert,
  InferInsertFromTable,
  InferRelationResult,
  InferSelect,
  InferSelectFromTable,
  InferUpdate,
  InferUpdateFromTable,
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
  VirtualDef,
  WithIncludes,
  WithVirtuals,
} from './types/index'
