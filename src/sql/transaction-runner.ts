import type { SQL } from 'bun'
import type { QueryErrorEvent, QueryEvent, SlowQueryEvent } from './base-executor'
import type { TransactionOptions } from './transaction'
import { OrmError, wrapPgError } from '../errors/index'
import { asDriver } from './adapter'
import { queryContextStorage } from './base-executor'
import { TransactionClient } from './transaction'
import { applyIdleInTransactionTimeout, applyIsolation, applyStatementTimeout } from './tx-sql'

export interface TransactionHooks {
  onQuery?: (event: QueryEvent) => void
  onSlowQuery?: (event: SlowQueryEvent) => void
  onError?: (event: QueryErrorEvent) => void
  onCallbackError?: (event: { kind: 'onCommit' | 'onRollback' | 'streamWarning' | 'shutdownCloseError', error: unknown }) => void
  slowQueryThreshold?: number
}

/**
 * Owns `transaction()` overloads, transaction-local SET LOCAL statements,
 * and the post-settlement onCommit/onRollback callback dispatch. Holds the
 * ALS capture/replay logic so `Database.withContext` works inside a
 * transaction body even though bun:sql's `begin()` may not preserve
 * `AsyncLocalStorage` across its scheduling boundary.
 */
export class TransactionRunner {
  constructor(
    private readonly sql: InstanceType<typeof SQL>,
    private readonly hooks: TransactionHooks,
    private readonly statementTimeout?: number,
    private readonly idleInTransactionTimeout?: number,
  ) {}

  async run<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async run<T>(opts: TransactionOptions, fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async run<T>(
    fnOrOpts: ((tx: TransactionClient) => Promise<T>) | TransactionOptions,
    maybeFn?: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn!
    const opts = typeof fnOrOpts === 'object' ? fnOrOpts : undefined

    let txRef: TransactionClient | undefined
    let phase = 'begin' as 'begin' | 'body' | 'commit'

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

        if (this.statementTimeout !== undefined)
          await applyStatementTimeout(sqlTx, this.statementTimeout)

        if (this.idleInTransactionTimeout !== undefined)
          await applyIdleInTransactionTimeout(sqlTx, this.idleInTransactionTimeout)

        const tx = new TransactionClient(
          sqlTx,
          this.hooks.onQuery,
          this.hooks.onSlowQuery,
          this.hooks.slowQueryThreshold,
          this.hooks.onError,
        )

        if (opts?.context)
          tx._context = opts.context

        txRef = tx
        phase = 'body'

        const out = await fn(tx)

        phase = 'commit'

        return out
      }))

      if (txRef)
        await this._fireTxCallbacks('onCommit', txRef._onCommitCallbacks)

      return result
    }
    catch (caught) {
      // The body's own errors pass through untouched; a driver failure on BEGIN, SET LOCAL or COMMIT (a deferred constraint) gets the same typed mapping as any query.
      const err = phase === 'body' || caught instanceof OrmError
        ? caught
        : wrapPgError(caught, phase === 'begin' ? 'BEGIN' : 'COMMIT', [])

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

    this.hooks.onCallbackError?.({ kind, error })
  }
}
