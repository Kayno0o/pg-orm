import type { BaseBuilder } from '../builder/base'
import type { MigrationOp } from '../migration/index'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, TableDef } from '../types/index'
import { SQL } from 'bun'
import { DEFAULT_BATCH_CHUNK_SIZE, DEFAULT_MAX_INCLUDE_DEPTH } from '../constants'
import { ConnectionError, DeadlockError, setParamRedactor } from '../errors/index'
import { clearMapperCache } from '../mapper/index'
import { rollbackMigrations, syncSchema } from '../migration/index'
import { clearVirtualEntriesCache, Repository } from '../repo/index'
import { asDriver, unsafeQuery } from './adapter'
import { registerInstance, unregisterInstance } from './cleanup'

// --- Transaction isolation: static SQL mapping ---
// Composing SQL only from fixed strings (not user input + toUpperCase) eliminates
// any chance of injection even under future code changes.

const ISOLATION_SQL = {
  'read uncommitted': 'READ UNCOMMITTED',
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  'serializable': 'SERIALIZABLE',
} as const

const ACCESS_MODE_SQL = {
  'read write': 'READ WRITE',
  'read only': 'READ ONLY',
} as const

type IsolationLevel = keyof typeof ISOLATION_SQL
type AccessMode = keyof typeof ACCESS_MODE_SQL

// --- Query logging ---

export interface QueryEvent {
  sql: string
  params: unknown[]
  durationMs: number
  /** Optional request context for correlation (e.g., requestId, traceId). */
  context?: Record<string, unknown>
}

// --- Connection & Pool Configuration ---

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

export interface DbConfig {
  url?: string
  hostname?: string
  port?: number
  database?: string
  username?: string
  password?: string | (() => string | Promise<string>)
  pool?: {
    max?: number
    idleTimeout?: number
    maxLifetime?: number
    connectionTimeout?: number
  }
  tls?: boolean | object
  prepare?: boolean
  /** @deprecated No-op — bun:sql manages its own prepared statement cache */
  cacheSize?: number
  tables?: AnyTableDef[]
  /** Schema name for introspection queries (default: 'public') */
  schema?: string
  /** Maximum depth for nested `.include()` relation loading (default: 5) */
  maxIncludeDepth?: number
  /** Rows per IN (...) chunk in batched relation loading (default: 5000) */
  batchChunkSize?: number
  /** Statement timeout in milliseconds — applied to each connection */
  statementTimeout?: number
  /** Query logging callback — called after every query */
  onQuery?: (event: QueryEvent) => void
  /** Slow query callback — called when a query exceeds the threshold */
  onSlowQuery?: (event: SlowQueryEvent) => void
  /** Slow query threshold in milliseconds (default: 1000) */
  slowQueryThreshold?: number
  /** Called when any query fails — receives the error, SQL, and params */
  onError?: (event: QueryErrorEvent) => void
  /** Called when ping() fails — useful for logging connection issues */
  onPingError?: (error: unknown) => void
  /**
   * Scrub sensitive values from `QueryError.params` even outside production.
   * Receives the positional param array and returns the redacted copy.
   * Called for every QueryError-derived error. Throwing inside the function
   * causes params to be dropped entirely (empty array).
   */
  redactParams?: (params: unknown[]) => unknown[]
  /**
   * Default LIMIT applied to findMany() when no explicit .limit() is set.
   * Disabled by default (no limit). Set to a positive number to enable.
   */
  defaultLimit?: number
  /**
   * Retry transient connection errors (PG codes 08xxx, 57P01) with exponential backoff.
   *  Disabled by default. Set `maxRetries` to enable.
   */
  retry?: {
    /** Maximum number of retry attempts (default: 0, disabled) */
    maxRetries?: number
    /** Initial delay in milliseconds before first retry (default: 100) */
    baseDelayMs?: number
    /** Maximum delay between retries in milliseconds (default: 5000) */
    maxDelayMs?: number
  }
}

export interface Executable {
  /** bun:sql tagged template — used for raw queries */
  query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>
  /** bun:sql tagged template interface */
  sql: InstanceType<typeof SQL>
}

// --- Base Executor (shared query logic) ---

