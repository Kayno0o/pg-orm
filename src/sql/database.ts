import type { BaseBuilder } from '../builder/base'
import type { MigrationOp } from '../migration/index'
import type { SyncOptions } from '../migration/sync'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, TableDef } from '../types/index'
import type { QueryErrorEvent, QueryEvent, SlowQueryEvent } from './base-executor'
import type { TransactionOptions } from './transaction'
import { SQL } from 'bun'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH } from '../constants'
import { ConnectionError, setParamRedactor, ValidationError } from '../errors/index'
import { clearMapperCache } from '../mapper/index'
import { clearVirtualEntriesCache, Repository } from '../repo/index'
import { asDriver } from './adapter'
import { BaseExecutor, queryContextStorage } from './base-executor'
import { registerInstance, unregisterInstance } from './cleanup'
import { DrainCoordinator } from './drain'
import { MigrationRunner } from './migration-runner'
import { RetryPolicy } from './retry'
import { TransactionClient } from './transaction'
import { applyIdleInTransactionTimeout, applyIsolation, applyStatementTimeout } from './tx-sql'

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
   * Scrub sensitive values from `QueryError.params` even outside production.
   * Receives the positional param array and returns the redacted copy.
   * Called for every QueryError-derived error.
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
 * Main database connection class. Manages the connection pool, table registry,
 * and provides methods for querying, transactions, migrations, and health checks.
 *
 * @example
 * ```ts
 * const db = new Database({
 *   url: 'postgres://user:pass@localhost:5432/mydb',
 *   tables: [users, posts],
 *   pool: { max: 10 },
 * })
 * await db.sync() // auto-migrate
 * const repo = db.repo(users) // create repository
 * await db.close() // cleanup
 * ```
 */
