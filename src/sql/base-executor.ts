import type { SQL } from 'bun'
import { unsafeQuery } from './adapter'

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
}

// --- Base Executor (shared query logic) ---

export abstract class BaseExecutor implements Executable {
  abstract readonly sql: InstanceType<typeof SQL>

  protected _onQuery?: (event: QueryEvent) => void
  protected _onSlowQuery?: (event: SlowQueryEvent) => void
  protected _onError?: (event: QueryErrorEvent) => void
  protected _slowQueryThreshold = 1000
  protected _context?: Record<string, unknown>

  async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (this._onQuery || this._onSlowQuery) {
      const start = performance.now()
      let result: Record<string, unknown>[]

      try {
        result = await unsafeQuery(this.sql, sqlStr, params)
      }
      catch (err) {
        this._onError?.({ error: err, sql: sqlStr, params, ...this._context ? { context: this._context } : {} })

        throw err
      }

      const durationMs = performance.now() - start
      const event: QueryEvent = { sql: sqlStr, params, durationMs }

      if (this._context)
        event.context = this._context

      if (this._onQuery)
        this._onQuery(event)

      if (this._onSlowQuery && durationMs >= this._slowQueryThreshold)
        this._onSlowQuery({ ...event, threshold: this._slowQueryThreshold })

      return result
    }

    try {
      return await unsafeQuery(this.sql, sqlStr, params)
    }
    catch (err) {
      this._onError?.({ error: err, sql: sqlStr, params, ...this._context ? { context: this._context } : {} })

      throw err
    }
  }
}
