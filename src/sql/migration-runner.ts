import type { SQL } from 'bun'
import type { Dialect } from '../dialect'
import type { MigrationOp } from '../migration/index'
import type { SyncOptions } from '../migration/sync'
import type { QueryFn } from '../migration/types'
import type { AnyTableDef } from '../types/index'
import type { SqliteDriver } from './sqlite-driver'
import { rollbackMigrations, syncSchema } from '../migration/index'
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
  ) {}

  /** Runs `fn` in one transaction; on SQLite with foreign keys off around it, checked before the commit. */
  transact<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    const body = async (sqlTx: InstanceType<typeof SQL>): Promise<T> => {
      const txDriver = asDriver(sqlTx)

      return fn(async (sqlStr, params) => txDriver.unsafe(sqlStr, params) as Promise<Record<string, unknown>[]>)
    }

    if (this.dialect === 'sqlite')
      return this.track(() => (this.sql as unknown as SqliteDriver).migrate(body))

    return this.track(() => asDriver(this.sql).begin(body))
  }

  sync(opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
    return syncSchema(
      { query: this.query, transact: fn => this.transact(fn), schema: this.schema, tables: this.tables, dialect: this.dialect },
      opts,
    )
  }

  rollback(count = 1): Promise<{ rolledBack: string[], sql: string }> {
    return rollbackMigrations({ query: this.query, transact: fn => this.transact(fn), dialect: this.dialect }, count)
  }
}
