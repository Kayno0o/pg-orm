import type { ExecutorHooks } from './base-executor'
import type { RetryConfig } from './retry'
import type { SqliteDriver } from './sqlite-driver'
import { AsyncLocalStorage } from 'node:async_hooks'
import { SQL } from 'bun'
import { requirePostgres } from '../dialect'
import { ConnectionError } from '../errors/index'
import { asDriver, copyIn, unsafeQuery } from './adapter'
import { BaseExecutor } from './base-executor'
import { registerInstance, unregisterInstance } from './cleanup'
import { DrainCoordinator } from './drain'
import { RetryPolicy } from './retry'

const DEFAULT_DRAIN_TIMEOUT_MS = 10_000

export interface ConnectionHooks extends ExecutorHooks {
  onPingError?: (error: unknown) => void
}

/**
 * Owns the bun:sql connection, drain coordination, retry policy, and process-exit
 * cleanup registration for a `Database`. Splits the connection-lifecycle concerns
 * off the `Database` facade so each is testable in isolation.
 *
 * Extends `BaseExecutor` so it provides the event-emitting `query` path. The
 * override here wraps the query with drain rejection and retry, reported once.
 */
export class ConnectionLifecycle extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  private _schema: string
  private _drain = new DrainCoordinator()
  // Set inside each tracked unit of work, so a query it issues while the drain waits for it is let through.
  private _work = new AsyncLocalStorage<true>()
  private _closed = false
  private _retry: RetryPolicy
  private _pingErrorHandler?: (error: unknown) => void
  private _instanceRef: ReturnType<typeof registerInstance>

  // Given a SQLite driver, the connection is that file's instead of the Postgres one `sqlOpts` describe.
  constructor(
    sqlOpts: ConstructorParameters<typeof SQL>[0],
    schema: string,
    retryCfg: RetryConfig,
    hooks: ConnectionHooks,
    sqlite?: SqliteDriver,
  ) {
    super()
    this.sql = sqlite ? sqlite as unknown as InstanceType<typeof SQL> : new SQL(sqlOpts)
    this._dialect = sqlite ? 'sqlite' : 'postgres'
    this._schema = schema
    this._retry = new RetryPolicy(retryCfg, () => this._closed)
    this._pingErrorHandler = hooks.onPingError
    this._useHooks(hooks)

    this._instanceRef = registerInstance(this)
  }

  override query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this.track(() => this._observed(sqlStr, params, () => this._retry.runStatement(sqlStr, () => unsafeQuery(this.sql, sqlStr, params, this._dialect))))
  }

  // Never retried: the chunks it streamed are consumed, so a second attempt would load nothing.
  override copyIn(sqlStr: string, chunks: AsyncIterable<string>): Promise<number> {
    return this.track(() => this._observed(sqlStr, [], () => copyIn(this.sql, sqlStr, chunks)))
  }

  /** Run a unit of work the drain waits for: rejected once closing has begun unless issued from inside work already running, counted as in flight until it settles. Transactions and migrations go through here as well as single queries. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    const nested = this._work.getStore() === true

    if (this._closed && !nested)
      throw new ConnectionError('Database is closed: no new queries accepted')

    if (this._drain.draining && !nested)
      throw new ConnectionError('Database is draining: no new queries accepted')

    this._drain.enter()

    try {
      return await this._work.run(true, fn)
    }
    finally {
      this._drain.exit()
    }
  }

  /** The tracked-work scope the caller runs in, as a function re-entering it: a transaction body, which bun:sql runs outside it, gets it back. */
  captureWork(): <R>(body: () => Promise<R>) => Promise<R> {
    const store = this._work.getStore()

    return body => store ? this._work.run(store, body) : body()
  }

  get schema(): string {
    return this._schema
  }

  get draining(): boolean {
    return this._drain.draining
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
   * Close the connection pool. New queries fail with `ConnectionError` from the start, and none is retried once the driver closes.
   * `drain: true` waits for in-flight work to settle, at most `timeout` ms (default 10 s), then closes at once; without it, the driver waits `timeout` ms for running queries, or for all of them when unset.
   */
  async close(opts?: { timeout?: number, drain?: boolean }): Promise<void> {
    let timeout = opts?.timeout

    if (opts?.drain) {
      this._drain.beginDrain()
      await this._drain.waitForIdle(timeout ?? DEFAULT_DRAIN_TIMEOUT_MS)
      timeout = 0
    }

    this._closed = true
    unregisterInstance(this._instanceRef)
    // Bun's SQL counts the close timeout in seconds.
    await asDriver(this.sql).close(timeout === undefined ? undefined : { timeout: timeout / 1000 })
  }

  /**
   * Query PostgreSQL for connection pool statistics from `pg_stat_activity`.
   */
  async getPoolStats(): Promise<{ active: number, idle: number, total: number, maxConnections: number }> {
    requirePostgres(this._dialect, 'getPoolStats()')

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
}
