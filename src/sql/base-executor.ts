import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import { AsyncLocalStorage } from 'node:async_hooks'
import { logParams, queryLogsRedacted } from '../errors/index'
import { copyIn, copyOut, unsafeQuery } from './adapter'

/**
 * Async-local storage for query context. `Database.withContext(ctx, fn)` runs
 * `fn` with `ctx` bound here; `BaseExecutor` picks it up and decorates every
 * `QueryEvent`/`SlowQueryEvent`/`QueryErrorEvent` emitted inside the scope.
 */
export const queryContextStorage = new AsyncLocalStorage<Record<string, unknown>>()

// --- Query logging ---

export interface QueryEvent {
  sql: string
  params: unknown[]
  durationMs: number
  /** Optional request context for correlation (e.g., requestId, traceId). */
  context?: Record<string, unknown>
}

export interface SlowQueryEvent extends QueryEvent {
  threshold: number
  /** Set when the slow query failed. */
  error?: unknown
}

export interface QueryErrorEvent {
  error: unknown
  sql: string
  params: unknown[]
  durationMs: number
  /** Optional request context for correlation (e.g., requestId, traceId). */
  context?: Record<string, unknown>
}

/** An error the ORM cannot rethrow without changing an outcome already settled: a commit or rollback callback, a stream warning, a pool close at shutdown, a throwing query hook. */
export interface CallbackErrorEvent {
  kind: 'onCommit' | 'onRollback' | 'streamWarning' | 'shutdownCloseError' | 'queryHook'
  error: unknown
}

/** The hooks an executor reports its queries to. */
export interface ExecutorHooks {
  onQuery?: (event: QueryEvent) => void
  onSlowQuery?: (event: SlowQueryEvent) => void
  onError?: (event: QueryErrorEvent) => void
  onCallbackError?: (event: CallbackErrorEvent) => void
  slowQueryThreshold?: number
}

/** Route an error nothing can rethrow to `onCallbackError`, or to `console.warn` without one; a throwing channel is warned about too, never rethrown. */
export function reportCallbackError(channel: ((event: CallbackErrorEvent) => void) | undefined, event: CallbackErrorEvent): void {
  if (channel) {
    try {
      channel(event)

      return
    }
    catch (channelErr) {
      console.warn('pg-orm: onCallbackError handler threw:', channelErr)
    }
  }

  console.warn(`pg-orm: ${event.kind} failed:`, event.error)
}

