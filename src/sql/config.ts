import type { AnyTableDef } from '../types/index'
import type { CallbackErrorEvent, QueryErrorEvent, QueryEvent, SlowQueryEvent } from './base-executor'
import { dialectOfUrl } from '../dialect'
import { DialectError, ValidationError } from '../errors/index'

// --- Connection & Pool Configuration ---

export interface DbConfig {
  /** `postgres://user:pass@host:5432/db`, or `sqlite://./data/app.db` (`sqlite://:memory:` in memory) for a SQLite file, which ignores the pool and connection options. */
  url?: string | undefined
  hostname?: string | undefined
  port?: number | undefined
  database?: string | undefined
  username?: string | undefined
  password?: string | (() => string | Promise<string>) | undefined
  pool?: {
    max?: number | undefined
    idleTimeout?: number | undefined
    maxLifetime?: number | undefined
    connectionTimeout?: number | undefined
  } | undefined
  tls?: boolean | object | undefined
  prepare?: boolean | undefined
  /** @deprecated No-op — bun:sql manages its own prepared statement cache */
  cacheSize?: number | undefined
  tables?: AnyTableDef[] | undefined
  /** Schema name for introspection queries (default: 'public') */
  schema?: string | undefined
  /** Maximum depth for nested `.include()` relation loading (default: 5) */
  maxIncludeDepth?: number | undefined
  /** Rows per IN (...) chunk in batched relation loading (default: 5000) */
  batchChunkSize?: number | undefined
  /** `statement_timeout` in milliseconds, set on every connection of the pool: plain queries and transactions alike. */
  statementTimeout?: number | undefined
  /**
   * `idle_in_transaction_session_timeout` in milliseconds, set on every connection of the pool.
   * Kills server-side connections that hold a transaction open without activity past the timeout: the prod safety net for forgotten `await`s inside a `tx => ...` callback.
   */
  idleInTransactionTimeout?: number | undefined
  /**
   * Sent as the connection's `application_name`. Visible in `pg_stat_activity`
   * and PG server logs, which makes filtering and incident attribution far easier
   * when multiple apps share a database.
   */
  application_name?: string | undefined
  /**
   * Log every query as `[1.234ms] SELECT … WHERE "id" = 42` — the SQL with its
   * `$n` placeholders filled in. `true` writes to `console.log` (colorized when
   * stdout is a TTY); pass a function to route the line into your own logger.
   *
   * Off by default, and **ignored entirely** when `NODE_ENV=production` or
   * `REDACT_QUERY_LOGS=1`, so it cannot leak query data by accident. A
   * `redactParams` redactor is applied to the values before they are inlined.
   * Composes with `onQuery` rather than replacing it.
   *
   * @example
   * ```ts
   * new Database({ debug: process.env.DB_DEBUG === '1' })
   * new Database({ debug: line => logger.debug(line) })
   * ```
   */
  debug?: boolean | ((line: string) => void) | undefined
  /** Query logging callback — called after every query */
  onQuery?: ((event: QueryEvent) => void) | undefined
  /** Slow query callback — called when a query exceeds the threshold */
  onSlowQuery?: ((event: SlowQueryEvent) => void) | undefined
  /** Slow query threshold in milliseconds (default: 1000) */
  slowQueryThreshold?: number | undefined
  /** Called when any query fails — receives the error, SQL, and params */
  onError?: ((event: QueryErrorEvent) => void) | undefined
  /** Called when ping() fails — useful for logging connection issues */
  onPingError?: ((error: unknown) => void) | undefined
  /**
   * Receives an error the ORM cannot rethrow without changing an outcome already settled: a failing onCommit/onRollback callback, a stream safety warning, a pool close at shutdown, or a query hook (`onQuery`, `onSlowQuery`, `onError`) that threw or rejected, which never fails the query it reports.
   * If unset, or if it throws itself, the error goes to `console.warn`.
   */
  onCallbackError?: ((event: CallbackErrorEvent) => void) | undefined
  /**
   * Scrub sensitive values from `QueryError.params`. Receives the positional
   * param array and returns the redacted copy. Called for every QueryError-
   * derived error and for the params of every `onQuery` / `onSlowQuery` / `onError` event.
   *
   * **Default behavior:** when no redactor is set, every param is replaced
   * with the string `'[REDACTED]'`. This is safe-by-default — accidental
   * upgrades or unset `NODE_ENV` won't leak data into logs.
   *
   * To **opt out** during local debugging:
   * - set `REDACT_QUERY_LOGS=0` in the environment, OR
   * - pass an identity redactor: `redactParams: p => p`.
   *
   * To **customize**, return a redacted copy (e.g., scrub by index/type while
   * keeping safe values raw).
   *
   * **MUST NOT throw.** A throwing redactor propagates the exception out of
   * the QueryError constructor — intentionally, so programming bugs in the
   * redactor surface loudly rather than masquerading as missing params.
   */
  redactParams?: ((params: unknown[]) => unknown[]) | undefined
  /**
   * Default LIMIT applied to findMany() when no explicit .limit() is set.
   * Disabled by default (no limit). Set to a positive number to enable.
   */
  defaultLimit?: number | undefined
  /**
   * Largest `perPage` (paginate) and `take` (paginateCursor) accepted; a larger one throws `ValidationError`, so a page size read off a request cannot load the whole table.
   * Defaults to 1000. `Infinity` lifts the cap. Streams are not capped, their chunk size being the caller's own.
   */
  maxPageSize?: number | undefined
  /**
   * Retry a statement outside a transaction with exponential backoff: any statement after a deadlock or serialization failure, and a SELECT after a dropped connection (PG codes 08xxx, 57P01).
   * A SELECT is judged by its leading keyword and assumed side-effect free, so one calling a side-effecting function retries too. A retried statement reaches the query hooks once, with its final outcome.
   * Disabled by default. Set `maxRetries` to enable.
   */
  retry?: {
    /** Maximum number of retry attempts (default: 0, disabled) */
    maxRetries?: number | undefined
    /** Initial delay in milliseconds before first retry (default: 100) */
    baseDelayMs?: number | undefined
    /** Maximum delay between retries in milliseconds (default: 5000) */
    maxDelayMs?: number | undefined
    /** Also retry writes after a dropped connection, which can apply one twice when it had committed before the reply was lost (default: false) */
    writes?: boolean | undefined
  } | undefined
}

