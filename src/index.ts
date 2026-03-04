// Expression builder
export {
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
  DeleteBuilder,
  type IncludeCallback,
  type IncludeEntry,
  InsertBuilder,
  MergeBuilder,
  OnConflictBuilder,
  SelectBuilder,
  SetOperationBuilder,
  UpdateBuilder,
  UpsertBuilder,
} from './builder/query'
// Errors
export {
  AfterHookError,
  CheckError,
  ConnectionError,
  ConstraintError,
  DeadlockError,
  DestructiveOpError,
  ForeignKeyError,
  MigrationError,
  NotFoundError,
  NotNullError,
  OrmError,
  QueryError,
  StaleRecordError,
  TimeoutError,
  UniqueError,
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

// Repository
export { Repository } from './repo/index'

export { type ColumnTypes } from './schema/columns'

// Schema
export { defineTable } from './schema/index'

export { createRelationTypes, type RelationTypes } from './schema/relations'

// Execution engine
export {
  Database,
  type DbConfig,
  type Executable,
  type QueryEvent,
  SavepointClient,
  SavepointRollback,
  type SlowQueryEvent,
  TransactionClient,
  type TransactionOptions,
} from './sql/index'

// Traits
export { applyTrait, optimisticLock, softDelete, timestamps, type Trait } from './traits/index'

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
