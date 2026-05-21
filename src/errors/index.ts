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

/**
 * Optional global param redactor. Set via `setParamRedactor()` (typically wired
 * from `DbConfig.redactParams`) to scrub sensitive values from `QueryError.params`
 * even outside production. Receives the raw param array and returns the scrubbed copy.
 *
 * **The redactor MUST NOT throw.** If it does, the QueryError construction
 * propagates the exception — this is intentional. Silently swallowing redactor
 * bugs hides programming errors and makes the resulting `params: []` look
 * indistinguishable from a deliberate "no params" case, which historically led
 * to debugging black holes. Validate inputs inside your redactor and prefer
 * returning sanitized copies over throwing.
 */
type ParamRedactor = (params: unknown[]) => unknown[]
let paramRedactor: ParamRedactor | undefined

export function setParamRedactor(fn: ParamRedactor | undefined): void {
  paramRedactor = fn
}

/** Query execution error. Contains the SQL and params (redacted in production). */
export class QueryError extends OrmError {
  readonly query: string
  readonly params: unknown[]
  constructor(message: string, query: string, params: unknown[], cause?: unknown) {
    super(sanitizeMessage(message), cause)
    this.name = 'QueryError'
    this.query = shouldRedact() ? '[REDACTED]' : query

    if (shouldRedact()) {
      this.params = []
    }
    else if (paramRedactor) {
      // Intentionally NOT wrapped in try/catch: a throwing redactor is a
      // programming bug in the caller's code, and silently dropping params
      // masks it. See the ParamRedactor type doc above.
      this.params = paramRedactor(params)
    }
    else {
      this.params = params
    }
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

/**
 * Marker interface for errors that callers can safely retry after backoff
 * (deadlocks, serialization failures). Use `isRetryable(err)` to test.
 */
export interface RetryableError {
  readonly retryable: true
}

export function isRetryable(err: unknown): err is RetryableError {
  return typeof err === 'object' && err !== null && (err as RetryableError).retryable === true
}

/** Deadlock detected (PG code 40P01). Can be retried. */
export class DeadlockError extends QueryError implements RetryableError {
  readonly retryable = true as const
  constructor(message: string, query: string, params: unknown[], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'DeadlockError'
  }
}

/** Serialization failure (PG code 40001). Common in SERIALIZABLE transactions; safe to retry. */
export class SerializationError extends QueryError implements RetryableError {
  readonly retryable = true as const
  constructor(message: string, query: string, params: unknown[], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'SerializationError'
  }
}

/**
 * Server resource exhaustion (PG codes 53xxx: too_many_connections,
 * configuration_limit_exceeded, etc.). Retry only after backoff and only if
 * the limit is expected to clear.
 */
export class ResourceError extends OrmError {
  readonly code: string
  constructor(message: string, code: string, cause?: unknown) {
    super(sanitizeMessage(message), cause)
    this.name = 'ResourceError'
    this.code = code
  }
}

/** Data type / encoding error (PG code 22xxx, e.g. invalid_text_representation). */
export class DataError extends QueryError {
  readonly code: string
  constructor(message: string, code: string, query: string, params: unknown[], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'DataError'
    this.code = code
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

/**
 * Thrown when a value, identifier, or argument fails ORM-side validation
 * (before any SQL reaches the driver). Examples: invalid identifier characters,
 * non-finite numbers in insert/update payloads, unsafe `stringAgg` delimiter,
 * unbalanced `e.raw()` placeholders, unknown isolation level, raw-SQL fragment
 * containing `;`/`--`/`/*`.
 */
export class ValidationError extends OrmError {
  readonly context: string
  readonly field?: string
  readonly value?: unknown
  constructor(message: string, context: string, opts?: { field?: string, value?: unknown, cause?: unknown }) {
    super(message, opts?.cause)
    this.name = 'ValidationError'
    this.context = context
    this.field = opts?.field
    this.value = opts?.value
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

  // bun:sql emits client-side error codes (string-prefixed) for transport-level
  // failures. "ERR_POSTGRES_CONNECTION_CLOSED" is the dropped-connection case we
  // hit in CI when the server-side PG closes idle sockets — surface it as a
  // ConnectionError so the Database retry path catches it.
  if (pgErr.code === 'ERR_POSTGRES_CONNECTION_CLOSED') {
    return new ConnectionError(pgErr.message, err)
  }

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
    case '40001': // serialization_failure
      return new SerializationError(pgErr.message, query, params, err)
    default:
      if (code?.startsWith('08') || code === '57P01') {
        return new ConnectionError(pgErr.message, err)
      }

      if (code === '57014') {
        return new TimeoutError(pgErr.message, err)
      }

      if (code?.startsWith('53')) {
        return new ResourceError(pgErr.message, code, err)
      }

      if (code?.startsWith('22')) {
        return new DataError(pgErr.message, code, query, params, err)
      }

      return new QueryError(pgErr.message, query, params, err)
  }
}

const TABLE_NAME_RE = /table "(\w+)"/

function extractReferencedTable(detail: string): string {
  const match = detail.match(TABLE_NAME_RE)

  return match?.[1] ?? ''
}
