import type { QueryErrorEvent, QueryEvent, SlowQueryEvent } from './base-executor'
import type { RetryConfig } from './retry'
import { SQL } from 'bun'
import { ConnectionError } from '../errors/index'
import { asDriver } from './adapter'
import { BaseExecutor } from './base-executor'
import { registerInstance, unregisterInstance } from './cleanup'
import { DrainCoordinator } from './drain'
import { RetryPolicy } from './retry'

export interface ConnectionHooks {
  onQuery?: (event: QueryEvent) => void
  onSlowQuery?: (event: SlowQueryEvent) => void
  onError?: (event: QueryErrorEvent) => void
  onPingError?: (error: unknown) => void
  onCallbackError?: (event: { kind: 'onCommit' | 'onRollback' | 'streamWarning' | 'shutdownCloseError', error: unknown }) => void
  slowQueryThreshold?: number
}

/**
 * Owns the bun:sql connection, drain coordination, retry policy, and process-exit
 * cleanup registration for a `Database`. Splits the connection-lifecycle concerns
 * off the `Database` facade so each is testable in isolation.
 *
 * Extends `BaseExecutor` so it provides the event-emitting `query` path. The
 * override here wraps `super.query` with drain rejection and retry.
 */
export class ConnectionLifecycle extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  private _schema: string
  private _drain = new DrainCoordinator()
  private _retry: RetryPolicy
  private _pingErrorHandler?: (error: unknown) => void
  private _instanceRef: ReturnType<typeof registerInstance>
  /** @internal */ _onCallbackError?: ConnectionHooks['onCallbackError']

  constructor(
    sqlOpts: ConstructorParameters<typeof SQL>[0],
    schema: string,
    retryCfg: RetryConfig,
    hooks: ConnectionHooks,
  ) {
    super()
    this.sql = new SQL(sqlOpts)
    this._schema = schema
    this._retry = new RetryPolicy(retryCfg)
    this._pingErrorHandler = hooks.onPingError
    this._onCallbackError = hooks.onCallbackError
    this._onQuery = hooks.onQuery
    this._onSlowQuery = hooks.onSlowQuery
    this._onError = hooks.onError

    if (hooks.slowQueryThreshold != null)
      this._slowQueryThreshold = hooks.slowQueryThreshold

    this._instanceRef = registerInstance(this)
  }

  override query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this.track(() => this._retry.runStatement(sqlStr, () => super.query(sqlStr, params)))
  }

  /** Run a unit of work the drain waits for: rejected once draining has begun, counted as in flight until it settles. Transactions and migrations go through here as well as single queries. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    if (this._drain.draining) {
      throw new ConnectionError('Database is draining — no new queries accepted')
    }

    this._drain.enter()

    try {
      return await fn()
    }
    finally {
      this._drain.exit()
    }
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
   * Close the connection pool. `drain: true` rejects new queries and waits
   * for in-flight queries to settle (bounded by `timeout`) before invoking
   * the driver close.
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
   * Query PostgreSQL for connection pool statistics from `pg_stat_activity`.
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
}
