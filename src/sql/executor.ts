import type { MigrationOp } from '../migration/index'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, TableDef } from '../types/index'
import { SQL } from 'bun'
import { ConnectionError, DeadlockError, DestructiveOpError, wrapPgError } from '../errors/index'
import { clearMapperCache } from '../mapper/index'
import { diffSchema, introspectLiveSchema } from '../migration/index'
import { clearVirtualEntriesCache, Repository } from '../repo/index'

// --- Process cleanup for unclosed connections ---

const activeInstances = new Set<WeakRef<{ sql: InstanceType<typeof SQL> }>>()
let cleanupRegistered = false

function closeInstance(instance: { sql: InstanceType<typeof SQL> }): void {
  try {
    const closer = instance.sql as unknown as { close: (opts?: { timeout?: number }) => Promise<void> }

    // Fire-and-forget — process is exiting, we just need to initiate the close
    void closer.close({ timeout: 1000 })
  }
  catch {
    // best-effort — connection may already be closed
  }
}

function cleanup(): void {
  for (const ref of activeInstances) {
    const instance = ref.deref()

    if (instance)
      closeInstance(instance)
  }

  activeInstances.clear()
}

function registerCleanupHandlers(): void {
  if (cleanupRegistered)
    return

  cleanupRegistered = true

  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
  process.on('beforeExit', cleanup)
}

// --- Transaction isolation validation ---

const VALID_ISOLATION_LEVELS = new Set([
  'read uncommitted',
  'read committed',
  'repeatable read',
  'serializable',
])

const VALID_ACCESS_MODES = new Set([
  'read write',
  'read only',
])

// --- Typed unsafe query helper ---

interface UnsafeSql { unsafe: (q: string, p: unknown[]) => Promise<unknown[]> }

async function unsafeQuery(sql: InstanceType<typeof SQL>, sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  try {
    return await (sql as unknown as UnsafeSql).unsafe(sqlStr, params) as Record<string, unknown>[]
  }
  catch (err) {
    throw wrapPgError(err, sqlStr, params)
  }
}

// --- Query logging ---

export interface QueryEvent {
  sql: string
  params: unknown[]
  durationMs: number
}

// --- Connection & Pool Configuration ---

export interface SlowQueryEvent extends QueryEvent {
  threshold: number
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
  /** Statement timeout in milliseconds — applied to each connection */
  statementTimeout?: number
  /** Query logging callback — called after every query */
  onQuery?: (event: QueryEvent) => void
  /** Slow query callback — called when a query exceeds the threshold */
  onSlowQuery?: (event: SlowQueryEvent) => void
  /** Slow query threshold in milliseconds (default: 1000) */
  slowQueryThreshold?: number
  /** Called when ping() fails — useful for logging connection issues */
  onPingError?: (error: unknown) => void
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
  protected _slowQueryThreshold = 1000

  async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (this._onQuery || this._onSlowQuery) {
      const start = performance.now()
      const result = await unsafeQuery(this.sql, sqlStr, params)
      const durationMs = performance.now() - start

      if (this._onQuery)
        this._onQuery({ sql: sqlStr, params, durationMs })

      if (this._onSlowQuery && durationMs >= this._slowQueryThreshold)
        this._onSlowQuery({ sql: sqlStr, params, durationMs, threshold: this._slowQueryThreshold })

      return result
    }

    return unsafeQuery(this.sql, sqlStr, params)
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
  private _instanceRef: WeakRef<Database>

  constructor(config: DbConfig = {}) {
    super()
    const { pool, tables, cacheSize: _, schema, statementTimeout, onQuery, onSlowQuery, slowQueryThreshold, onPingError, retry, maxIncludeDepth, ...connOpts } = config
    const sqlOpts: Record<string, unknown> = {}

    this._onQuery = onQuery
    this._onSlowQuery = onSlowQuery

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
    this._maxIncludeDepth = maxIncludeDepth ?? 5

    for (const [key, val] of Object.entries(connOpts)) {
      if (val !== undefined)
        sqlOpts[key] = val
    }

    if (pool) {
      if (pool.max)
        sqlOpts.max = pool.max

      if (pool.idleTimeout)
        sqlOpts.idleTimeout = pool.idleTimeout

      if (pool.maxLifetime)
        sqlOpts.maxLifetime = pool.maxLifetime

      if (pool.connectionTimeout)
        sqlOpts.connectionTimeout = pool.connectionTimeout
    }

    this.sql = new SQL(sqlOpts as ConstructorParameters<typeof SQL>[0])

    // Register tables
    this._tables = new Map()

    if (tables) {
      for (const table of tables) {
        this._tables.set(table.name, table)
      }
    }

    // Track instance for process cleanup
    this._instanceRef = new WeakRef(this)
    activeInstances.add(this._instanceRef)
    registerCleanupHandlers()
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

  // Get the configured schema name
  get schema(): string {
    return this._schema
  }

  // Create a typed Repository for a table definition
  repo<
    TName extends string,
    TColumns extends AnyColumns,
    TRelations extends AnyRelations,
    TVirtuals extends AnyVirtuals,
  >(
    table: TableDef<TName, TColumns, TRelations, TVirtuals>,
  ): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>(table as AnyTableDef, this, this._tables, this._maxIncludeDepth)
  }

