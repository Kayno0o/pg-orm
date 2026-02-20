import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, TableDef } from '../types/index'
import { SQL } from 'bun'
import { wrapPgError } from '../errors/index'
import { clearMapperCache, getOrCompileMapper } from '../mapper/index'
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

  async query(sqlStr: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return unsafeQuery(this.sql, sqlStr, params)
  }
}

// --- Database Instance ---

export class Database extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  private _tables: Map<string, AnyTableDef>

  constructor(config: DbConfig = {}) {
    super()
    const { pool, tables, cacheSize: _, ...connOpts } = config
    const sqlOpts: Record<string, unknown> = {}

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
  async sync(opts?: { allowDestructive?: boolean, dryRun?: boolean }): Promise<{ sql: string, ops: import('../migration/index').MigrationOp[] }> {
    // Lazy import to avoid circular dependency
    const { introspectLiveSchema, diffSchema } = await import('../migration/index')
    const live = await introspectLiveSchema(this)
    const ops = diffSchema(live, this._tables)

    if (ops.length === 0)
      return { sql: '', ops: [] }

    const { DestructiveOpError } = await import('../errors/index')
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
      await this.query(sqlStr, [])
    }

    return { sql: sqlStr, ops }
  }

  // Get the internal tables registry
  getTablesRegistry(): ReadonlyMap<string, AnyTableDef> {
    return this._tables
  }

  async execute<T>(builder: { _state: { op: string, table: string, columns: string[] | null, omitColumns: string[] }, toSQL: () => { sql: string, params: unknown[] } }, table: AnyTableDef): Promise<T[]> {
    const { sql: sqlStr, params } = builder.toSQL()
    const rows = await this.query(sqlStr, params)

    // Apply JIT mapper
    const mapper = getOrCompileMapper(
      table.name,
      table.columns,
      builder._state.columns ?? undefined,
      builder._state.omitColumns.length ? builder._state.omitColumns : undefined,
    )

    const mapped = rows.map(mapper) as T[]

    // Fire afterSelect hooks
    const hooks = table.hooks.afterSelect

    if (hooks) {
      let result = mapped

      for (const hook of hooks) {
        const hookResult = hook(result as never)

        if (hookResult)
          result = hookResult as T[]
      }

      return result
    }

    return mapped
  }

  async executeOne<T>(builder: { _state: { op: string, table: string, columns: string[] | null, omitColumns: string[] }, toSQL: () => { sql: string, params: unknown[] } }, table: AnyTableDef): Promise<T | null> {
    const rows = await this.execute<T>(builder, table)

    return rows[0] ?? null
  }

  async executeMutate<T>(builder: { _state: { returning: string[] | null }, toSQL: () => { sql: string, params: unknown[] } }, table: AnyTableDef): Promise<T[]> {
    const { sql: sqlStr, params } = builder.toSQL()
    const rows = await this.query(sqlStr, params)

    if (builder._state.returning != null) {
      const mapper = getOrCompileMapper(
        table.name,
        table.columns,
        builder._state.returning.length ? builder._state.returning : undefined,
      )

      return rows.map(mapper) as T[]
    }

    return rows as T[]
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

      const tx = new TransactionClient(sqlTx as InstanceType<typeof SQL>)

      return await fn(tx)
    })
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

  constructor(sqlTx: InstanceType<typeof SQL>) {
    super()
    this.sql = sqlTx
  }

  async savepoint<T>(fn: (sp: SavepointClient) => Promise<T>): Promise<T> {
    const name = `sp_${++this._savepointCounter}`

    return await (this.sql as unknown as {
      savepoint: (fn: (sp: unknown) => Promise<T>) => Promise<T>
    }).savepoint(async (sqlSp) => {
      const sp = new SavepointClient(sqlSp as InstanceType<typeof SQL>, name)

      return await fn(sp)
    })
  }
}

export class SavepointClient extends BaseExecutor {
  readonly sql: InstanceType<typeof SQL>
  readonly name: string

  constructor(sqlSp: InstanceType<typeof SQL>, name: string) {
    super()
    this.sql = sqlSp
    this.name = name
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
