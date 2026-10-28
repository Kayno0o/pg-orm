import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import type { ExecutorHooks } from './base-executor'
import type { TransactionOptions } from './transaction'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DeadlockError, OrmError, SerializationError, ValidationError, wrapPgError } from '../errors/index'
import { querySignalStorage, sleepUnlessAborted, throwIfAborted } from './abort'
import { asDriver } from './adapter'
import { queryContextStorage, reportCallbackError } from './base-executor'
import { validateRetry } from './config'
import { computeBackoff } from './retry'
import { TransactionClient } from './transaction'
import { applyIsolation, isolationStatement } from './tx-sql'

export type TransactionHooks = ExecutorHooks

/**
 * Owns `transaction()` overloads, the isolation and access mode, retries,
 * and the post-settlement onCommit/onRollback callback dispatch. Holds the
 * ALS capture/replay logic so `Database.withContext` works inside a
 * transaction body even though bun:sql's `begin()` may not preserve
 * `AsyncLocalStorage` across its scheduling boundary.
 */
export class TransactionRunner {
  constructor(
    private readonly sql: InstanceType<typeof SQL>,
    private readonly hooks: TransactionHooks,
    private readonly dialect: Dialect = 'postgres',
    // Captures a scope of the caller's that the body re-enters, as it does `withContext`'s: the drain's mark letting this transaction's own pool queries through.
    private readonly captureScope: () => <R>(body: () => Promise<R>) => Promise<R> = () => body => body(),
  ) {}

  // The transaction whose body is running, so a `db.transaction()` called from inside it joins it instead of opening a second connection. Per runner: a body of one Database never joins another's.
  private readonly _active = new AsyncLocalStorage<TransactionClient>()
  // The last nested call started on each outer transaction: the next one waits for it, since two savepoints cannot interleave on one connection.
  private readonly _nestedTail = new WeakMap<TransactionClient, Promise<unknown>>()

  /** Whether a `transaction()` call with these options joins a transaction body running in this async context. A transaction that settled is not joined, even from work its body started. */
  joins(opts?: TransactionOptions): boolean {
    return !opts?.independent && this._joinable() !== undefined
  }

  private _joinable(): TransactionClient | undefined {
    const active = this._active.getStore()

    return active && !active._settled ? active : undefined
  }

