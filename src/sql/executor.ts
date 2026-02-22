import type { MigrationOp } from '../migration/index'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, TableDef } from '../types/index'
import { SQL } from 'bun'
import { DestructiveOpError, wrapPgError } from '../errors/index'
import { clearMapperCache } from '../mapper/index'
import { diffSchema, introspectLiveSchema } from '../migration/index'
import { Repository } from '../repo/index'

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
  /** Statement timeout in milliseconds — applied to each connection */
  statementTimeout?: number
  /** Query logging callback — called after every query */
  onQuery?: (event: QueryEvent) => void
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

  async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    if (this._onQuery) {
      const start = performance.now()
      const result = await unsafeQuery(this.sql, sqlStr, params)

      this._onQuery({ sql: sqlStr, params, durationMs: performance.now() - start })

      return result
    }

    return unsafeQuery(this.sql, sqlStr, params)
  }
}

// --- Database Instance ---

export class Database extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  private _tables: Map<string, AnyTableDef>
  private _schema: string
  private _statementTimeout?: number

  constructor(config: DbConfig = {}) {
    super()
    const { pool, tables, cacheSize: _, schema, statementTimeout, onQuery, ...connOpts } = config
    const sqlOpts: Record<string, unknown> = {}

    this._onQuery = onQuery
    this._schema = schema ?? 'public'
    this._statementTimeout = statementTimeout

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
    return new Repository<TColumns, TRelations, TVirtuals>(table as AnyTableDef, this, this._tables)
  }

  // Auto-migrate: introspect live DB, diff against registered tables, apply DDL
  async sync(opts?: { allowDestructive?: boolean, dryRun?: boolean }): Promise<{ sql: string, ops: MigrationOp[] }> {
    // Lazy import to avoid circular dependency
    const live = await introspectLiveSchema(this, this._schema)
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
      // Separate enum ADD VALUE ops (can't run inside a transaction in PG < 16)
      const enumAddOps = ops.filter(o => o.type === 'alter_enum_add')
      const otherOps = ops.filter(o => o.type !== 'alter_enum_add')

      // Run enum ADD VALUE ops outside transaction
      for (const op of enumAddOps) {
        await this.query(`${op.sql};`, [])
      }

      // Run remaining DDL in a transaction via bun:sql's native begin()
      if (otherOps.length > 0) {
        await (this.sql as unknown as {
          begin: (fn: (tx: unknown) => Promise<void>) => Promise<void>
        }).begin(async (sqlTx) => {
          for (const op of otherOps) {
            await (sqlTx as unknown as UnsafeSql).unsafe(`${op.sql};`, [])
          }
        })
      }
    }

    return { sql: sqlStr, ops }
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
          `SET statement_timeout = ${this._statementTimeout}`,
          [],
        )
      }

      const tx = new TransactionClient(sqlTx as InstanceType<typeof SQL>, this._onQuery)

      return await fn(tx)
    })
  }

  // Health check — returns true if the database is reachable
  async ping(): Promise<boolean> {
    try {
      await this.query('SELECT 1', [])

      return true
    }
    catch {
      return false
    }
  }

  invalidateCache(): void {
    clearMapperCache()
  }

  async close(opts?: { timeout?: number }): Promise<void> {
    await (this.sql as unknown as { close: (opts?: { timeout?: number }) => Promise<void> }).close(opts)
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

  constructor(sqlTx: InstanceType<typeof SQL>, onQuery?: (event: QueryEvent) => void) {
    super()
    this.sql = sqlTx
    this._onQuery = onQuery
  }

  async savepoint<T>(fn: (sp: SavepointClient) => Promise<T>): Promise<T> {
    const name = `sp_${++this._savepointCounter}`

    return await (this.sql as unknown as {
      savepoint: (fn: (sp: unknown) => Promise<T>) => Promise<T>
    }).savepoint(async (sqlSp) => {
      const sp = new SavepointClient(sqlSp as InstanceType<typeof SQL>, name, this._onQuery)

      return await fn(sp)
    })
  }
}

export class SavepointClient extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  readonly name: string

  constructor(sqlSp: InstanceType<typeof SQL>, name: string, onQuery?: (event: QueryEvent) => void) {
    super()
    this.sql = sqlSp
    this.name = name
    this._onQuery = onQuery
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
