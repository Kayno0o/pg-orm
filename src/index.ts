export { closeDB, getDB, getRepository, initDB, transaction } from './db'

export {
  ArrayColumn,
  Column,
  CreatedAt,
  Entity,
  EnumColumn,
  JsonColumn,
  SoftDelete,
  TimestampColumn,
  UpdatedAt,
  UuidColumn,
} from './decorators'

export type { ColumnOptions, EntityOptions } from './decorators'

export { AbstractEntity } from './entity'

export {
  DatabaseError,
  EntityNotFoundError,
  OptimisticLockError,
  QueryError,
  ValidationError,
} from './errors'

export {
  getAllEntities,
  getColumnMetadata,
  getColumnMetadataByKey,
  getEntityMetadata,
  mapColumnTypeToPostgres,
} from './metadata'

export type { ColumnMetadata, EntityMetadata } from './metadata'

export {
  compose,
  createMixin,
  withParanoid,
  withScopes,
  withSoftDelete,
  withTimestamps,
} from './mixins'

export { QueryBuilder, queryBuilder } from './queryBuilder'

export { AbstractRepository } from './repository'

export type {
  DBField,
  HookMetadata,
  HookType,
  Identifiable,
  PaginatedResult,
  PaginationMeta,
  PartialRecord,
  QueryOptions,
  SQLQueryBindings,
  TransactionContext,
  ValidationConstraint,
  ValidationErrorDetail,
  ValidationMetadata,
} from './types'

export type {
  ColumnName,
  CreateData,
  DatabaseRow,
  DataColumnName,
  EntityData,
  OrderOptions,
  PropertyName,
  SelectFields,
  SQLFragment,
  SQLInstance,
  UpdateData,
  WhereConditions,
} from './types/'
