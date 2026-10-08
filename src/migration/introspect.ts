import type { LiveCheck, LiveEnum, LiveForeignKey, LiveIndex, LiveTable, QueryFn } from './types'
import { SPACE_RE } from './regex'
import { MIGRATION_TABLE } from './types'

async function runIntrospectionQueries(executor: { query: QueryFn }, schema: string) {
  const colRows = await executor.query(`
    SELECT
      c.table_name, c.column_name, c.data_type, c.udt_name,
      c.is_nullable, c.column_default, c.is_generated, c.generation_expression,
      format_type(a.atttypid, a.atttypmod) AS formatted_type
    FROM information_schema.columns c
    JOIN pg_namespace n ON n.nspname = c.table_schema
    JOIN pg_class t ON t.relname = c.table_name AND t.relnamespace = n.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = c.column_name
    WHERE c.table_schema = $1 AND t.relkind IN ('r', 'p')
    ORDER BY c.table_name, c.ordinal_position
  `, [schema])

  // Read off pg_constraint by table oid: information_schema joins on constraint names, which repeat across schemas.
  const pkRows = await executor.query(`
    SELECT t.relname AS table_name, a.attname AS column_name, c.conname AS constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
    WHERE c.contype = 'p' AND n.nspname = $1
  `, [schema])

  // Only a single-column UNIQUE makes its column unique: a composite one constrains the pair, not each column.
  const uqRows = await executor.query(`
    SELECT t.relname AS table_name, a.attname AS column_name, c.conname AS constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'u' AND n.nspname = $1 AND cardinality(c.conkey) = 1
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
  const pkNames = new Map(pkRows.map(r => [r.table_name as string, r.constraint_name as string]))
  const uqNames = new Map(uqRows.map(r => [`${r.table_name}.${r.column_name}`, r.constraint_name as string]))

  return {
    tables: buildLiveTables(colRows, pkSet, uqNames, pkNames),
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

function buildLiveTables(colRows: Record<string, unknown>[], pkSet: Set<string>, uqNames: Map<string, string>, pkNames: Map<string, string>): LiveTable[] {
  const tableMap = new Map<string, LiveTable>()

  for (const row of colRows) {
    const tableName = row.table_name as string

    if (tableName === MIGRATION_TABLE)
      continue

    if (!tableMap.has(tableName))
      tableMap.set(tableName, { name: tableName, columns: [], primaryKeyConstraint: pkNames.get(tableName) })

    tableMap.get(tableName)!.columns.push({
      name: row.column_name as string,
      // format_type() spells the type with its modifier (`vector(3)`, `character(5)`), which information_schema leaves out for some types.
      dataType: row.formatted_type as string,
      isNullable: row.is_nullable === 'YES',
      defaultValue: row.column_default as string | null,
      isPrimaryKey: pkSet.has(`${tableName}.${row.column_name}`),
      isUnique: uqNames.has(`${tableName}.${row.column_name}`),
      isGenerated: row.is_generated === 'ALWAYS',
      generationExpression: row.generation_expression as string | null,
      uniqueConstraint: uqNames.get(`${tableName}.${row.column_name}`),
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
