import type { SQL } from 'bun'
import type { MigrationOp } from '../migration/index'
import type { SyncOptions } from '../migration/sync'
import type { AnyTableDef } from '../types/index'
import { rollbackMigrations, syncSchema } from '../migration/index'

/**
 * Owns `sync()` / `rollback()` for a `Database`. Pulled out so the database
 * facade isn't responsible for adapting its own query/sql/schema/tables into
 * the migration module's context shape every call.
 */
export class MigrationRunner {
  constructor(
    private readonly query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>,
    private readonly sql: InstanceType<typeof SQL>,
    private readonly schema: string,
    private readonly tables: ReadonlyMap<string, AnyTableDef>,
  ) {}

  sync(opts?: SyncOptions): Promise<{ sql: string, ops: MigrationOp[] }> {
    return syncSchema(
      { query: this.query, sql: this.sql, schema: this.schema, tables: this.tables },
      opts,
    )
  }

  rollback(count = 1): Promise<{ rolledBack: string[], sql: string }> {
    return rollbackMigrations({ query: this.query, sql: this.sql }, count)
  }
}
