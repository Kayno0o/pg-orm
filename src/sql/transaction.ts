import type { SQL } from 'bun'
import type { QueryErrorEvent, QueryEvent, SlowQueryEvent } from './base-executor'
import { asDriver } from './adapter'
import { BaseExecutor } from './base-executor'

export interface TransactionOptions {
  isolation?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  accessMode?: 'read write' | 'read only'
  /** Optional context propagated to all QueryEvents within this transaction. */
  context?: Record<string, unknown>
  /** Open a separate transaction on its own connection even when called from inside a running one, which it would otherwise join. */
  independent?: boolean
}

export class TransactionClient extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>

  private _savepointCounter = 0
  /** @internal */ _onCommitCallbacks: (() => void | Promise<void>)[] = []
  /** @internal */ _onRollbackCallbacks: ((err: unknown) => void | Promise<void>)[] = []
  /** @internal */ declare _context?: Record<string, unknown>

  constructor(sqlTx: InstanceType<typeof SQL>, onQuery?: (event: QueryEvent) => void, onSlowQuery?: (event: SlowQueryEvent) => void, slowQueryThreshold?: number, onError?: (event: QueryErrorEvent) => void) {
    super()
    this.sql = sqlTx
    this._onQuery = onQuery
    this._onSlowQuery = onSlowQuery
    this._onError = onError

    if (slowQueryThreshold != null)
      this._slowQueryThreshold = slowQueryThreshold
  }

  /**
   * Register a callback to run after the transaction commits successfully.
   *
   * **Callback semantics**: the callback fires AFTER the transaction has
   * already been committed by the driver — `tx.*` query methods are no
   * longer connected to a live transaction at that point. The callback
   * MUST NOT call back into `tx.*`. Use it for side effects that should
   * happen only on commit: cache invalidation, telemetry emit, queue
   * dispatch, webhook fire, etc. A throw is routed to `onCallbackError`
   * (or dropped) — it cannot un-commit the transaction.
   */
  onCommit(fn: () => void | Promise<void>): void {
    this._onCommitCallbacks.push(fn)
  }

  /**
   * Register a callback to run after the transaction rolls back.
   *
   * Same semantics as `onCommit`: fires after the rollback has settled,
   * `tx.*` is no longer live, callbacks MUST NOT call back into `tx.*`.
   * Use for compensating actions, error logging, retry scheduling.
   */
  onRollback(fn: (err: unknown) => void | Promise<void>): void {
    this._onRollbackCallbacks.push(fn)
  }

  async savepoint<T>(fn: (sp: SavepointClient) => Promise<T>): Promise<T> {
    const name = `sp_${++this._savepointCounter}`

    return asDriver(this.sql).savepoint<T>(async (sqlSp) => {
      const sp = new SavepointClient(sqlSp, name, this._onQuery, this._onSlowQuery, this._slowQueryThreshold, this._onError)

      return fn(sp)
    })
  }
}

export class SavepointClient extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  readonly name: string

  constructor(sqlSp: InstanceType<typeof SQL>, name: string, onQuery?: (event: QueryEvent) => void, onSlowQuery?: (event: SlowQueryEvent) => void, slowQueryThreshold?: number, onError?: (event: QueryErrorEvent) => void) {
    super()
    this.sql = sqlSp
    this.name = name
    this._onQuery = onQuery
    this._onSlowQuery = onSlowQuery
    this._onError = onError

    if (slowQueryThreshold != null)
      this._slowQueryThreshold = slowQueryThreshold
  }

  async rollback(): Promise<void> {
    // bun:sql's savepoint handles rollback on throw — to explicitly rollback, throw
    throw new SavepointRollback(this.name)
  }
}

export class SavepointRollback extends Error {
  constructor(name: string) {
    super(`Savepoint ${name} rollback`)
    this.name = 'SavepointRollback'
  }
}
