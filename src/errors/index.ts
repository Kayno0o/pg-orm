/**
 * Base error for all ORM errors. All typed errors extend this class.
 * Wraps the original driver error in `cause` for inspection.
 */
export class OrmError extends Error {
  override readonly cause: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'OrmError'
    this.cause = cause
  }
}

/** Query execution error. Contains the SQL and params (redacted in production). */
export class QueryError extends OrmError {
  readonly query: string
  readonly params: unknown[]
  constructor(message: string, query: string, params: unknown[], cause?: unknown) {
    super(sanitizeMessage(message), cause)
    this.name = 'QueryError'
    this.query = shouldRedact() ? '[REDACTED]' : query
    this.params = shouldRedact() ? [] : params
  }
}

/** Connection error (PG codes 08xxx, 57P01). Indicates network or server issues. */
export class ConnectionError extends OrmError {
  constructor(message: string, cause?: unknown) {
    super(sanitizeMessage(message), cause)
    this.name = 'ConnectionError'
  }
}

export class TimeoutError extends OrmError {
  constructor(message: string, cause?: unknown) {
    super(sanitizeMessage(message), cause)
    this.name = 'TimeoutError'
  }
}

export interface ConstraintInfo {
  constraint: string
  table: string
  column?: string
  referencedTable?: string
}

export class ConstraintError extends QueryError {
  readonly constraint: string
  readonly table: string
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'ConstraintError'
    this.constraint = info.constraint
    this.table = info.table
  }
}

/** Unique constraint violation (PG code 23505). */
export class UniqueError extends ConstraintError {
  readonly column: string
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, info, cause)
    this.name = 'UniqueError'
    this.column = info.column ?? ''
  }
}

/** Foreign key violation (PG code 23503). */
export class ForeignKeyError extends ConstraintError {
  readonly referencedTable: string
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, info, cause)
    this.name = 'ForeignKeyError'
    this.referencedTable = info.referencedTable ?? ''
  }
}

/** NOT NULL violation (PG code 23502). */
export class NotNullError extends ConstraintError {
  readonly column: string
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, info, cause)
    this.name = 'NotNullError'
    this.column = info.column ?? ''
  }
}

export class CheckError extends ConstraintError {
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, info, cause)
    this.name = 'CheckError'
  }
}

/** Deadlock detected (PG code 40P01). Can be retried. */
export class DeadlockError extends QueryError {
  constructor(message: string, query: string, params: unknown[], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'DeadlockError'
  }
}

export class MigrationError extends OrmError {
  readonly phase: 'diff' | 'apply' | 'validate'
  readonly migration?: string
  constructor(message: string, phase: 'diff' | 'apply' | 'validate', migration?: string, cause?: unknown) {
    super(message, cause)
    this.name = 'MigrationError'
    this.phase = phase
    this.migration = migration
  }
}

export class DestructiveOpError extends MigrationError {
  readonly ops: string[]
  constructor(message: string, phase: 'diff' | 'apply' | 'validate', ops: string[], migration?: string, cause?: unknown) {
    super(message, phase, migration, cause)
    this.name = 'DestructiveOpError'
    this.ops = ops
  }
}

/**
 * Thrown when an after-hook (afterInsert, afterUpdate, afterDelete) throws.
 * The mutation was already committed — `committed: true` signals this to callers.
 */
export class AfterHookError extends OrmError {
  readonly committed = true
  readonly table: string
  readonly hook: string
  constructor(table: string, hook: string, cause: unknown) {
    super(
      `"${hook}" hook on table "${table}" threw after the mutation was committed. `
      + `The database change was NOT rolled back. ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    )
    this.name = 'AfterHookError'
    this.table = table
    this.hook = hook
  }
}

/** Thrown by `findOneOrThrow()` when no row matches the query. */
export class NotFoundError extends OrmError {
  readonly table: string
  constructor(table: string) {
    super(`No record found in table "${table}"`)
    this.name = 'NotFoundError'
    this.table = table
  }
}

/** Thrown by `updateWithLock()` when the row version doesn't match (optimistic lock failure). */
export class StaleRecordError extends OrmError {
  readonly table: string
  readonly version: unknown
  constructor(table: string, version: number) {
    super(`Stale record: expected version ${version} on table "${table}" but row was updated by another process`)
    this.name = 'StaleRecordError'
    this.table = table
    this.version = version
  }
}

function shouldRedact(): boolean {
  if (process.env.REDACT_QUERY_LOGS === '0')
    return false

  if (process.env.REDACT_QUERY_LOGS === '1')
    return true

  return isProduction()
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// 3e + 2f: In production or when REDACT is enabled, strip raw PG error messages
// which may contain data values from constraint errors (e.g., "Key (email)=(admin@example.com)
// already exists"). Structured fields (constraint, column, table) are preserved.
function sanitizeMessage(message: string): string {
  if (shouldRedact())
    return '[REDACTED]'

  if (isProduction()) {
    // Strip PG "Detail:" lines that contain actual data values
    return message.replace(/\bDetail:.*$/gm, 'Detail: [redacted in production]')
  }

  return message
}

// Parse PG error codes into typed constraint errors
// PG error codes: 23505 = unique_violation, 23503 = foreign_key_violation,
// 23502 = not_null_violation, 23514 = check_violation
export function wrapPgError(err: unknown, query: string, params: unknown[]): OrmError {
  if (!(err instanceof Error))
    return new OrmError(String(err), err)

  const pgErr = err as Error & {
    code?: string
    errno?: string
    constraint_name?: string
    constraint?: string
    table_name?: string
    table?: string
    column_name?: string
    column?: string
    detail?: string
    schema?: string
  }

  const code = pgErr.errno ?? pgErr.code
  const constraint = pgErr.constraint_name ?? pgErr.constraint ?? ''
  const table = pgErr.table_name ?? pgErr.table ?? ''
  const column = pgErr.column_name ?? pgErr.column ?? ''

  switch (code) {
    case '23505': // unique_violation
      return new UniqueError(pgErr.message, query, params, { constraint, table, column }, err)
    case '23503': // foreign_key_violation
      return new ForeignKeyError(pgErr.message, query, params, { constraint, table, referencedTable: extractReferencedTable(pgErr.detail ?? '') }, err)
    case '23502': // not_null_violation
      return new NotNullError(pgErr.message, query, params, { constraint, table, column }, err)
    case '23514': // check_violation
      return new CheckError(pgErr.message, query, params, { constraint, table }, err)
    case '40P01': // deadlock_detected
      return new DeadlockError(pgErr.message, query, params, err)
    default:
      if (code?.startsWith('08') || code === '57P01') {
        return new ConnectionError(pgErr.message, err)
      }

      if (code === '57014') {
        return new TimeoutError(pgErr.message, err)
      }

      return new QueryError(pgErr.message, query, params, err)
  }
}

function extractReferencedTable(detail: string): string {
  const match = detail.match(/table "(\w+)"/)

  return match?.[1] ?? ''
}
