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
 * outside production. Receives the raw param array and returns the scrubbed copy.
 *
 * **The redactor MUST NOT throw.** If it does, the QueryError construction
 * propagates the exception — this is intentional. Silently swallowing redactor
 * bugs hides programming errors and makes the resulting `params: []` look
 * indistinguishable from a deliberate "no params" case, which historically led
 * to debugging black holes. Validate inputs inside your redactor and prefer
 * returning sanitized copies over throwing.
 *
 * **Default behavior (no redactor set):** params are replaced with `'[REDACTED]'`
 * placeholders. To recover raw params during local debugging, set the env
 * `REDACT_QUERY_LOGS=0` or supply an identity redactor: `redactParams: p => p`.
 * The safe default prevents accidental data leaks in shared logs (Sentry,
 * stdout aggregators) when callers forget to wire a redactor.
 */
type ParamRedactor = (params: unknown[]) => unknown[]
let paramRedactor: ParamRedactor | undefined

const DEFAULT_PARAM_REDACTOR: ParamRedactor = params => params.map(() => '[REDACTED]')

export function setParamRedactor(fn: ParamRedactor | undefined): void {
  paramRedactor = fn
}

/**
 * True when SQL and params must never be rendered into logs — i.e.
 * `NODE_ENV=production` (unless `REDACT_QUERY_LOGS=0`) or `REDACT_QUERY_LOGS=1`.
 * Query-log formatting (`formatQuery`) and the `debug` config flag both honour this.
 */
export function queryLogsRedacted(): boolean {
  return shouldRedact()
}

/** Params as a query log shows them outside hard-redact mode: through the configured `redactParams`, unless `REDACT_QUERY_LOGS=0` asks for them raw. */
export function logParams(params: unknown[]): unknown[] {
  return paramRedactor && !rawRequested() ? paramRedactor(params) : params
}

/**
 * Query execution error. Contains the SQL and params.
 *
 * Redaction modes:
 * - `NODE_ENV=production` or `REDACT_QUERY_LOGS=1`: hard-redact (`query = '[REDACTED]'`, `params = []`).
 * - `REDACT_QUERY_LOGS=0`: opt-in to raw — params/query preserved verbatim regardless of redactor, in production too.
 * - Otherwise: use the registered `paramRedactor` if any; else the safe default that scrubs each value.
 */
