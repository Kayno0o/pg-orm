import type { Dialect } from '../dialect'
import type { AnyTableDef } from '../types/index'
import type { MigrationOp, QueryFn } from './types'
import { diffSchema } from './diff'
import { collectEnumRequirements, diffEnums } from './diff/enums'
import { introspectEnums, introspectLiveSchema } from './introspect'
import { diffSqliteSchema } from './sqlite/diff'
import { introspectSqliteSchema } from './sqlite/introspect'

/** Tables a migration leaves alone, created, changed and dropped by other means: a name, or a pattern names are tested against. */
export type IgnoreTables = readonly (string | RegExp)[]

/** The values the desired enums add to live ones, Postgres only: read from the enum types alone, so a sync adding none introspects the schema once. */
export async function planEnumAdditions(
  executor: { query: QueryFn },
  tables: ReadonlyMap<string, AnyTableDef>,
  schema?: string,
  ignoreTables: IgnoreTables = [],
): Promise<MigrationOp[]> {
  const kept = (name: string) => !ignoreTables.some(p => typeof p === 'string' ? p === name : p.test(name))
  const desired = ignoreTables.length === 0 ? tables : new Map([...tables].filter(([name]) => kept(name)))

  return diffEnums(collectEnumRequirements(desired), await introspectEnums(executor, schema)).filter(op => op.type === 'alter_enum_add')
}

/** The ops bringing the live database to the table definitions, the ignored tables left out on both sides. */
export async function planMigration(
  executor: { query: QueryFn },
  tables: ReadonlyMap<string, AnyTableDef>,
  dialect: Dialect = 'postgres',
  schema?: string,
  ignoreTables: IgnoreTables = [],
): Promise<MigrationOp[]> {
  const kept = (name: string) => !ignoreTables.some(p => typeof p === 'string' ? p === name : p.test(name))
  const desired = ignoreTables.length === 0 ? tables : new Map([...tables].filter(([name]) => kept(name)))

  if (dialect === 'sqlite') {
    const live = await introspectSqliteSchema(executor)

    return diffSqliteSchema({ tables: live.tables.filter(t => kept(t.name)), indexes: live.indexes.filter(i => kept(i.table)) }, desired)
  }

  const live = await introspectLiveSchema(executor, schema)

  return diffSchema({
    tables: live.tables.filter(t => kept(t.name)),
    enums: live.enums,
    foreignKeys: live.foreignKeys.filter(fk => kept(fk.tableName)),
    indexes: live.indexes.filter(i => kept(i.tableName)),
    checks: live.checks.filter(c => kept(c.tableName)),
    extensions: live.extensions,
  }, desired)
}