  // Auto-migrate: introspect live DB, diff against registered tables, apply DDL.
  // Uses pg_advisory_lock inside a transaction to prevent concurrent sync() calls.
  // Advisory locks acquired inside a transaction are auto-released on COMMIT/ROLLBACK,
  // guaranteeing same-connection acquire/release (avoids session-scoped lock leaks).
  async sync(opts?: { allowDestructive?: boolean, dryRun?: boolean }): Promise<{ sql: string, ops: MigrationOp[] }> {
    // Advisory lock key — consistent hash for "pg-orm-sync"
    const LOCK_KEY = 741953258

    // Phase 1: Run a preliminary diff on the pool to find enum ADD VALUE ops.
    // These can't run inside a transaction in PG < 16, so execute them first.
    // If they succeed but the main transaction fails, the enum values persist
    // harmlessly (skipped on retry via IF NOT EXISTS).
    if (!opts?.dryRun) {
      const preLive = await introspectLiveSchema(this, this._schema)
      const preOps = diffSchema(preLive, this._tables)
      const enumAddOps = preOps.filter(o => o.type === 'alter_enum_add')

      for (const op of enumAddOps) {
        await this.query(`${op.sql};`, [])
      }
    }

    // Phase 2: Acquire advisory lock + introspect + diff + apply DDL inside a
    // single transaction. The lock is transaction-scoped and auto-released on commit.
    return await (this.sql as unknown as {
      begin: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>
    }).begin(async (sqlTx) => {
      const txUnsafe = sqlTx as unknown as UnsafeSql

      // Acquire transaction-scoped advisory lock (auto-released on COMMIT/ROLLBACK).
      // pg_advisory_xact_lock is transaction-scoped — unlike pg_advisory_lock which
      // is session-scoped even when called inside a transaction.
      await txUnsafe.unsafe('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY])

      // Create a lightweight executor adapter for introspection queries
      const txExecutor: Executable = {
        query: async (sqlStr: string, params: unknown[]) => {
          return await txUnsafe.unsafe(sqlStr, params) as Record<string, unknown>[]
        },
        sql: sqlTx as InstanceType<typeof SQL>,
      }

      const live = await introspectLiveSchema(txExecutor, this._schema)
      const ops = diffSchema(live, this._tables)

      if (ops.length === 0)
        return { sql: '', ops: [] }

      const destructiveOps = ops.filter(o => o.destructive)

      if (destructiveOps.length && !opts?.allowDestructive) {
        throw new DestructiveOpError(
          `Sync contains ${destructiveOps.length} destructive operation(s). Use { allowDestructive: true } to proceed.`,
          'diff',
          destructiveOps.map(o => o.description),
        )
      }

      const sqlStr = ops.map(o => `${o.sql};`).join('\n')

      if (!opts?.dryRun) {
        // Filter out enum ADD VALUE ops (already applied in Phase 1)
        const otherOps = ops.filter(o => o.type !== 'alter_enum_add')

        for (const op of otherOps) {
          await txUnsafe.unsafe(`${op.sql};`, [])
        }
      }

      return { sql: sqlStr, ops }
    })
    // Advisory lock auto-released on transaction commit/rollback
  }

  // Get the internal tables registry
  getTablesRegistry(): ReadonlyMap<string, AnyTableDef> {
    return this._tables
  }

  // Raw SQL escape hatch.
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
    const parts = sqlOrStrings as TemplateStringsArray
    let sql = parts[0] ?? ''
    const params: unknown[] = []

    for (let i = 0; i < rest.length; i++) {
      params.push(rest[i])
      sql += `$${i + 1}${parts[i + 1] ?? ''}`
    }

    return await this.query(sql, params) as T[]
  }

