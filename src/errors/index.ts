import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Base error for all ORM errors. All typed errors extend this class.
 * Wraps the original driver error in `cause` for inspection.
 */
export class OrmError extends Error {
  declare readonly cause: unknown
  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'OrmError'
    // Not enumerable, as `Error.cause` is: `JSON.stringify(err)` or a logger spreading the error would otherwise serialize the driver error and the row values its detail quotes.
    Object.defineProperty(this, 'cause', { value: cause, writable: false, enumerable: false, configurable: true })
  }
}

/**
 * Optional per-Database param redactor, `DbConfig.redactParams`, to scrub sensitive values from `QueryError.params`
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
export type ParamRedactor = (params: unknown[]) => unknown[]

const DEFAULT_PARAM_REDACTOR: ParamRedactor = params => params.map(() => '[REDACTED]')
// The redactor of the Database whose statement is running, which the QueryError it raises applies.
const redactorStorage = new AsyncLocalStorage<ParamRedactor>()

/** @internal */
export function withParamRedactor<T>(redactor: ParamRedactor, fn: () => T): T {
  return redactorStorage.run(redactor, fn)
}

/**
 * True when SQL and params must never be rendered into logs — i.e.
 * `NODE_ENV=production` (unless `REDACT_QUERY_LOGS=0`) or `REDACT_QUERY_LOGS=1`.
 * Query-log formatting (`formatQuery`) and the `debug` config flag both honour this.
 */
export function queryLogsRedacted(): boolean {
  return shouldRedact()
}

/** Params as `QueryError.params` and the query hooks' events carry them: none where query logs are redacted, raw on `REDACT_QUERY_LOGS=0`, else through `redactParams` or, without one, each value scrubbed. */
export function redactedParams(params: unknown[], redactor: ParamRedactor | undefined): unknown[] {
  if (shouldRedact())
    return []

  if (rawRequested())
    return params

  return redactor ? redactor(params) : DEFAULT_PARAM_REDACTOR(params)
}

/** Params as a query log shows them outside hard-redact mode: through the configured `redactParams`, unless `REDACT_QUERY_LOGS=0` asks for them raw. */
export function logParams(params: unknown[], redactor: ParamRedactor | undefined): unknown[] {
  return redactor && !rawRequested() ? redactor(params) : params
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
  /** The table the database named in the error, else the one the statement targets; `''` when neither tells. */
  readonly table: string
  constructor(message: string, query: string, params: unknown[], cause?: unknown, table?: string) {
    super(sanitizeMessage(message), cause)
    this.name = 'QueryError'
    this.table = table ?? statementTable(query)

    this.query = shouldRedact() ? '[REDACTED]' : query
    // A throwing redactor is not caught: it is a bug in the caller's code, which dropping the params would mask. See the ParamRedactor type doc above.
    this.params = redactedParams(params, redactorStorage.getStore())
  }
}

/** Connection error (PG codes 08xxx, 57P01-57P03, and bun:sql's connection closed or timed out). Indicates network or server issues; a read hitting one can be retried. */
export class ConnectionError extends QueryError {
  constructor(message: string, query = '', params: unknown[] = [], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'ConnectionError'
  }
}

/** A statement cancelled for running too long (57014, SQLite's interrupt) or for waiting on a lock (55P03: `lock_timeout` or NOWAIT), told apart by `code`. */
export class TimeoutError extends QueryError {
  readonly code: string
  constructor(message: string, query = '', params: unknown[] = [], cause?: unknown, code = '57014') {
    super(message, query, params, cause)
    this.name = 'TimeoutError'
    this.code = code
  }
}

/** A statement cancelled, or never sent, because the signal bound by `Database.withSignal` aborted; `cause` is the signal's reason. Never retried. */
export class AbortError extends QueryError {
  constructor(query = '', params: unknown[] = [], reason?: unknown) {
    super('Query aborted', query, params, reason)
    this.name = 'AbortError'
  }
}

/** The database refused the credentials (PG codes 28xxx). Not retried: the same credentials fail again. */
export class AuthenticationError extends QueryError {
  readonly code: string
  constructor(message: string, code: string, query = '', params: unknown[] = [], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'AuthenticationError'
    this.code = code
  }
}

/** A statement the database cannot run as written (PG codes 42xxx): a syntax error, an unknown table or column, a missing privilege. */
export class InvalidQueryError extends QueryError {
  readonly code: string
  constructor(message: string, code: string, query: string, params: unknown[], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'InvalidQueryError'
    this.code = code
  }
}

