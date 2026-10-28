import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import type { ExecutorHooks } from './base-executor'
import { ValidationError } from '../errors/index'
import { BaseExecutor } from './base-executor'

export interface TransactionOptions {
  isolation?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  accessMode?: 'read write' | 'read only'
  /** Optional context propagated to all QueryEvents within this transaction. */
  context?: Record<string, unknown>
  /** Open a separate transaction on its own connection even when called from inside a running one, which it would otherwise join. */
  independent?: boolean
  /**
   * Run the whole transaction again, body included, when it fails on a serialization failure or a deadlock, which retrying can resolve.
   * Only the last attempt's onCommit or onRollback callbacks run. Not allowed on a call joining a running transaction.
   */
  retry?: {
    maxRetries: number
    /** Initial delay in milliseconds before the first retry (default: 100) */
    baseDelayMs?: number
    /** Maximum delay between retries in milliseconds (default: 5000) */
    maxDelayMs?: number
  }
}

export class TransactionClient extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>

  /** @internal */ _onCommitCallbacks: (() => void | Promise<void>)[] = []
  /** @internal */ _onRollbackCallbacks: ((err: unknown) => void | Promise<void>)[] = []
  /** @internal */ declare _context?: Record<string, unknown>
  /** @internal */ _settled = false
  /** @internal */ _nest?: <T>(fn: (tx: TransactionClient) => Promise<T>) => Promise<T>
  /** @internal */ _parent?: TransactionClient

  constructor(sqlTx: InstanceType<typeof SQL>, hooks: ExecutorHooks = {}, dialect: Dialect = 'postgres') {
    super()
    this.sql = sqlTx
    this._dialect = dialect
    this._useHooks(hooks)
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

  atomic<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    return this.savepoint(fn)
  }

  /** Run `fn` in a savepoint of this transaction: the same as a `db.transaction()` called from inside its body. Throw to roll the savepoint back. */
  async savepoint<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    if (!this._nest)
      throw new ValidationError('savepoint() needs a transaction opened by db.transaction()', 'savepoint')

    this._assertOpen()

    return this._nest(fn)
  }

  override async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    this._assertOpen()

    return super.query(sqlStr, params)
  }

  override async copyIn(sqlStr: string, chunks: AsyncIterable<string>): Promise<number> {
    this._assertOpen()

    return super.copyIn(sqlStr, chunks)
  }

  override copyOut(sqlStr: string): ReadableStream<Uint8Array> {
    this._assertOpen()

    return super.copyOut(sqlStr)
  }

  private _assertOpen(): void {
    if (this._settled)
      throw new ValidationError('A query on a transaction that already committed or rolled back: work started in its body outlived it', 'transaction')
  }
}
