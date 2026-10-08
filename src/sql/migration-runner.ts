import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import type { MigrationOp } from '../migration/index'
import type { SyncOptions } from '../migration/sync'
import type { QueryFn } from '../migration/types'
import type { AnyTableDef } from '../types/index'
import type { SqliteDriver } from './sqlite-driver'
import { rollbackMigrations, syncSchema } from '../migration/index'
import { MIGRATION_LOCK_KEY } from '../migration/types'
import { validateIdentifier } from '../schema/validate'
import { asDriver } from './adapter'

/**
 * Owns `sync()` / `rollback()` for a `Database`. Pulled out so the database
 * facade isn't responsible for adapting its own query/sql/schema/tables into
 * the migration module's context shape every call.
 */
export class MigrationRunner {
  constructor(
    private readonly query: QueryFn,
    private readonly sql: InstanceType<typeof SQL>,
    private readonly schema: string,
    private readonly tables: ReadonlyMap<string, AnyTableDef>,
    private readonly track: <T>(fn: () => Promise<T>) => Promise<T>,
    private readonly dialect: Dialect = 'postgres',
  ) {
    validateIdentifier(schema, 'schema')
  }

  /** Runs `fn` in one transaction; on SQLite with foreign keys off around it, checked before the commit. */
  transact<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    const body = async (sqlTx: InstanceType<typeof SQL>): Promise<T> => {
      const txDriver = asDriver(sqlTx)

      return fn(async (sqlStr, params) => txDriver.unsafe(sqlStr, params) as Promise<Record<string, unknown>[]>)
    }

    if (this.dialect === 'sqlite')
      return this.track(() => (this.sql as unknown as SqliteDriver).migrate(body))

    // The DDL and the history table name no schema, so the transaction resolves them in the configured one; `public` stays on the path for extension types (vector, citext).
    // The pool's timeouts are for app queries: a table rewrite outlasts them, and `sync({ confirm })` holds the transaction open on its prompt.
    return this.track(() => asDriver(this.sql).begin(async (sqlTx) => {
      await asDriver(sqlTx).unsafe(`SET LOCAL search_path TO "${this.schema}", public`, [])
      await asDriver(sqlTx).unsafe('SET LOCAL statement_timeout = 0', [])
      await asDriver(sqlTx).unsafe('SET LOCAL idle_in_transaction_session_timeout = 0', [])

      return body(sqlTx)
    }))
  }

  /**
   * Runs `fn` on one reserved connection outside any transaction, in the configured schema, holding the migration lock for the whole session so no other migration plans while an index builds.
   * SQLite has no such statements and runs it as is.
   */
  outside<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    if (this.dialect === 'sqlite')
      return this.track(() => fn(this.query))

    return this.track(async () => {
      const conn = await asDriver(this.sql).reserve()
      const query: QueryFn = async (sqlStr, params) => conn.unsafe(sqlStr, params) as Promise<Record<string, unknown>[]>

      try {
        await query(`SET search_path TO "${this.schema}", public`, [])
        await query('SET statement_timeout = 0', [])
        await query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])

        try {
          return await fn(query)
        }
        finally {
          await query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        }
      }
      finally {
        // The connection goes back to the pool: its search_path and lifted timeout must not follow it there.
        try {
          await query('RESET search_path', [])
          await query('RESET statement_timeout', [])
        }
        finally {
          conn.release()
        }
      }
    })
  }

  sync(opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
    return syncSchema(
      { query: this.query, transact: fn => this.transact(fn), outside: fn => this.outside(fn), schema: this.schema, tables: this.tables, dialect: this.dialect },
      opts,
    )
  }

  rollback(count = 1): Promise<{ rolledBack: string[], sql: string }> {
    return rollbackMigrations({ query: this.query, transact: fn => this.transact(fn), dialect: this.dialect }, count)
  }
}
