import type { SQL } from 'bun'
import type { MigrationOp } from '../migration/index'
import type { SyncOptions } from '../migration/sync'
import type { QueryFn } from '../migration/types'
import type { AnyTableDef } from '../types/index'
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
  ) {}

  private _transact<T>(fn: (query: QueryFn) => Promise<T>): Promise<T> {
    return asDriver(this.sql).begin(async (sqlTx) => {
      const txDriver = asDriver(sqlTx)

      return fn(async (sqlStr, params) => txDriver.unsafe(sqlStr, params) as Promise<Record<string, unknown>[]>)
    })
  }

  sync(opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
    return syncSchema(
      { query: this.query, transact: fn => this._transact(fn), schema: this.schema, tables: this.tables },
      opts,
    )
  }

  rollback(count = 1): Promise<{ rolledBack: string[], sql: string }> {
    return rollbackMigrations({ query: this.query, transact: fn => this._transact(fn) }, count)
  }
}