abstract class BaseExecutor implements Executable {
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

/**
 * Main database connection class. Manages the connection pool, table registry,
 * and provides methods for querying, transactions, migrations, and health checks.
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
  private _tables: Map<string, AnyTableDef>
  private _schema: string
  private _statementTimeout?: number
  private _pingErrorHandler?: (error: unknown) => void
  private _retryMaxRetries: number
  private _retryBaseDelay: number
  private _retryMaxDelay: number
  private _maxIncludeDepth: number
  private _batchChunkSize: number
  private _defaultLimit?: number
  private _instanceRef: ReturnType<typeof registerInstance>
  private _draining = false

  constructor(config: DbConfig = {}) {
    super()
    const { pool, tables, cacheSize: _, schema, statementTimeout, onQuery, onSlowQuery, onError, slowQueryThreshold, onPingError, retry, maxIncludeDepth, batchChunkSize, defaultLimit, redactParams, ...connOpts } = config
    const sqlOpts: Record<string, unknown> = {}

    this._onQuery = onQuery
    this._onSlowQuery = onSlowQuery
    this._onError = onError

    if (redactParams)
      setParamRedactor(redactParams)

    if (slowQueryThreshold != null)
      this._slowQueryThreshold = slowQueryThreshold

    this._schema = schema ?? 'public'

    if (statementTimeout !== undefined && (!Number.isFinite(statementTimeout) || statementTimeout < 0))
      throw new TypeError('statementTimeout must be a non-negative finite number')

    this._statementTimeout = statementTimeout
    this._pingErrorHandler = onPingError
    this._retryMaxRetries = retry?.maxRetries ?? 0
    this._retryBaseDelay = retry?.baseDelayMs ?? 100
    this._retryMaxDelay = retry?.maxDelayMs ?? 5000
    this._maxIncludeDepth = maxIncludeDepth ?? DEFAULT_MAX_INCLUDE_DEPTH
    this._batchChunkSize = batchChunkSize ?? DEFAULT_BATCH_CHUNK_SIZE
    this._defaultLimit = defaultLimit

    for (const [key, val] of Object.entries(connOpts)) {
      if (val !== undefined)
        sqlOpts[key] = val
    }

    if (pool) {
      if (pool.max !== undefined)
        sqlOpts.max = pool.max

      if (pool.idleTimeout !== undefined)
        sqlOpts.idleTimeout = pool.idleTimeout

      if (pool.maxLifetime !== undefined)
        sqlOpts.maxLifetime = pool.maxLifetime

      if (pool.connectionTimeout !== undefined)
        sqlOpts.connectionTimeout = pool.connectionTimeout
    }

    this.sql = new SQL(sqlOpts as ConstructorParameters<typeof SQL>[0])

    this._tables = new Map()

    if (tables) {
      for (const table of tables) {
        this._tables.set(table.name, table)
      }
    }

    this._instanceRef = registerInstance(this)
  }

  override async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (this._draining) {
      throw new ConnectionError('Database is draining — no new queries accepted')
    }

    if (this._retryMaxRetries <= 0) {
      return super.query(sqlStr, params)
    }

    let lastError: unknown

    for (let attempt = 0; attempt <= this._retryMaxRetries; attempt++) {
      try {
        return await super.query(sqlStr, params)
      }
      catch (err) {
        lastError = err

        if (attempt < this._retryMaxRetries && (err instanceof ConnectionError || err instanceof DeadlockError)) {
          const baseDelay = Math.min(this._retryBaseDelay * 2 ** attempt, this._retryMaxDelay)
          const delay = baseDelay * (0.5 + Math.random() * 0.5)

          await new Promise(resolve => setTimeout(resolve, delay))

          continue
        }

        throw err
      }
    }

    throw lastError
  }

  get schema(): string {
    return this._schema
  }

  /** Returns true if the database is draining (no new queries accepted). */
  get draining(): boolean {
    return this._draining
  }

