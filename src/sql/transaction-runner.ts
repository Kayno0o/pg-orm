import type { SQL } from 'bun'
import type { QueryErrorEvent, QueryEvent, SlowQueryEvent } from './base-executor'
import type { TransactionOptions } from './transaction'
import { AsyncLocalStorage } from 'node:async_hooks'
import { OrmError, ValidationError, wrapPgError } from '../errors/index'
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

// The transaction whose body is running, so a `db.transaction()` called from inside it joins it instead of opening a second connection.
const activeTransaction = new AsyncLocalStorage<TransactionClient>()

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

  /** Whether a `transaction()` call with these options joins a transaction body running in this async context. */
  joins(opts?: TransactionOptions): boolean {
    return !opts?.independent && activeTransaction.getStore() !== undefined
  }

  async run<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async run<T>(opts: TransactionOptions, fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async run<T>(
    fnOrOpts: ((tx: TransactionClient) => Promise<T>) | TransactionOptions,
    maybeFn?: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn!
    const opts = typeof fnOrOpts === 'object' ? fnOrOpts : undefined
    const outer = activeTransaction.getStore()

    if (outer && this.joins(opts))
      return this._runNested(outer, fn, opts)

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

        const tx = this._client(sqlTx)

        if (opts?.context)
          tx._context = opts.context

        txRef = tx
        phase = 'body'

        const out = await activeTransaction.run(tx, () => fn(tx))

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

  // A nested call runs in a savepoint of the outer transaction: its writes commit or roll back with the outer one, and its own failure undoes only them. Its onCommit callbacks wait for the outer commit.
  private async _runNested<T>(outer: TransactionClient, fn: (tx: TransactionClient) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    if (opts?.isolation || opts?.accessMode)
      throw new ValidationError('transaction(): isolation and accessMode cannot change inside a running transaction, which this call joins (pass independent: true for a separate one).', 'transaction', { value: opts })

    let tx: TransactionClient | undefined

    try {
      const out = await asDriver(outer.sql).savepoint<T>(async (sqlSp) => {
        const inner = this._client(sqlSp)

        inner._context = opts?.context ?? outer._context
        tx = inner

        return activeTransaction.run(inner, () => fn(inner))
      })

      outer._onCommitCallbacks.push(...tx!._onCommitCallbacks)
      outer._onRollbackCallbacks.push(...tx!._onRollbackCallbacks)

      return out
    }
    catch (err) {
      if (tx)
        await this._fireTxCallbacks('onRollback', tx._onRollbackCallbacks, err)

      throw err
    }
  }

  private _client(sqlTx: InstanceType<typeof SQL>): TransactionClient {
    return new TransactionClient(sqlTx, this.hooks.onQuery, this.hooks.onSlowQuery, this.hooks.slowQueryThreshold, this.hooks.onError)
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