export class QueryError extends OrmError {
  readonly query: string
  readonly params: unknown[]
  constructor(message: string, query: string, params: unknown[], cause?: unknown) {
    super(sanitizeMessage(message), cause)
    this.name = 'QueryError'

    const hardRedact = shouldRedact()

    this.query = hardRedact ? '[REDACTED]' : query

    if (hardRedact) {
      this.params = []
    }
    else if (rawRequested()) {
      this.params = params
    }
    else if (paramRedactor) {
      // Intentionally NOT wrapped in try/catch: a throwing redactor is a
      // programming bug in the caller's code, and silently dropping params
      // masks it. See the ParamRedactor type doc above.
      this.params = paramRedactor(params)
    }
    else {
      this.params = DEFAULT_PARAM_REDACTOR(params)
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
 * Thrown when a before-hook (beforeInsert, beforeUpdate, beforeDelete, beforeUpsert)
 * throws. The mutation was aborted — `committed: false` signals this to callers.
 * Symmetric counterpart to {@link AfterHookError}.
 */
export class BeforeHookError extends OrmError {
  readonly committed = false
  readonly table: string
  readonly hook: string
  constructor(table: string, hook: string, cause: unknown) {
    super(
      `"${hook}" hook on table "${table}" threw before the mutation was applied. `
      + `The database change was NOT performed. ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    )
    this.name = 'BeforeHookError'
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
    this.value = shouldRedact() && opts?.value !== undefined ? '[REDACTED]' : opts?.value
  }
}

/** Thrown before any SQL is sent when a feature has no equivalent in the database's dialect: array operators, `DISTINCT ON`, `MERGE` or row locks on SQLite. */
export class DialectError extends OrmError {
  readonly feature: string
  readonly dialect: string
  constructor(feature: string, dialect: string) {
    super(`${feature} is not supported on ${dialect === 'sqlite' ? 'SQLite' : dialect}`)
    this.name = 'DialectError'
    this.feature = feature
    this.dialect = dialect
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

/** Thrown by `updateOne()`/`deleteOne()` with `onMany: 'throw'` when the WHERE matches more than one row: nothing was changed. */
export class MultipleRowsError extends OrmError {
  readonly table: string
  readonly operation: string
  constructor(table: string, operation: string) {
    super(`${operation}() matched more than one row in "${table}"; nothing was changed`)
    this.name = 'MultipleRowsError'
    this.table = table
    this.operation = operation
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

function shouldHardRedact(): boolean {
  return process.env.REDACT_QUERY_LOGS === '1'
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

// Full redact only when REDACT_QUERY_LOGS=1. In production, sanitize data values
// (strip Key (col)=(val) and Detail: lines) but keep the error structure visible.
function sanitizeMessage(message: string): string {
  if (shouldHardRedact())
    return '[REDACTED]'

  if (isProduction())
    return sanitizePgErrorMessage(message)

  return message
}

function rawRequested(): boolean {
  return process.env.REDACT_QUERY_LOGS === '0'
}

function shouldRedact(): boolean {
  return shouldHardRedact() || (isProduction() && !rawRequested())
}

// A key's value runs to the end of the line: it may itself hold `)`, and an exclusion conflict names a second key after it.
const PG_KEY_VALUE_RE = /Key \(((?:[^)]|\)(?!=\())*)\)=\(.*$/gm
const PG_DETAIL_LINE_RE = /\bDetail:.*$/gm
// Input Postgres quotes back in a data exception: `invalid input syntax for type uuid: "x"`, `value "x" is out of range`, `invalid byte sequence for encoding "UTF8": 0x00`.
const PG_TRAILING_INPUT_RE = /: ".*$/gm
const PG_OUT_OF_RANGE_RE = /\bvalue ".*" is out of range/g
const PG_BYTE_SEQUENCE_RE = /(invalid byte sequence for encoding "[^"]*"): .*$/gm

/**
 * Strip data values from a raw PG error message before it becomes a
 * `QueryError.message`. PG emits constraint failures with the offending value
 * inline (e.g. `Key (email)=(alice@example.com) already exists.`), and that
 * message ends up in logs even in development. We replace the value half of
 * `Key (col)=(value)` and the entire `Detail:` line — both habitual carriers
 * of customer data. Structured fields on `ConstraintError` (constraint, table,
 * column) are unaffected and still tell you what failed.
 *
 * Set `REDACT_QUERY_LOGS=0` to opt out (e.g. during local repro).
 */
export function sanitizePgErrorMessage(message: string): string {
  if (process.env.REDACT_QUERY_LOGS === '0')
    return message

  return message
    .replace(PG_KEY_VALUE_RE, (_match, columns: string) => `Key (${columns})=([REDACTED])`)
    .replace(PG_DETAIL_LINE_RE, 'Detail: [redacted]')
    .replace(PG_TRAILING_INPUT_RE, ': "[REDACTED]"')
    .replace(PG_OUT_OF_RANGE_RE, 'value "[REDACTED]" is out of range')
    .replace(PG_BYTE_SEQUENCE_RE, (_match, prefix: string) => `${prefix}: [REDACTED]`)
}

// Driver error fields that name what failed without holding a value: `detail`, `hint`, `where` and `internalQuery` can quote the row.
const SAFE_DRIVER_FIELDS = ['code', 'errno', 'severity', 'schema', 'schema_name', 'table', 'table_name', 'column', 'column_name', 'dataType', 'constraint', 'constraint_name', 'routine'] as const

/** The driver error a typed error keeps as `cause`: as raised outside redaction, else a copy holding only its scrubbed message and the fields that carry no value, so a logger walking the cause chain finds no row data. */
function redactedCause(err: Error): Error {
  if (!shouldRedact())
    return err

  const copy = new Error(sanitizeMessage(err.message))
  const source = err as unknown as Record<string, unknown>
  const target = copy as unknown as Record<string, unknown>

  copy.name = err.name

  for (const field of SAFE_DRIVER_FIELDS) {
    if (source[field] !== undefined)
      target[field] = source[field]
  }

  return copy
}

// Parse PG error codes into typed constraint errors
// PG error codes: 23505 = unique_violation, 23503 = foreign_key_violation,
// 23502 = not_null_violation, 23514 = check_violation
// SQLite's `SQLITE_*` codes map onto the same classes.
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

  const cause = redactedCause(err)

  if (pgErr.code?.startsWith('SQLITE_'))
    return wrapSqliteError(pgErr.code, pgErr.message, cause, query, params)

  const code = pgErr.errno ?? pgErr.code
  const constraint = pgErr.constraint_name ?? pgErr.constraint ?? ''
  const table = pgErr.table_name ?? pgErr.table ?? ''
  const column = pgErr.column_name ?? pgErr.column ?? ''

  // Sanitize the raw PG message ONCE here. Constraint failures embed user data
  // in the message text ("Key (email)=(alice@example.com)"), and that string
  // is what bubbles up to logs as `err.message`. Outside production the raw
  // error is still available on `err.cause` for callers that explicitly need it.
  const safeMessage = sanitizePgErrorMessage(pgErr.message)

  // bun:sql emits client-side error codes (string-prefixed) for transport-level
  // failures. "ERR_POSTGRES_CONNECTION_CLOSED" is the dropped-connection case we
  // hit in CI when the server-side PG closes idle sockets — surface it as a
  // ConnectionError so the Database retry path catches it.
  if (pgErr.code === 'ERR_POSTGRES_CONNECTION_CLOSED') {
    return new ConnectionError(safeMessage, cause)
  }

  switch (code) {
    case '23505': // unique_violation
      return new UniqueError(safeMessage, query, params, { constraint, table, column }, cause)
    case '23503': // foreign_key_violation
      return new ForeignKeyError(safeMessage, query, params, { constraint, table, referencedTable: extractReferencedTable(pgErr.detail ?? '') }, cause)
    case '23502': // not_null_violation
      return new NotNullError(safeMessage, query, params, { constraint, table, column }, cause)
    case '23514': // check_violation
      return new CheckError(safeMessage, query, params, { constraint, table }, cause)
    case '40P01': // deadlock_detected
      return new DeadlockError(safeMessage, query, params, cause)
    case '40001': // serialization_failure
      return new SerializationError(safeMessage, query, params, cause)
    default:
      if (code?.startsWith('08') || code === '57P01') {
        return new ConnectionError(safeMessage, cause)
      }

      if (code === '57014') {
        return new TimeoutError(safeMessage, cause)
      }

      if (code?.startsWith('53')) {
        return new ResourceError(safeMessage, code, cause)
      }

      if (code?.startsWith('22')) {
        return new DataError(safeMessage, code, query, params, cause)
      }

      return new QueryError(safeMessage, query, params, cause)
  }
}

// SQLite names the failing columns as `table.column`, comma separated, after the colon of its constraint message.
const SQLITE_COLUMNS_RE = /constraint failed: (.+)$/
const SQLITE_COLUMN_SEPARATOR = ', '

// SQLite names neither the constraint of a UNIQUE or PRIMARY KEY violation nor the table of a foreign key one: the names given are the ones Postgres gives the same constraint created by pg-orm's DDL, so code testing `err.constraint` holds on both.
function wrapSqliteError(code: string, message: string, err: Error, query: string, params: unknown[]): OrmError {
  const named = message.match(SQLITE_COLUMNS_RE)?.[1] ?? ''
  const columns = named.split(SQLITE_COLUMN_SEPARATOR).map(part => part.split('.'))
  const table = columns[0]?.[0] ?? ''
  const column = columns.map(([, col]) => col ?? '').join('_')

  switch (code) {
    case 'SQLITE_CONSTRAINT_PRIMARYKEY':
      return new UniqueError(message, query, params, { constraint: `${table}_pkey`, table, column }, err)
    case 'SQLITE_CONSTRAINT_UNIQUE':
      return new UniqueError(message, query, params, { constraint: `${table}_${column}_key`, table, column }, err)
    case 'SQLITE_CONSTRAINT_FOREIGNKEY':
      return new ForeignKeyError(message, query, params, { constraint: '', table: '' }, err)
    case 'SQLITE_CONSTRAINT_NOTNULL':
      return new NotNullError(message, query, params, { constraint: '', table, column }, err)
    case 'SQLITE_CONSTRAINT_CHECK':
      return new CheckError(message, query, params, { constraint: named, table: '' }, err)
  }

  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
    return new SerializationError(message, query, params, err)

  if (code.startsWith('SQLITE_CANTOPEN') || code.startsWith('SQLITE_NOTADB'))
    return new ConnectionError(message, err)

  if (code === 'SQLITE_INTERRUPT')
    return new TimeoutError(message, err)

  if (code.startsWith('SQLITE_FULL') || code.startsWith('SQLITE_NOMEM'))
    return new ResourceError(message, code, err)

  if (code === 'SQLITE_MISMATCH' || code === 'SQLITE_TOOBIG' || code === 'SQLITE_RANGE')
    return new DataError(message, code, query, params, err)

  return new QueryError(message, query, params, err)
}

const TABLE_NAME_RE = /table "(\w+)"/

function extractReferencedTable(detail: string): string {
  const match = detail.match(TABLE_NAME_RE)

  return match?.[1] ?? ''
}