  /** Create a typed Repository for a table definition. */
  repo<
    TName extends string,
    TColumns extends AnyColumns,
    TRelations extends AnyRelations,
    TVirtuals extends AnyVirtuals,
  >(
    table: TableDef<TName, TColumns, TRelations, TVirtuals>,
  ): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>(table as AnyTableDef, this, this._tables, this._maxIncludeDepth, this._defaultLimit, this._batchChunkSize)
  }

  /**
   * Auto-migrate: introspect the live DB, diff against registered tables, and apply DDL.
   * Pass `{ dryRun: true }` to preview changes; `{ allowDestructive: true }` to allow DROP/RENAME;
   * `{ confirm: true }` to show SQL and prompt for confirmation.
   */
  async sync(opts?: { allowDestructive?: boolean, dryRun?: boolean, confirm?: boolean }): Promise<{ sql: string, ops: MigrationOp[] }> {
    return syncSchema(
      { query: (s, p) => this.query(s, p), sql: this.sql, schema: this._schema, tables: this._tables },
      opts,
    )
  }

  /** Rollback the last N migrations by executing their down SQL. */
  async rollback(count = 1): Promise<{ rolledBack: string[], sql: string }> {
    return rollbackMigrations(
      { query: (s, p) => this.query(s, p), sql: this.sql },
      count,
    )
  }

  // Get the internal tables registry
  getTablesRegistry(): ReadonlyMap<string, AnyTableDef> {
    return this._tables
  }

  /**
   * Execute raw SQL. Supports tagged template literals or plain strings with params.
   * @example
   * ```ts
   * const rows = await db.raw`SELECT * FROM users WHERE id = ${id}`
   * const rows = await db.raw('SELECT * FROM users WHERE id = $1', [id])
   * ```
   */
  raw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  raw<T = unknown>(sqlStr: string, params?: unknown[]): Promise<T[]>
  async raw<T = unknown>(
    sqlOrStrings: string | TemplateStringsArray,
    ...rest: unknown[]
  ): Promise<T[]> {
    if (typeof sqlOrStrings === 'string') {
      return await this.query(sqlOrStrings, rest[0] as unknown[] ?? []) as T[]
    }

    // Tagged template: assemble SQL with $N placeholders
    const parts = sqlOrStrings
    let sql = parts[0] ?? ''
    const params: unknown[] = []

    for (let i = 0; i < rest.length; i++) {
      params.push(rest[i])
      sql += `$${i + 1}${parts[i + 1] ?? ''}`
    }

    return await this.query(sql, params) as T[]
  }

  /**
   * Run a callback inside a database transaction. Auto-commits on success, rolls back on error.
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
  async transaction<T>(
    fnOrOpts: ((tx: TransactionClient) => Promise<T>) | TransactionOptions,
    maybeFn?: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn!
    const opts = typeof fnOrOpts === 'object' ? fnOrOpts : undefined

    let txRef: TransactionClient | undefined

    try {
      const result = await asDriver(this.sql).begin<T>(async (sqlTx) => {
        if (opts?.isolation) {
          const isolationSql = ISOLATION_SQL[opts.isolation as IsolationLevel]

          if (!isolationSql)
            throw new Error(`Invalid isolation level: "${opts.isolation}"`)

          let stmt = `SET TRANSACTION ISOLATION LEVEL ${isolationSql}`

          if (opts.accessMode) {
            const accessSql = ACCESS_MODE_SQL[opts.accessMode as AccessMode]

            if (!accessSql)
              throw new Error(`Invalid access mode: "${opts.accessMode}"`)

            stmt += ` ${accessSql}`
          }

          await asDriver(sqlTx).unsafe(stmt, [])
        }

        if (this._statementTimeout !== undefined) {
          // set_config('statement_timeout', ..., true) is the transaction-local
          // equivalent of `SET LOCAL` — but it accepts a bound param, so timeout
          // can never be injected as SQL text.
          await asDriver(sqlTx).unsafe(
            'SELECT set_config($1, $2, true)',
            ['statement_timeout', String(Math.floor(this._statementTimeout))],
          )
        }

        const tx = new TransactionClient(sqlTx, this._onQuery, this._onSlowQuery, this._slowQueryThreshold, this._onError)

        if (opts?.context)
          tx._context = opts.context

        txRef = tx

        return fn(tx)
      })

      // Transaction committed — fire onCommit callbacks
      if (txRef) {
        for (const cb of txRef._onCommitCallbacks) {
          try {
            await cb()
          }
          catch { /* best-effort — commit already happened */ }
        }
      }

      return result
    }
    catch (err) {
      // Transaction rolled back — fire onRollback callbacks
      if (txRef) {
        for (const cb of txRef._onRollbackCallbacks) {
          try {
            await cb(err)
          }
          catch { /* best-effort */ }
        }
      }

      throw err
    }
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

  invalidateCache(): void {
    clearMapperCache()
    clearVirtualEntriesCache()
  }

  /** Close the database connection pool. Pass `drain: true` to reject new queries before closing. */
  async close(opts?: { timeout?: number, drain?: boolean }): Promise<void> {
    if (opts?.drain) {
      this._draining = true
    }

    unregisterInstance(this._instanceRef)
    await asDriver(this.sql).close({ timeout: opts?.timeout })
  }

  /**
   * Create a scoped database instance that attaches context to all query events.
   * Useful for correlating queries to HTTP requests, trace IDs, etc.
   */
  withContext(ctx: Record<string, unknown>): Database {
    const scoped = Object.create(this) as Database

    scoped._context = ctx

    return scoped
  }
}

// --- Transaction Client ---

export interface TransactionOptions {
  isolation?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  accessMode?: 'read write' | 'read only'
  /** Optional context propagated to all QueryEvents within this transaction. */
  context?: Record<string, unknown>
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

  /** Register a callback to run after the transaction commits successfully. */
  onCommit(fn: () => void | Promise<void>): void {
    this._onCommitCallbacks.push(fn)
  }

  /** Register a callback to run after the transaction rolls back. */
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

// Re-export for the array-serializer unit test.
export { serializePgArray } from './adapter'