/** A statement sent to a transaction an earlier failure aborted (PG code 25P02): only a rollback, or a rollback to a savepoint, is accepted until then. */
export class TransactionAbortedError extends QueryError {
  constructor(message: string, query: string, params: unknown[], cause?: unknown) {
    super(message, query, params, cause)
    this.name = 'TransactionAbortedError'
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
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, cause, info.table)
    this.name = 'ConstraintError'
    this.constraint = info.constraint
  }
}

/** Unique constraint violation (PG code 23505). `column` names the key's columns, comma separated when it has several. */
export class UniqueError extends ConstraintError {
  readonly column: string
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, info, cause)
    this.name = 'UniqueError'
    this.column = info.column ?? ''
  }
}

/** Foreign key violation (PG codes 23503, 23001 for a RESTRICT one): `table` holds the foreign key, `referencedTable` the rows it points at, whichever side the statement wrote. */
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

/** Exclusion constraint violation (PG code 23P01). */
export class ExclusionError extends ConstraintError {
  constructor(message: string, query: string, params: unknown[], info: ConstraintInfo, cause?: unknown) {
    super(message, query, params, info, cause)
    this.name = 'ExclusionError'
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
export class ResourceError extends QueryError {
  readonly code: string
  constructor(message: string, code: string, query = '', params: unknown[] = [], cause?: unknown) {
    super(message, query, params, cause)
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
 * Strip data values from a raw PG error message before it becomes a `QueryError.message`, in every environment, development included.
 * The value of `Key (col)=(value)`, the input a data exception quotes back (`invalid input syntax for type uuid: "x"`) and the whole `Detail:` line are replaced; structured fields on `ConstraintError` (constraint, table, column) still tell what failed.
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

const BUN_CONNECTION_CODES = new Set(['ERR_POSTGRES_CONNECTION_CLOSED', 'ERR_POSTGRES_CONNECTION_TIMEOUT', 'ERR_POSTGRES_IDLE_TIMEOUT', 'ERR_POSTGRES_LIFETIME_TIMEOUT'])

const DELETE_RE = /^\s*DELETE\b/i
const NOT_NULL_COLUMN_RE = /^null value in column "((?:[^"]|"")+)"/
// An INSERT names the missing parent in the detail; an UPDATE or DELETE of the parent names it in the message.
const NOT_PRESENT_TABLE_RE = /is not present in table "((?:[^"]|"")+)"/
const PARENT_TABLE_RE = /^update or delete on table "((?:[^"]|"")+)"/
const KEY_COLUMNS_RE = /^Key \(((?:[^)]|\)(?!=\())*)\)=\(/
const IDENTIFIER = String.raw`"(?:[^"]|"")+"|[a-z_][\w$]*`
// The table an INSERT, UPDATE, DELETE, MERGE or SELECT names first, past a parenthesized select list for a SELECT.
const STATEMENT_TABLE_RE = new RegExp(String.raw`^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|SELECT\s(?:[^()]|\([^()]*\))*?\sFROM)\s+(?:ONLY\s+)?(?:(?:${IDENTIFIER})\.)?(${IDENTIFIER})`, 'i')

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
  const table = textField(pgErr.table_name ?? pgErr.table) || statementTable(query)
  // bun:sql's `column` is the column name only on a NOT NULL violation; on other errors it reads the JS error's source position.
  const column = textField(pgErr.column_name ?? pgErr.column)
  const detail = pgErr.detail ?? ''

  // Sanitize the raw PG message ONCE here. Constraint failures embed user data
  // in the message text ("Key (email)=(alice@example.com)"), and that string
  // is what bubbles up to logs as `err.message`. Outside production the raw
  // error is still available on `err.cause` for callers that explicitly need it.
  const safeMessage = sanitizePgErrorMessage(pgErr.message)

  // bun:sql's own codes for a connection dropped or timed out before the server answered, which a read can retry.
  if (code && BUN_CONNECTION_CODES.has(code))
    return new ConnectionError(safeMessage, query, params, cause)

  switch (code) {
    case '23505': // unique_violation
      return new UniqueError(safeMessage, query, params, { constraint, table, column: column || keyColumns(detail) }, cause)
    case '23503': // foreign_key_violation
    case '23001': // restrict_violation
      return new ForeignKeyError(safeMessage, query, params, { constraint, table, referencedTable: referencedTable(pgErr.message, detail) }, cause)
    case '23502': // not_null_violation
      return new NotNullError(safeMessage, query, params, { constraint, table, column: column || (pgErr.message.match(NOT_NULL_COLUMN_RE)?.[1] ?? '') }, cause)
    case '23514': // check_violation
      return new CheckError(safeMessage, query, params, { constraint, table }, cause)
    case '23P01': // exclusion_violation
      return new ExclusionError(safeMessage, query, params, { constraint, table }, cause)
    case '25P02': // in_failed_sql_transaction
      return new TransactionAbortedError(safeMessage, query, params, cause)
    case '40P01': // deadlock_detected
      return new DeadlockError(safeMessage, query, params, cause)
    case '40001': // serialization_failure
      return new SerializationError(safeMessage, query, params, cause)
    case '57014': // query_canceled
    case '55P03': // lock_not_available
      return new TimeoutError(safeMessage, query, params, cause, code)
    default:
      if (code?.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03')
        return new ConnectionError(safeMessage, query, params, cause)

      if (code?.startsWith('28'))
        return new AuthenticationError(safeMessage, code, query, params, cause)

      if (code?.startsWith('42'))
        return new InvalidQueryError(safeMessage, code, query, params, cause)

      if (code?.startsWith('53'))
        return new ResourceError(safeMessage, code, query, params, cause)

      if (code?.startsWith('22'))
        return new DataError(safeMessage, code, query, params, cause)

      return new QueryError(safeMessage, query, params, cause, table)
  }
}

function textField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// SQLite names the failing columns as `table.column`, comma separated, after the colon of its constraint message.
const SQLITE_COLUMNS_RE = /constraint failed: (.+)$/
const SQLITE_COLUMN_SEPARATOR = ', '

// SQLite names neither the constraint of a UNIQUE or PRIMARY KEY violation nor the table of a foreign key one: the names given are the ones Postgres gives the same constraint created by pg-orm's DDL, so code testing `err.constraint` holds on both.
function wrapSqliteError(code: string, message: string, err: Error, query: string, params: unknown[]): OrmError {
  const named = message.match(SQLITE_COLUMNS_RE)?.[1] ?? ''
  const columns = named.split(SQLITE_COLUMN_SEPARATOR).map(part => part.split('.'))
  const table = columns[0]?.[0] ?? ''
  const columnNames = columns.map(([, col]) => col ?? '')
  const column = columnNames.join(', ')
  const target = statementTable(query)

  switch (code) {
    case 'SQLITE_CONSTRAINT_PRIMARYKEY':
      return new UniqueError(message, query, params, { constraint: `${table}_pkey`, table, column }, err)
    case 'SQLITE_CONSTRAINT_UNIQUE':
      return new UniqueError(message, query, params, { constraint: `${table}_${columnNames.join('_')}_key`, table, column }, err)
    case 'SQLITE_CONSTRAINT_FOREIGNKEY':
      // SQLite names no table: a DELETE broke a reference to the rows it removed, any other write a reference it holds.
      return DELETE_RE.test(query)
        ? new ForeignKeyError(message, query, params, { constraint: '', table: '', referencedTable: target }, err)
        : new ForeignKeyError(message, query, params, { constraint: '', table: target }, err)
    case 'SQLITE_CONSTRAINT_NOTNULL':
      return new NotNullError(message, query, params, { constraint: '', table, column }, err)
    case 'SQLITE_CONSTRAINT_CHECK':
      return new CheckError(message, query, params, { constraint: named, table: target }, err)
  }

  if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'))
    return new SerializationError(message, query, params, err)

  if (code.startsWith('SQLITE_CANTOPEN') || code.startsWith('SQLITE_NOTADB'))
    return new ConnectionError(message, query, params, err)

  if (code === 'SQLITE_INTERRUPT')
    return new TimeoutError(message, query, params, err, code)

  if (code.startsWith('SQLITE_FULL') || code.startsWith('SQLITE_NOMEM'))
    return new ResourceError(message, code, query, params, err)

  if (code === 'SQLITE_MISMATCH' || code === 'SQLITE_TOOBIG' || code === 'SQLITE_RANGE')
    return new DataError(message, code, query, params, err)

  return new QueryError(message, query, params, err)
}

function unquote(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1).replaceAll('""', '"') : identifier
}

/** The table a statement targets, unquoted and without its schema; `''` for one it cannot tell. */
function statementTable(query: string): string {
  const name = query.match(STATEMENT_TABLE_RE)?.[1]

  return name ? unquote(name) : ''
}

function referencedTable(message: string, detail: string): string {
  const name = detail.match(NOT_PRESENT_TABLE_RE)?.[1] ?? message.match(PARENT_TABLE_RE)?.[1]

  return name?.replaceAll('""', '"') ?? ''
}

// `Key (a, "B")=(...)` names the key's columns, quoted where Postgres needs to.
function keyColumns(detail: string): string {
  const list = detail.match(KEY_COLUMNS_RE)?.[1]

  return list ? list.split(', ').map(unquote).join(', ') : ''
}