export class Database extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  private _tables: Map<string, AnyTableDef>
  private _schema: string
  private _statementTimeout?: number
  private _idleInTransactionTimeout?: number
  private _pingErrorHandler?: (error: unknown) => void
  _onCallbackError?: (event: { kind: 'onCommit' | 'onRollback' | 'streamWarning' | 'shutdownCloseError', error: unknown }) => void
  private _maxIncludeDepth: number
  private _batchChunkSize: number
  private _defaultLimit?: number
  private _instanceRef: ReturnType<typeof registerInstance>
  private _drain = new DrainCoordinator()
  private _retry: RetryPolicy
  private _migrations?: MigrationRunner

  constructor(config: DbConfig = {}) {
    super()
    const { pool, tables, cacheSize: _, schema, statementTimeout, idleInTransactionTimeout, onQuery, onSlowQuery, onError, slowQueryThreshold, onPingError, onCallbackError, retry, maxIncludeDepth, batchChunkSize, defaultLimit, redactParams, ...connOpts } = config
    const sqlOpts: Record<string, unknown> = {}

    this._onQuery = onQuery
    this._onSlowQuery = onSlowQuery
    this._onError = onError

    if (redactParams)
      setParamRedactor(redactParams)

    if (slowQueryThreshold != null)
      this._slowQueryThreshold = slowQueryThreshold

    this._schema = schema ?? 'public'

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

    this._statementTimeout = statementTimeout
    this._idleInTransactionTimeout = idleInTransactionTimeout
    this._pingErrorHandler = onPingError
    this._onCallbackError = onCallbackError
    this._retry = new RetryPolicy({
      maxRetries: retry?.maxRetries ?? 0,
      baseDelayMs: retry?.baseDelayMs ?? 100,
      maxDelayMs: retry?.maxDelayMs ?? 5000,
    })
    this._maxIncludeDepth = maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    this._batchChunkSize = batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE
    this._defaultLimit = defaultLimit

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

    this.sql = new SQL(sqlOpts as ConstructorParameters<typeof SQL>[0])

    this._tables = new Map()

    if (tables) {
      for (const table of tables) {
        this._tables.set(table.name, table)
      }
    }

    this._instanceRef = registerInstance(this)
  }

  override async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (this._drain.draining) {
      throw new ConnectionError('Database is draining — no new queries accepted')
    }

    this._drain.enter()

    try {
      return await this._retry.run(() => super.query(sqlStr, params))
    }
    finally {
      this._drain.exit()
    }
  }

  get schema(): string {
    return this._schema
  }

  /** Returns true if the database is draining (no new queries accepted). */
  get draining(): boolean {
    return this._drain.draining
  }

  /** Create a typed Repository for a table definition. */
  repo<
    TName extends string,
    TColumns extends AnyColumns,
    TRelations extends AnyRelations,
    TVirtuals extends AnyVirtuals,
  >(
    table: TableDef<TName, TColumns, TRelations, TVirtuals>,
  ): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>({
      table: table as AnyTableDef,
      executor: this,
      tableRegistry: this._tables,
      maxIncludeDepth: this._maxIncludeDepth,
      defaultLimit: this._defaultLimit,
      batchChunkSize: this._batchChunkSize,
    })
  }

  /** Lazy-built `MigrationRunner` — owns `sync` / `rollback`. */
  private get migrations(): MigrationRunner {
    return this._migrations ??= new MigrationRunner(
      (s, p) => this.query(s, p),
      this.sql,
      this._schema,
      this._tables,
    )
  }

  /**
   * Auto-migrate: introspect the live DB, diff against registered tables, and apply DDL.
   * Pass `{ dryRun: true }` to preview changes; `{ allowDestructive: true }` to allow DROP/RENAME;
   * `{ confirm: true }` to show SQL and prompt for confirmation.
   */
  async sync(opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
    return this.migrations.sync(opts)
  }

  /** Rollback the last N migrations by executing their down SQL. */
  async rollback(count = 1): Promise<{ rolledBack: string[], sql: string }> {
    return this.migrations.rollback(count)
  }

  // Get the internal tables registry
  getTablesRegistry(): ReadonlyMap<string, AnyTableDef> {
    return this._tables
  }

  /**
   * Execute raw SQL. Supports tagged template literals or plain strings with params.
   *
   * @trusted The SQL string is sent verbatim to the driver. Tagged-template usage
   * automatically parameterizes interpolated values, but the SQL skeleton itself
   * must be developer-authored — never assemble it from user input. See README
   * "Security model".
   * @example
   * ```ts
   * const rows = await db.raw`SELECT * FROM users WHERE id = ${id}`
   * const rows = await db.raw('SELECT * FROM users WHERE id = $1', [id])
   * ```
   */
  raw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  raw<T = unknown>(sqlStr: string, params?: unknown[]): Promise<T[]>
  async raw<T = unknown>(
    sqlOrStrings: string | TemplateStringsArray,
    ...rest: unknown[]
  ): Promise<T[]> {
    if (typeof sqlOrStrings === 'string') {
      return await this.query(sqlOrStrings, rest[0] as unknown[] ?? []) as T[]
    }

    // Tagged template: assemble SQL with $N placeholders
    const parts = sqlOrStrings
    let sql = parts[0] ?? ''
    const params: unknown[] = []

    for (let i = 0; i < rest.length; i++) {
      params.push(rest[i])
      sql += `$${i + 1}${parts[i + 1] ?? ''}`
    }

    return await this.query(sql, params) as T[]
  }

  /**
   * Run a callback inside a database transaction. Auto-commits on success, rolls back on error.
   * @example
   * ```ts
   * await db.transaction({ isolation: 'serializable' }, async (tx) => {
   *   const repo = userRepo.using(tx)
   *   await repo.updateOne({ balance: 0 }, e => e.eq('id', 1))
   * })
   * ```
   */
  async transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async transaction<T>(opts: TransactionOptions, fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async transaction<T>(
    fnOrOpts: ((tx: TransactionClient) => Promise<T>) | TransactionOptions,
    maybeFn?: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn!
    const opts = typeof fnOrOpts === 'object' ? fnOrOpts : undefined

    let txRef: TransactionClient | undefined

    // Capture the ALS-bound context at the call site so the tx body re-enters
    // the same scope. bun:sql's `begin()` schedules its callback through a path
    // that may not preserve `AsyncLocalStorage` propagation; pinning the scope
    // here keeps `Database.withContext` working inside transactions.
    const ambientContext = queryContextStorage.getStore()
    const runInContext = <R>(body: () => Promise<R>): Promise<R> =>
      ambientContext ? queryContextStorage.run(ambientContext, body) : body()

    try {
      const result = await asDriver(this.sql).begin<T>(async sqlTx => runInContext(async () => {
        if (opts)
          await applyIsolation(sqlTx, opts)

        if (this._statementTimeout !== undefined)
          await applyStatementTimeout(sqlTx, this._statementTimeout)

        if (this._idleInTransactionTimeout !== undefined)
          await applyIdleInTransactionTimeout(sqlTx, this._idleInTransactionTimeout)

        const tx = new TransactionClient(sqlTx, this._onQuery, this._onSlowQuery, this._slowQueryThreshold, this._onError)

        if (opts?.context)
          tx._context = opts.context

        txRef = tx

        return fn(tx)
      }))

      // Transaction committed — fire onCommit callbacks
      if (txRef)
        await this._fireTxCallbacks('onCommit', txRef._onCommitCallbacks)

      return result
    }
    catch (err) {
      // Transaction rolled back — fire onRollback callbacks
      if (txRef)
        await this._fireTxCallbacks('onRollback', txRef._onRollbackCallbacks, err)

      throw err
    }
  }

  /**
   * Sequentially fire every registered tx callback. Errors are collected and
   * dispatched as a single `AggregateError` to `onCallbackError` so callbacks
   * registered after a failing one are never silently dropped — the commit (or
   * rollback) has already settled and re-throwing would change observable
   * semantics.
   */
  private async _fireTxCallbacks(
    kind: 'onCommit' | 'onRollback',
    callbacks: ((err?: unknown) => void | Promise<void>)[],
    rollbackErr?: unknown,
  ): Promise<void> {
    if (callbacks.length === 0)
      return

    const errors: unknown[] = []

    for (const cb of callbacks) {
      try {
        await cb(rollbackErr)
      }
      catch (callbackErr) {
        errors.push(callbackErr)
      }
    }

    if (errors.length === 0)
      return

    const error = errors.length === 1
      ? errors[0]
      : new AggregateError(errors, `${errors.length} ${kind} callbacks failed`)

    this._onCallbackError?.({ kind, error })
  }

  /** Health check — returns true if the database is reachable. */
  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1', [])

      return true
    }
    catch (err) {
      this._pingErrorHandler?.(err)

      return false
    }
  }

  /**
   * Run EXPLAIN (FORMAT JSON) on a query builder and return the parsed plan
   * along with the rendered SQL and params (useful for logging and tooling).
   */
  async explain(
    builder: BaseBuilder,
    opts?: { analyze?: boolean },
  ): Promise<{ sql: string, params: unknown[], plan: unknown }> {
    const { sql, params } = builder.explain(opts)
    const rows = await this.query(sql, params)
    const plan = rows[0]?.['QUERY PLAN']

    return { sql, params, plan }
  }

  /**
   * Query PostgreSQL for connection pool statistics from `pg_stat_activity`.
   * Note: this is server-side state; client-side bun:sql metrics are not exposed.
   */
  async getPoolStats(): Promise<{ active: number, idle: number, total: number, maxConnections: number }> {
    const rows = await this.query(`
      SELECT
        count(*) FILTER (WHERE state = 'active') AS active,
        count(*) FILTER (WHERE state = 'idle') AS idle,
        count(*) AS total,
        (SELECT setting::int FROM pg_settings WHERE name = 'max_connections') AS max_connections
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid != pg_backend_pid()
    `, [])
    const row = rows[0] ?? {}

    return {
      active: Number(row.active ?? 0),
      idle: Number(row.idle ?? 0),
      total: Number(row.total ?? 0),
      maxConnections: Number(row.max_connections ?? 0),
    }
  }

  invalidateCache(): void {
    clearMapperCache()
    clearVirtualEntriesCache()
  }

  /**
   * Close the database connection pool.
   *
   * - `drain: true` rejects *new* queries (with `ConnectionError`) and waits for
   *   in-flight queries to settle before invoking the driver close.
   * - `timeout` (ms) acts as a hard ceiling on the drain wait. If the timeout
   *   fires before the in-flight count reaches zero, the driver close is invoked
   *   anyway with the same `timeout` forwarded.
   */
  async close(opts?: { timeout?: number, drain?: boolean }): Promise<void> {
    if (opts?.drain) {
      this._drain.beginDrain()
      await this._drain.waitForIdle(opts.timeout)
    }

    unregisterInstance(this._instanceRef)
    await asDriver(this.sql).close({ timeout: opts?.timeout })
  }

  /**
   * Run `fn` with `ctx` bound to async-local storage. Every query emitted
   * inside `fn` (including queries from repos, builders, and nested
   * `transaction()` calls) gets `ctx` attached to its `QueryEvent`,
   * `SlowQueryEvent`, and `QueryErrorEvent` automatically — no need to thread
   * a scoped Database through your call graph.
   *
   * Nested calls merge: inner keys override outer keys. An explicit
   * `transaction({ context })` overrides keys that overlap with the ambient
   * context for queries inside that transaction.
   *
   * @example
   * ```ts
   * app.use((req, _res, next) => {
   *   db.withContext({ requestId: req.id, userId: req.user?.id }, async () => {
   *     await next() // queries inside this scope carry the context
   *   })
   * })
   * ```
   */
  withContext<T>(ctx: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
    const outer = queryContextStorage.getStore()
    const merged = outer ? { ...outer, ...ctx } : ctx

    return Promise.resolve(queryContextStorage.run(merged, fn))
  }
}
