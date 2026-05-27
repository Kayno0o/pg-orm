import type { AnyTableDef } from '../types/index'
import type { QueryErrorEvent, QueryEvent, SlowQueryEvent } from './base-executor'
import { ValidationError } from '../errors/index'

// --- Connection & Pool Configuration ---

export interface DbConfig {
  url?: string
  hostname?: string
  port?: number
  database?: string
  username?: string
  password?: string | (() => string | Promise<string>)
  pool?: {
    max?: number
    idleTimeout?: number
    maxLifetime?: number
    connectionTimeout?: number
  }
  tls?: boolean | object
  prepare?: boolean
  /** @deprecated No-op — bun:sql manages its own prepared statement cache */
  cacheSize?: number
  tables?: AnyTableDef[]
  /** Schema name for introspection queries (default: 'public') */
  schema?: string
  /** Maximum depth for nested `.include()` relation loading (default: 5) */
  maxIncludeDepth?: number
  /** Rows per IN (...) chunk in batched relation loading (default: 5000) */
  batchChunkSize?: number
  /** Statement timeout in milliseconds — applied to each connection */
  statementTimeout?: number
  /**
   * `idle_in_transaction_session_timeout` in milliseconds. Applied transaction-locally
   * via `SET LOCAL` at the start of each `transaction()` call. Kills server-side
   * connections that hold a transaction open without activity past the timeout —
   * the prod safety net for forgotten `await`s inside a `tx => ...` callback.
   */
  idleInTransactionTimeout?: number
  /**
   * Sent as the connection's `application_name`. Visible in `pg_stat_activity`
   * and PG server logs, which makes filtering and incident attribution far easier
   * when multiple apps share a database.
   */
  application_name?: string
  /** Query logging callback — called after every query */
  onQuery?: (event: QueryEvent) => void
  /** Slow query callback — called when a query exceeds the threshold */
  onSlowQuery?: (event: SlowQueryEvent) => void
  /** Slow query threshold in milliseconds (default: 1000) */
  slowQueryThreshold?: number
  /** Called when any query fails — receives the error, SQL, and params */
  onError?: (event: QueryErrorEvent) => void
  /** Called when ping() fails — useful for logging connection issues */
  onPingError?: (error: unknown) => void
  /**
   * Called when a transaction onCommit/onRollback callback or a stream safety
   * warning surfaces an error that the ORM would otherwise have to swallow
   * (the transaction has already committed or rolled back, so re-throwing
   * would change observable semantics). If unset, errors are silently dropped
   * (and the stream warning falls back to `console.warn`).
   */
  onCallbackError?: (event: { kind: 'onCommit' | 'onRollback' | 'streamWarning' | 'shutdownCloseError', error: unknown }) => void
  /**
   * Scrub sensitive values from `QueryError.params`. Receives the positional
   * param array and returns the redacted copy. Called for every QueryError-
   * derived error.
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
  redactParams?: (params: unknown[]) => unknown[]
  /**
   * Default LIMIT applied to findMany() when no explicit .limit() is set.
   * Disabled by default (no limit). Set to a positive number to enable.
   */
  defaultLimit?: number
  /**
   * Retry transient connection errors (PG codes 08xxx, 57P01) with exponential backoff.
   *  Disabled by default. Set `maxRetries` to enable.
   */
  retry?: {
    /** Maximum number of retry attempts (default: 0, disabled) */
    maxRetries?: number
    /** Initial delay in milliseconds before first retry (default: 100) */
    baseDelayMs?: number
    /** Maximum delay between retries in milliseconds (default: 5000) */
    maxDelayMs?: number
  }
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
    statementTimeout: _statementTimeout,
    idleInTransactionTimeout: _idleInTransactionTimeout,
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

  return sqlOpts
}
