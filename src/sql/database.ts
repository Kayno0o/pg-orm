import type { SQL } from 'bun'
import type { BaseBuilder } from '../builder/base'
import type { MigrationOp } from '../migration/index'
import type { SyncOptions } from '../migration/sync'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, TableDef } from '../types/index'
import type { DbConfig } from './config'
import type { TransactionClient, TransactionOptions } from './transaction'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH } from '../constants'
import { setParamRedactor } from '../errors/index'
import { clearMapperCache } from '../mapper/index'
import { Repository } from '../repo/index'
import { BaseExecutor, queryContextStorage } from './base-executor'
import { normalizeDbConfig, validateDbConfig } from './config'
import { ConnectionLifecycle } from './connection-lifecycle'
import { composeQueryLogger } from './format-query'
import { MigrationRunner } from './migration-runner'
import { RawRunner } from './raw-runner'
import { TransactionRunner } from './transaction-runner'

export type { DbConfig } from './config'

/**
 * Main database connection class. Manages the connection pool, table registry,
 * and provides methods for querying, transactions, migrations, and health checks.
 *
 * Public surface is unchanged: behind the scenes the work is split across a
 * `ConnectionLifecycle` (pool + drain + retry), a `TransactionRunner`
 * (transaction body + post-settlement callbacks), a `RawRunner` (`raw()`),
 * and a `MigrationRunner` (`sync`/`rollback`). `Database` itself is a thin
 * facade that wires them together.
 *
 * @example
 * ```ts
 * const db = new Database({
 *   url: 'postgres://user:pass@localhost:5432/mydb',
 *   tables: [users, posts],
 *   pool: { max: 10 },
 * })
 * await db.sync() // auto-migrate
 * const repo = db.repo(users) // create repository
 * await db.close() // cleanup
 * ```
 */
