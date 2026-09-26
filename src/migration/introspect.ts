import type { LiveCheck, LiveEnum, LiveForeignKey, LiveIndex, LiveTable, QueryFn } from './types'
import { ARRAY_UDT_PREFIX_RE, SPACE_RE } from './regex'
import { MIGRATION_TABLE } from './types'

async function runIntrospectionQueries(executor: { query: QueryFn }, schema: string) {
  const colRows = await executor.query(`
    SELECT
      c.table_name, c.column_name, c.data_type, c.udt_name,
      c.is_nullable, c.column_default, c.is_generated, c.generation_expression,
      c.character_maximum_length, c.numeric_precision, c.numeric_scale
    FROM information_schema.columns c
    WHERE c.table_schema = $1
    ORDER BY c.table_name, c.ordinal_position
  `, [schema])

  const pkRows = await executor.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
  `, [schema])

  const uqRows = await executor.query(`
    SELECT tc.table_name, kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = $1
  `, [schema])

  const enumRows = await executor.query(`
    SELECT t.typname AS enum_name, e.enumlabel AS enum_value, e.enumsortorder
    FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = $1
    ORDER BY t.typname, e.enumsortorder
  `, [schema])

  const fkRows = await executor.query(`
    SELECT
      tc.constraint_name,
      tc.table_name,
      kcu.column_name,
      ccu.table_name AS referenced_table,
      ccu.column_name AS referenced_column,
      rc.update_rule,
      rc.delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
    JOIN information_schema.referential_constraints rc
      ON tc.constraint_name = rc.constraint_name AND tc.table_schema = rc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1
  `, [schema])

  const indexRows = await executor.query(`
    SELECT
      i.relname AS index_name,
      t.relname AS table_name,
      am.amname AS method,
      ix.indisunique AS is_unique,
      pg_get_indexdef(ix.indexrelid) AS definition,
      array_agg(a.attname ORDER BY x.ordinality) AS columns
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = i.relam
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ordinality)
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
    WHERE n.nspname = $1
      AND NOT ix.indisprimary
      AND NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conindid = ix.indexrelid AND c.contype IN ('u', 'p')
      )
    GROUP BY i.relname, t.relname, am.amname, ix.indisunique, ix.indexrelid
  `, [schema])

  const checkRows = await executor.query(`
    SELECT c.conname AS name, t.relname AS table_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'c' AND n.nspname = $1
  `, [schema])

  return { colRows, pkRows, uqRows, enumRows, fkRows, indexRows, checkRows }
}

export async function introspectLiveSchema(executor: { query: QueryFn }, schema = 'public'): Promise<{
  tables: LiveTable[]
  enums: LiveEnum[]
  foreignKeys: LiveForeignKey[]
  indexes: LiveIndex[]
  checks: LiveCheck[]
}> {
  const { colRows, pkRows, uqRows, enumRows, fkRows, indexRows, checkRows } = await runIntrospectionQueries(executor, schema)

  const pkSet = new Set(pkRows.map(r => `${r.table_name}.${r.column_name}`))
  const uqSet = new Set(uqRows.map(r => `${r.table_name}.${r.column_name}`))

  return {
    tables: buildLiveTables(colRows, pkSet, uqSet),
    enums: buildLiveEnums(enumRows),
    foreignKeys: fkRows.map(r => ({
      constraintName: r.constraint_name as string,
      tableName: r.table_name as string,
      columnName: r.column_name as string,
      referencedTable: r.referenced_table as string,
      referencedColumn: r.referenced_column as string,
      onUpdate: (r.update_rule as string).toLowerCase().replace(SPACE_RE, ' '),
      onDelete: (r.delete_rule as string).toLowerCase().replace(SPACE_RE, ' '),
    })),
    indexes: indexRows.map(r => ({
      name: r.index_name as string,
      tableName: r.table_name as string,
      columns: r.columns as string[],
      isUnique: r.is_unique as boolean,
      method: r.method as string,
      definition: r.definition as string,
    })),
    checks: checkRows.map(r => ({ name: r.name as string, tableName: r.table_name as string })),
  }
}

function buildLiveTables(colRows: Record<string, unknown>[], pkSet: Set<string>, uqSet: Set<string>): LiveTable[] {
  const tableMap = new Map<string, LiveTable>()

  for (const row of colRows) {
    const tableName = row.table_name as string

    if (tableName === MIGRATION_TABLE)
      continue

    if (!tableMap.has(tableName))
      tableMap.set(tableName, { name: tableName, columns: [] })

    tableMap.get(tableName)!.columns.push({
      name: row.column_name as string,
      dataType: resolveDataType(row),
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default as string | null,
      isPrimaryKey: pkSet.has(`${tableName}.${row.column_name}`),
      isUnique: uqSet.has(`${tableName}.${row.column_name}`),
      isGenerated: row.is_generated === 'ALWAYS',
    })
  }

  return Array.from(tableMap.values())
}

function buildLiveEnums(enumRows: Record<string, unknown>[]): LiveEnum[] {
  const enumMap = new Map<string, string[]>()

  for (const row of enumRows) {
    const name = row.enum_name as string

    if (!enumMap.has(name))
      enumMap.set(name, [])

    enumMap.get(name)!.push(row.enum_value as string)
  }

  return Array.from(enumMap.entries()).map(([name, values]) => ({ name, values }))
}

function resolveDataType(row: Record<string, unknown>): string {
  const udtName = row.udt_name as string
  const dataType = row.data_type as string
  const charLen = row.character_maximum_length as number | null
  const numPrec = row.numeric_precision as number | null
  const numScale = row.numeric_scale as number | null

  if (dataType === 'ARRAY')
    return `${udtName.replace(ARRAY_UDT_PREFIX_RE, '')}[]`

  if (dataType === 'USER-DEFINED')
    return udtName

  if (udtName === 'varchar' && charLen)
    return `varchar(${charLen})`

  if (udtName === 'numeric' && numPrec) {
    return numScale ? `numeric(${numPrec},${numScale})` : `numeric(${numPrec})`
  }

  return udtName
}