export interface Executable {
  /** bun:sql tagged template — used for raw queries */
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>
  /** bun:sql tagged template interface */
  sql: InstanceType<typeof SQL>
  /** The SQL the database speaks, `postgres` when unset. */
  readonly dialect?: Dialect
  /** Runs `fn` in one transaction suited to DDL: on SQLite, foreign keys are off around it and checked before the commit. */
  migrate?: <T>(fn: (query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>) => Promise<T>
  /** Runs `fn` on one connection outside any transaction, names resolved in the configured schema and the migration lock held: for the statements a transaction refuses (`CREATE INDEX CONCURRENTLY`). */
  migrateOutside?: <T>(fn: (query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>) => Promise<T>
  /** Runs `fn` all-or-nothing: in a transaction, or a savepoint of the running one. A write spanning several statements goes through it. */
  atomic?: <T>(fn: (exec: Executable) => Promise<T>) => Promise<T>
  /** Runs a `COPY ... FROM STDIN` statement fed with `chunks`, resolving to the rows loaded. Postgres only. */
  copyIn?: (sql: string, chunks: AsyncIterable<string>) => Promise<number>
  /** Runs a `COPY ... TO STDOUT` statement, streaming its output. Postgres only. */
  copyOut?: (sql: string) => ReadableStream<Uint8Array>
}

// Params as the query hooks see them: none where query logs are redacted (production, REDACT_QUERY_LOGS=1), else through the configured `redactParams`. The safe-default scrub that QueryError falls back to is not applied, so a dev debug hook still sees values.
function eventParams(params: unknown[]): unknown[] {
  return queryLogsRedacted() ? [] : logParams(params)
}

// --- Base Executor (shared query logic) ---

export abstract class BaseExecutor implements Executable {
  abstract readonly sql: InstanceType<typeof SQL>

  protected _dialect: Dialect = 'postgres'
  protected _onQuery?: (event: QueryEvent) => void
  protected _onSlowQuery?: (event: SlowQueryEvent) => void
  protected _onError?: (event: QueryErrorEvent) => void
  /** @internal */ _onCallbackError?: (event: CallbackErrorEvent) => void
  protected _slowQueryThreshold = 1000
  protected _context?: Record<string, unknown>

  get dialect(): Dialect {
    return this._dialect
  }

  /** @internal */
  get hooks(): ExecutorHooks {
    return { onQuery: this._onQuery, onSlowQuery: this._onSlowQuery, onError: this._onError, onCallbackError: this._onCallbackError, slowQueryThreshold: this._slowQueryThreshold }
  }

  protected _useHooks(hooks: ExecutorHooks): void {
    this._onQuery = hooks.onQuery
    this._onSlowQuery = hooks.onSlowQuery
    this._onError = hooks.onError
    this._onCallbackError = hooks.onCallbackError

    if (hooks.slowQueryThreshold != null)
      this._slowQueryThreshold = hooks.slowQueryThreshold
  }

  /**
   * Resolve the effective context for a query event: the ALS-bound ambient
   * context (set via `Database.withContext`) merged with this executor's
   * explicit `_context` (set via `transaction({ context })`). Explicit keys
   * override ambient ones.
   */
  protected _currentContext(): Record<string, unknown> | undefined {
    const ambient = queryContextStorage.getStore()

    if (!ambient)
      return this._context

    if (!this._context)
      return ambient

    return { ...ambient, ...this._context }
  }

  query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this._observed(sqlStr, params, () => unsafeQuery(this.sql, sqlStr, params, this._dialect))
  }

  copyIn(sqlStr: string, chunks: AsyncIterable<string>): Promise<number> {
    return this._observed(sqlStr, [], () => copyIn(this.sql, sqlStr, chunks))
  }

  // Reported to the query hooks once the stream ends, its duration covering the whole read.
  copyOut(sqlStr: string): ReadableStream<Uint8Array> {
    const start = performance.now()

    return copyOut(this.sql, sqlStr, (...failure) => this._report(sqlStr, [], performance.now() - start, ...failure))
  }

  // Runs `run` as one query for the hooks: a retried statement reports once, its outcome after the last attempt.
  protected async _observed<T>(sqlStr: string, params: unknown[], run: () => Promise<T>): Promise<T> {
    const start = performance.now()
    let result: T

    try {
      result = await run()
    }
    catch (err) {
      this._report(sqlStr, params, performance.now() - start, err)

      throw err
    }

    this._report(sqlStr, params, performance.now() - start)

    return result
  }

  // Hooks only observe: one that throws, or rejects, is routed to `onCallbackError` and the query keeps its own outcome.
  private _report(sql: string, params: unknown[], durationMs: number, ...failure: [error: unknown] | []): void {
    if (!this._onQuery && !this._onSlowQuery && !this._onError)
      return

    const ctx = this._currentContext()
    const event: QueryEvent = { sql, params: eventParams(params), durationMs, ...ctx ? { context: ctx } : {} }
    const slow = durationMs >= this._slowQueryThreshold

    if (failure.length)
      this._callHook(this._onError, { ...event, error: failure[0] })
    else
      this._callHook(this._onQuery, event)

    if (slow)
      this._callHook(this._onSlowQuery, { ...event, threshold: this._slowQueryThreshold, ...failure.length ? { error: failure[0] } : {} })
  }

  private _callHook<E>(hook: ((event: E) => void) | undefined, event: E): void {
    if (!hook)
      return

    try {
      const out = hook(event) as unknown

      if (out instanceof Promise)
        void this._settleHook(out)
    }
    catch (error) {
      reportCallbackError(this._onCallbackError, { kind: 'queryHook', error })
    }
  }

  private async _settleHook(pending: Promise<unknown>): Promise<void> {
    try {
      await pending
    }
    catch (error) {
      reportCallbackError(this._onCallbackError, { kind: 'queryHook', error })
    }
  }
}