export class Database extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  private _connection: ConnectionLifecycle
  private _txRunner: TransactionRunner
  private _rawRunner: RawRunner
  private _tables: Map<string, AnyTableDef>
  private _maxIncludeDepth: number
  private _batchChunkSize: number
  private _defaultLimit?: number
  // @internal — read by stream-suite for the streamWarning channel.
  _onCallbackError?: DbConfig['onCallbackError']
  private _migrations?: MigrationRunner
  private _repoCache = new WeakMap<AnyTableDef, { version: number, repo: unknown }>()

  constructor(config: DbConfig = {}) {
    super()
    validateDbConfig(config)

    if (config.redactParams)
      setParamRedactor(config.redactParams)

    const hooks = {
      onQuery: composeQueryLogger(config.debug, config.onQuery),
      onSlowQuery: config.onSlowQuery,
      onError: config.onError,
      onCallbackError: config.onCallbackError,
      slowQueryThreshold: config.slowQueryThreshold,
    }

    this._connection = new ConnectionLifecycle(
      normalizeDbConfig(config) as ConstructorParameters<typeof SQL>[0],
      config.schema ?? 'public',
      {
        maxRetries: config.retry?.maxRetries ?? 0,
        baseDelayMs: config.retry?.baseDelayMs ?? 100,
        maxDelayMs: config.retry?.maxDelayMs ?? 5000,
      },
      { ...hooks, onPingError: config.onPingError },
    )

    this.sql = this._connection.sql

    this._txRunner = new TransactionRunner(
      this._connection.sql,
      hooks,
      config.statementTimeout,
      config.idleInTransactionTimeout,
    )

    this._rawRunner = new RawRunner((s, p) => this.query(s, p))

    this._onCallbackError = config.onCallbackError
    this._maxIncludeDepth = config.maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    this._batchChunkSize = config.batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE
    this._defaultLimit = config.defaultLimit

    this._tables = new Map()

    if (config.tables) {
      for (const table of config.tables)
        this._tables.set(table.name, table)
    }
  }

  override query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this._connection.query(sqlStr, params)
  }

  get schema(): string {
    return this._connection.schema
  }

  /** Returns true if the database is draining (no new queries accepted). */
  get draining(): boolean {
    return this._connection.draining
  }

  /**
   * Create a typed Repository for a table definition.
   *
   * Repositories are memoized per table def, so calling `db.repo(users)` inline
   * on every request is free. The cache is keyed weakly and invalidated when the
   * table def is mutated (`withRelations`, `withVirtuals`, `withTrait`, `hook`).
   */
  repo<
    TName extends string,
    TColumns extends AnyColumns,
    TRelations extends AnyRelations,
    TVirtuals extends AnyVirtuals,
  >(
    table: TableDef<TName, TColumns, TRelations, TVirtuals>,
  ): Repository<TColumns, TRelations, TVirtuals> {
    const def = table as AnyTableDef
    const cached = this._repoCache.get(def)

    if (cached && cached.version === def._version)
      return cached.repo as Repository<TColumns, TRelations, TVirtuals>

    const created = new Repository<TColumns, TRelations, TVirtuals>({
      table: def,
      executor: this,
      tableRegistry: this._tables,
      maxIncludeDepth: this._maxIncludeDepth,
      defaultLimit: this._defaultLimit,
      batchChunkSize: this._batchChunkSize,
    })

    this._repoCache.set(def, { version: def._version, repo: created })

    return created
  }

  /** Lazy-built `MigrationRunner` — owns `sync` / `rollback`. */
  private get migrations(): MigrationRunner {
    return this._migrations ??= new MigrationRunner(
      (s, p) => this.query(s, p),
      this._connection.sql,
      this._connection.schema,
      this._tables,
      fn => this._connection.track(fn),
    )
  }

  /**
   * Auto-migrate: introspect the live DB, diff against registered tables, and apply DDL.
   * Pass `{ dryRun: true }` to preview changes; `{ allowDestructive: true }` to allow DROP/RENAME;
   * `{ confirm: true }` to show SQL and prompt for confirmation.
   */
  async sync(opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
    return this.migrations.sync(opts)
  }

  /** Rollback the last N migrations by executing their down SQL. */
  async rollback(count = 1): Promise<{ rolledBack: string[], sql: string }> {
    return this.migrations.rollback(count)
  }

  // Get the internal tables registry
  getTablesRegistry(): ReadonlyMap<string, AnyTableDef> {
    return this._tables
  }

  /**
   * Execute raw SQL. Supports tagged template literals or plain strings with params.
   *
   * @trusted The SQL string is sent verbatim to the driver. Tagged-template usage
   * automatically parameterizes interpolated values, but the SQL skeleton itself
   * must be developer-authored — never assemble it from user input.
   * @example
   * ```ts
   * const rows = await db.raw`SELECT * FROM users WHERE id = ${id}`
   * const rows = await db.raw('SELECT * FROM users WHERE id = $1', [id])
   * ```
   */
  raw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  raw<T = unknown>(sqlStr: string, params?: unknown[]): Promise<T[]>
  raw<T = unknown>(
    sqlOrStrings: string | TemplateStringsArray,
    ...rest: unknown[]
  ): Promise<T[]> {
    return this._rawRunner.run<T>(sqlOrStrings as TemplateStringsArray, ...rest)
  }

  /**
   * Run a callback inside a database transaction. Auto-commits on success, rolls back on error.
   * Called from inside a running transaction body, it joins that transaction in a savepoint: its writes commit or roll back with the outer one, and its onCommit callbacks wait for the outer commit. `independent: true` opens a separate transaction instead.
   * @example
   * ```ts
   * await db.transaction({ isolation: 'serializable' }, async (tx) => {
   *   const repo = userRepo.using(tx)
   *   await repo.updateOne({ balance: 0 }, e => e.eq('id', 1))
   * })
   * ```
   */
  async transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async transaction<T>(opts: TransactionOptions, fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  transaction<T>(
    fnOrOpts: ((tx: TransactionClient) => Promise<T>) | TransactionOptions,
    maybeFn?: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const run = (): Promise<T> => typeof fnOrOpts === 'function'
      ? this._txRunner.run(fnOrOpts)
      : this._txRunner.run(fnOrOpts, maybeFn!)

    // A nested call joins the running transaction, which the drain already tracks.
    return this._txRunner.joins(typeof fnOrOpts === 'function' ? undefined : fnOrOpts) ? run() : this._connection.track(run)
  }

  /** Health check — returns true if the database is reachable. */
  ping(): Promise<boolean> {
    return this._connection.ping()
  }

  /**
   * Run EXPLAIN (FORMAT JSON) on a query builder and return the parsed plan
   * along with the rendered SQL and params (useful for logging and tooling).
   */
  async explain(
    builder: BaseBuilder,
    opts?: { analyze?: boolean },
  ): Promise<{ sql: string, params: unknown[], plan: unknown }> {
    const { sql, params } = builder.explain(opts)
    const rows = await this.query(sql, params)
    const plan = rows[0]?.['QUERY PLAN']

    return { sql, params, plan }
  }

  /**
   * Query PostgreSQL for connection pool statistics from `pg_stat_activity`.
   * Note: this is server-side state; client-side bun:sql metrics are not exposed.
   */
  getPoolStats(): Promise<{ active: number, idle: number, total: number, maxConnections: number }> {
    return this._connection.getPoolStats()
  }

  /**
   * Invalidate process-global JIT mapper caches and this database's memoized
   * repositories.
   *
   * Virtual entries are materialized once per `Repository` at construction, so
   * dropping the repository cache re-materializes them on the next `repo()`
   * call. The mapper cache remains module-scoped pending a follow-up; this
   * method clears it across every `Database` instance in the process.
   */
  invalidateCache(): void {
    clearMapperCache()
    this._repoCache = new WeakMap()
  }

  /**
   * Close the database connection pool.
   *
   * - `drain: true` rejects *new* queries, transactions and migrations (with
   *   `ConnectionError`) and waits for in-flight ones to settle before invoking
   *   the driver close.
   * - `timeout` (ms) acts as a hard ceiling on the drain wait. If the timeout
   *   fires before the in-flight count reaches zero, the driver close is invoked
   *   anyway with the same `timeout` forwarded.
   */
  close(opts?: { timeout?: number, drain?: boolean }): Promise<void> {
    return this._connection.close(opts)
  }

  /**
   * Run `fn` with `ctx` bound to async-local storage. Every query emitted
   * inside `fn` (including queries from repos, builders, and nested
   * `transaction()` calls) gets `ctx` attached to its `QueryEvent`,
   * `SlowQueryEvent`, and `QueryErrorEvent` automatically — no need to thread
   * a scoped Database through your call graph.
   *
   * Nested calls merge: inner keys override outer keys. An explicit
   * `transaction({ context })` overrides keys that overlap with the ambient
   * context for queries inside that transaction.
   *
   * @example
   * ```ts
   * app.use((req, _res, next) => {
   *   db.withContext({ requestId: req.id, userId: req.user?.id }, async () => {
   *     await next() // queries inside this scope carry the context
   *   })
   * })
   * ```
   */
  withContext<T>(ctx: Record<string, unknown>, fn: () => Promise<T> | T): Promise<T> {
    const outer = queryContextStorage.getStore()
    const merged = outer ? { ...outer, ...ctx } : ctx

    return Promise.resolve(queryContextStorage.run(merged, fn))
  }
}