  // Transaction support
  async transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async transaction<T>(opts: TransactionOptions, fn: (tx: TransactionClient) => Promise<T>): Promise<T>
  async transaction<T>(
    fnOrOpts: ((tx: TransactionClient) => Promise<T>) | TransactionOptions,
    maybeFn?: (tx: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const fn = typeof fnOrOpts === 'function' ? fnOrOpts : maybeFn!
    const opts = typeof fnOrOpts === 'object' ? fnOrOpts : undefined

    // Use bun:sql's native transaction support
    return await (this.sql as unknown as {
      begin: (fn: (tx: unknown) => Promise<T>) => Promise<T>
    }).begin(async (sqlTx) => {
      if (opts?.isolation) {
        if (!VALID_ISOLATION_LEVELS.has(opts.isolation))
          throw new Error(`Invalid isolation level: "${opts.isolation}"`)

        if (opts.accessMode && !VALID_ACCESS_MODES.has(opts.accessMode))
          throw new Error(`Invalid access mode: "${opts.accessMode}"`)

        await (sqlTx as unknown as UnsafeSql).unsafe(
          `SET TRANSACTION ISOLATION LEVEL ${opts.isolation.toUpperCase()}${opts.accessMode ? ` ${opts.accessMode.toUpperCase().replace('_', ' ')}` : ''}`,
          [],
        )
      }

      // Apply statement timeout if configured
      if (this._statementTimeout) {
        await (sqlTx as unknown as UnsafeSql).unsafe(
          `SET statement_timeout = ${Math.floor(this._statementTimeout)}`,
          [],
        )
      }

      const tx = new TransactionClient(sqlTx as InstanceType<typeof SQL>, this._onQuery, this._onSlowQuery, this._slowQueryThreshold)

      return await fn(tx)
    })
  }

  // Health check — returns true if the database is reachable
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
   * Query PostgreSQL for connection pool statistics.
   * Returns the number of active connections for the current database.
   *
   * Note: This queries `pg_stat_activity`, which shows server-side connection state.
   * Client-side pool metrics depend on the `bun:sql` driver internals.
   */
  async poolStats(): Promise<{ active: number, idle: number, total: number, maxConnections: number }> {
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

    activeInstances.delete(this._instanceRef)
    await (this.sql as unknown as { close: (opts?: { timeout?: number }) => Promise<void> }).close({ timeout: opts?.timeout })
  }

  private _draining = false

  /** Returns true if the database is draining (no new queries accepted). */
  get draining(): boolean {
    return this._draining
  }
}

// --- Transaction Client ---
// Same interface as Database — repos don't distinguish.

export interface TransactionOptions {
  isolation?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  accessMode?: 'read write' | 'read only'
}

export class TransactionClient extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>

  private _savepointCounter = 0

  constructor(sqlTx: InstanceType<typeof SQL>, onQuery?: (event: QueryEvent) => void, onSlowQuery?: (event: SlowQueryEvent) => void, slowQueryThreshold?: number) {
    super()
    this.sql = sqlTx
    this._onQuery = onQuery
    this._onSlowQuery = onSlowQuery

    if (slowQueryThreshold != null)
      this._slowQueryThreshold = slowQueryThreshold
  }

  async savepoint<T>(fn: (sp: SavepointClient) => Promise<T>): Promise<T> {
    const name = `sp_${++this._savepointCounter}`

    return await (this.sql as unknown as {
      savepoint: (fn: (sp: unknown) => Promise<T>) => Promise<T>
    }).savepoint(async (sqlSp) => {
      const sp = new SavepointClient(sqlSp as InstanceType<typeof SQL>, name, this._onQuery, this._onSlowQuery, this._slowQueryThreshold)

      return await fn(sp)
    })
  }
}

export class SavepointClient extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  readonly name: string

  constructor(sqlSp: InstanceType<typeof SQL>, name: string, onQuery?: (event: QueryEvent) => void, onSlowQuery?: (event: SlowQueryEvent) => void, slowQueryThreshold?: number) {
    super()
    this.sql = sqlSp
    this.name = name
    this._onQuery = onQuery
    this._onSlowQuery = onSlowQuery

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