  async run<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async run<T>(opts: TransactionOptions, fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async run<T>(
    fnOrOpts: ((tx: TransactionClient) => Promise<T>) | TransactionOptions,
    maybeFn?: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn!
    const opts = typeof fnOrOpts === 'object' ? fnOrOpts : undefined
    const outer = this._joinable()
    const signal = querySignalStorage.getStore()

    throwIfAborted(signal)

    if (outer && this.joins(opts))
      return this._runNested(outer, fn, opts)

    // Refused before BEGIN goes out, rather than failing a transaction already open.
    validateRetry(opts?.retry, 'transaction.retry')
    isolationStatement(opts ?? {})

    // Capture the ALS-bound context at the call site so the tx body re-enters
    // the same scope. bun:sql's `begin()` schedules its callback through a path
    // that may not preserve `AsyncLocalStorage` propagation; pinning the scope
    // here keeps `Database.withContext` and `Database.withSignal` working inside transactions.
    const ambientContext = queryContextStorage.getStore()
    const inScope = this.captureScope()
    const withSignal = <R>(body: () => Promise<R>): Promise<R> => signal ? querySignalStorage.run(signal, body) : body()
    const runInContext = <R>(body: () => Promise<R>): Promise<R> =>
      inScope(() => ambientContext ? queryContextStorage.run(ambientContext, () => withSignal(body)) : withSignal(body))
    const maxRetries = opts?.retry?.maxRetries ?? 0

    for (let attempt = 0; ; attempt++) {
      const outcome = await this._attempt(fn, opts, runInContext)

      // Outside any try: the transaction committed, and nothing its callbacks do can report it failed.
      if (outcome.ok) {
        await this._fireTxCallbacks('onCommit', outcome.tx._onCommitCallbacks)

        return outcome.result
      }

      let error = outcome.error

      if (attempt < maxRetries && (error instanceof SerializationError || error instanceof DeadlockError)) {
        try {
          await sleepUnlessAborted(computeBackoff(attempt, opts?.retry?.baseDelayMs ?? 100, opts?.retry?.maxDelayMs ?? 5000), signal)

          continue
        }
        catch (aborted) {
          error = aborted
        }
      }

      if (outcome.tx)
        await this._fireTxCallbacks('onRollback', outcome.tx._onRollbackCallbacks, error)

      throw error
    }
  }

  private async _attempt<T>(
    fn: (tx: TransactionClient) => Promise<T>,
    opts: TransactionOptions | undefined,
    runInContext: <R>(body: () => Promise<R>) => Promise<R>,
  ): Promise<{ ok: true, result: T, tx: TransactionClient } | { ok: false, error: unknown, tx?: TransactionClient }> {
    let txRef: TransactionClient | undefined
    let phase = 'begin' as 'begin' | 'body' | 'commit'

    try {
      const result = await asDriver(this.sql).begin<T>(async sqlTx => runInContext(async () => {
        await applyIsolation(sqlTx, opts ?? {}, this.dialect)

        const tx = this._client(sqlTx)

        if (opts?.context)
          tx._context = opts.context

        txRef = tx
        phase = 'body'

        let out: T

        try {
          out = await this._active.run(tx, () => fn(tx))
        }
        catch (err) {
          await this._leaveReadOnly(sqlTx, opts, true)

          throw err
        }

        await this._leaveReadOnly(sqlTx, opts, false)
        phase = 'commit'

        return out
      }))

      return { ok: true, result, tx: txRef! }
    }
    catch (caught) {
      // The body's own errors pass through untouched; a driver failure on BEGIN, SET TRANSACTION or COMMIT (a deferred constraint) gets the same typed mapping as any query.
      const error = phase === 'body' || caught instanceof OrmError
        ? caught
        : wrapPgError(caught, phase === 'begin' ? 'BEGIN' : 'COMMIT', [])

      return { ok: false, error, tx: txRef }
    }
    finally {
      if (txRef)
        txRef._settled = true
    }
  }

  // SQLite has no read-only transaction: `query_only` stands in for one, and is lifted before the commit. A failure to lift it never hides the body's own error.
  private async _leaveReadOnly(sqlTx: InstanceType<typeof SQL>, opts: TransactionOptions | undefined, bodyFailed: boolean): Promise<void> {
    if (this.dialect !== 'sqlite' || opts?.accessMode !== 'read only')
      return

    try {
      await asDriver(sqlTx).unsafe('PRAGMA query_only = OFF', [])
    }
    catch (err) {
      if (!bodyFailed)
        throw err
    }
  }

  // A nested call runs in a savepoint of the outer transaction: its writes commit or roll back with the outer one, and its own failure undoes only them. Its onCommit callbacks wait for the outer commit.
  private async _runNested<T>(outer: TransactionClient, fn: (tx: TransactionClient) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    if (opts?.isolation || opts?.accessMode || opts?.retry)
      throw new ValidationError('transaction(): isolation, accessMode and retry cannot apply inside a running transaction, which this call joins (pass independent: true for a separate one).', 'transaction', { value: opts })

    // Savepoints on one connection run one after another, so one opened on an outer client from inside its running savepoint would wait for that savepoint forever.
    if (this._insideSavepointOf(outer))
      throw new ValidationError('savepoint(): called on an outer transaction client from inside one of its savepoints, which it would wait for forever: use the client the savepoint body was given.', 'savepoint')

    const previous = this._nestedTail.get(outer)
    const current = this._afterSettled(previous, () => this._savepoint(outer, fn, opts))

    this._nestedTail.set(outer, current)

    return current
  }

  private _insideSavepointOf(outer: TransactionClient): boolean {
    const active = this._active.getStore()

    if (!active || active === outer || active._settled)
      return false

    for (let tx = active._parent; tx; tx = tx._parent) {
      if (tx === outer)
        return true
    }

    return false
  }

  private async _afterSettled<T>(previous: Promise<unknown> | undefined, run: () => Promise<T>): Promise<T> {
    try {
      await previous
    }
    catch {
      // an earlier sibling's failure is its caller's to handle
    }

    return run()
  }

  private async _savepoint<T>(outer: TransactionClient, fn: (tx: TransactionClient) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    let tx: TransactionClient | undefined
    let phase = 'open' as 'open' | 'body' | 'release'

    try {
      const out = await asDriver(outer.sql).savepoint<T>(async (sqlSp) => {
        const inner = this._client(sqlSp)

        inner._parent = outer
        inner._context = opts?.context ?? outer._context
        tx = inner
        phase = 'body'

        const result = await this._active.run(inner, () => fn(inner))

        phase = 'release'

        return result
      })

      outer._onCommitCallbacks.push(...tx!._onCommitCallbacks)
      outer._onRollbackCallbacks.push(...tx!._onRollbackCallbacks)

      return out
    }
    catch (caught) {
      // As for BEGIN and COMMIT: the body's own errors pass through, a driver failure on SAVEPOINT or RELEASE gets the typed mapping.
      const err = phase === 'body' || caught instanceof OrmError
        ? caught
        : wrapPgError(caught, phase === 'open' ? 'SAVEPOINT' : 'RELEASE SAVEPOINT', [])

      if (tx)
        await this._fireTxCallbacks('onRollback', tx._onRollbackCallbacks, err)

      throw err
    }
    finally {
      if (tx)
        tx._settled = true
    }
  }

  private _client(sqlTx: InstanceType<typeof SQL>): TransactionClient {
    const tx = new TransactionClient(sqlTx, this.hooks, this.dialect)

    tx._nest = fn => this._runNested(tx, fn)

    return tx
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

    reportCallbackError(this.hooks.onCallbackError, { kind, error })
  }
}
