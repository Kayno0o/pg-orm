/**
 * Type definitions re-exports
 * Central location for all ORM types
 */

// Column types
export type {
  ColumnName,
  ColumnValue,
  CreateData,
  DataColumnName,
  DeepPartial,
  EntityData,
  Nullable,
  NullableFields,
  OptionalFields,
  OrderOptions,
  PartialRecord,
  PropertyName,
  RequiredFields,
  RequireFields,
  SelectFields,
  UpdateData,
  WhereConditions,
} from './columns'

export { hasColumn, isColumnName } from './columns'

// SQL types
export type {
  DatabaseRow,
  JoinType,
  OrderDirection,
  QueryBuildResult,
  QueryParameters,
  QueryResult,
  SingleResult,
  SQLClause,
  SQLFragment,
  SQLInstance,
  SQLQueryBindings,
  TransactionCallback,
  WhereOperator,
} from './sql'

export { isSQLFragment } from './sql'
