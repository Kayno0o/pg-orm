import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import { AsyncLocalStorage } from 'node:async_hooks'
import { logParams, queryLogsRedacted } from '../errors/index'
import { unsafeQuery } from './adapter'

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
}

export interface QueryErrorEvent {
  error: unknown
  sql: string
  params: unknown[]
  /** Optional request context for correlation (e.g., requestId, traceId). */
  context?: Record<string, unknown>
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
  protected _slowQueryThreshold = 1000
  protected _context?: Record<string, unknown>

  get dialect(): Dialect {
    return this._dialect
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

  async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (this._onQuery || this._onSlowQuery) {
      const start = performance.now()
      let result: Record<string, unknown>[]

      try {
        result = await unsafeQuery(this.sql, sqlStr, params, this._dialect)
      }
      catch (err) {
        const ctx = this._currentContext()

        this._onError?.({ error: err, sql: sqlStr, params: eventParams(params), ...ctx ? { context: ctx } : {} })

        throw err
      }

      const durationMs = performance.now() - start
      const event: QueryEvent = { sql: sqlStr, params: eventParams(params), durationMs }
      const ctx = this._currentContext()

      if (ctx)
        event.context = ctx

      if (this._onQuery)
        this._onQuery(event)

      if (this._onSlowQuery && durationMs >= this._slowQueryThreshold)
        this._onSlowQuery({ ...event, threshold: this._slowQueryThreshold })

      return result
    }

    try {
      return await unsafeQuery(this.sql, sqlStr, params, this._dialect)
    }
    catch (err) {
      const ctx = this._currentContext()

      this._onError?.({ error: err, sql: sqlStr, params: eventParams(params), ...ctx ? { context: ctx } : {} })

      throw err
    }
  }
}
