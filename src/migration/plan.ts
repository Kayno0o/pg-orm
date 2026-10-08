import type { Dialect } from '../dialect'
import type { AnyTableDef } from '../types/index'
import type { MigrationOp, QueryFn } from './types'
import { diffSchema } from './diff'
import { introspectLiveSchema } from './introspect'
import { diffSqliteSchema } from './sqlite/diff'
import { introspectSqliteSchema } from './sqlite/introspect'

/** The ops bringing the live database to the table definitions. */
export async function planMigration(
  executor: { query: QueryFn },
  tables: ReadonlyMap<string, AnyTableDef>,
  dialect: Dialect = 'postgres',
  schema?: string,
): Promise<MigrationOp[]> {
  if (dialect === 'sqlite')
    return diffSqliteSchema(await introspectSqliteSchema(executor), tables)

  return diffSchema(await introspectLiveSchema(executor, schema), tables)
}