/**
 * Validate the numeric fields on a `DbConfig`. Throws `ValidationError` for
 * non-finite or negative timeouts. Called once at `Database` construction.
 */
export function validateDbConfig(cfg: DbConfig): void {
  const { statementTimeout, idleInTransactionTimeout } = cfg

  if (statementTimeout !== undefined && (!Number.isFinite(statementTimeout) || statementTimeout < 0)) {
    throw new ValidationError(
      'statementTimeout must be a non-negative finite number',
      'DbConfig.statementTimeout',
      { value: statementTimeout },
    )
  }

  if (idleInTransactionTimeout !== undefined && (!Number.isFinite(idleInTransactionTimeout) || idleInTransactionTimeout < 0)) {
    throw new ValidationError(
      'idleInTransactionTimeout must be a non-negative finite number',
      'DbConfig.idleInTransactionTimeout',
      { value: idleInTransactionTimeout },
    )
  }

  validateRetry(cfg.retry, 'DbConfig.retry')

  if (dialectOfUrl(cfg.url) === 'sqlite') {
    if (statementTimeout !== undefined)
      throw new DialectError('DbConfig.statementTimeout', 'sqlite')

    if (idleInTransactionTimeout !== undefined)
      throw new DialectError('DbConfig.idleInTransactionTimeout', 'sqlite')
  }
}

/** Validate a `retry` option, the database's or a transaction's: a count that is not a whole number would retry nothing or forever, a delay that is not finite would never wake. */
export function validateRetry(retry: { maxRetries?: number | undefined, baseDelayMs?: number | undefined, maxDelayMs?: number | undefined } | undefined, field: string): void {
  if (!retry)
    return

  const { maxRetries, baseDelayMs, maxDelayMs } = retry

  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0))
    throw new ValidationError(`${field}.maxRetries must be a non-negative integer`, `${field}.maxRetries`, { value: maxRetries })

  for (const [name, value] of [['baseDelayMs', baseDelayMs], ['maxDelayMs', maxDelayMs]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new ValidationError(`${field}.${name} must be a non-negative finite number`, `${field}.${name}`, { value })
  }
}

/**
 * Flatten a `DbConfig` into the option bag `bun:sql`'s `SQL` constructor accepts.
 * Strips pg-orm-only fields, flattens `pool`, and drops `undefined` entries so the
 * driver only sees explicitly set values.
 */
export function normalizeDbConfig(cfg: DbConfig): Record<string, unknown> {
  const {
    pool,
    tables: _tables,
    cacheSize: _cacheSize,
    schema: _schema,
    statementTimeout,
    idleInTransactionTimeout,
    debug: _debug,
    onQuery: _onQuery,
    onSlowQuery: _onSlowQuery,
    onError: _onError,
    slowQueryThreshold: _slowQueryThreshold,
    onPingError: _onPingError,
    onCallbackError: _onCallbackError,
    retry: _retry,
    maxIncludeDepth: _maxIncludeDepth,
    batchChunkSize: _batchChunkSize,
    defaultLimit: _defaultLimit,
    maxPageSize: _maxPageSize,
    redactParams: _redactParams,
    ...connOpts
  } = cfg

  const sqlOpts: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(connOpts)) {
    if (val !== undefined)
      sqlOpts[key] = val
  }

  if (pool) {
    if (pool.max !== undefined)
      sqlOpts.max = pool.max

    if (pool.idleTimeout !== undefined)
      sqlOpts.idleTimeout = pool.idleTimeout

    if (pool.maxLifetime !== undefined)
      sqlOpts.maxLifetime = pool.maxLifetime

    if (pool.connectionTimeout !== undefined)
      sqlOpts.connectionTimeout = pool.connectionTimeout
  }

  // Startup parameters, so they hold on every pooled connection from its first query.
  const startup: Record<string, number> = {}

  if (statementTimeout !== undefined)
    startup.statement_timeout = Math.floor(statementTimeout)

  if (idleInTransactionTimeout !== undefined)
    startup.idle_in_transaction_session_timeout = Math.floor(idleInTransactionTimeout)

  if (Object.keys(startup).length)
    sqlOpts.connection = { ...sqlOpts.connection as Record<string, unknown> | undefined, ...startup }

  return sqlOpts
}
