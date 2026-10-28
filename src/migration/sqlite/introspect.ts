import type { QueryFn } from '../types'
import { MIGRATION_TABLE } from '../types'

export interface SqliteLiveTable {
  name: string
  /** The `CREATE TABLE` SQLite keeps, as written and then edited by each `ALTER TABLE`. */
  sql: string
  /** A generated column's `hidden` is 2 (virtual) or 3 (stored) in `pragma_table_xinfo`. */
  columns: { name: string, type: string, generated?: boolean }[]
}

interface SqliteLiveIndex {
  name: string
  table: string
  sql: string
}

export interface SqliteLiveSchema {
  tables: SqliteLiveTable[]
  indexes: SqliteLiveIndex[]
}

// SQLite keeps each table's and index's DDL in `sqlite_schema`, which the diff compares against the definition's. An index with no SQL backs a UNIQUE or a PRIMARY KEY and goes with its table.
export async function introspectSqliteSchema(executor: { query: QueryFn }): Promise<SqliteLiveSchema> {
  const rows = await executor.query(`
    SELECT "type", "name", "tbl_name", "sql" FROM sqlite_schema
    WHERE "type" IN ('table', 'index') AND "sql" IS NOT NULL AND "name" NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND "tbl_name" <> $1
    ORDER BY "name"
  `, [MIGRATION_TABLE])
  const columnRows = await executor.query(`
    SELECT s."name" AS "table", c."name" AS "column", c."type", c."hidden" IN (2, 3) AS "generated"
    FROM sqlite_schema s, pragma_table_xinfo(s."name") c
    WHERE s."type" = 'table' AND s."name" NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND s."name" <> $1
    ORDER BY s."name", c."cid"
  `, [MIGRATION_TABLE])
  const columns = new Map<string, SqliteLiveTable['columns']>()

  for (const row of columnRows) {
    const list = columns.get(row.table as string) ?? []

    list.push({ name: row.column as string, type: row.type as string, generated: Boolean(row.generated) })
    columns.set(row.table as string, list)
  }

  return {
    tables: rows.filter(r => r.type === 'table').map(r => ({ name: r.name as string, sql: r.sql as string, columns: columns.get(r.name as string) ?? [] })),
    indexes: rows.filter(r => r.type === 'index').map(r => ({ name: r.name as string, table: r.tbl_name as string, sql: r.sql as string })),
  }
}
