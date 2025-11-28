import type { SQL } from 'bun'
import type {
  DatabaseColumn,
  DatabaseConstraint,
  DatabaseIndex,
  DatabaseSchema,
  DatabaseTable,
  ForeignKeyInfo,
} from './types'

// Schema Inspector - Query PostgreSQL Metadata

export class SchemaInspector {
  constructor(private db: SQL) {}

  /** Get complete database schema (tables, columns, constraints, indexes, foreign keys) */
  async getSchema(): Promise<DatabaseSchema> {
    const [tables, columns, constraints, indexes, foreignKeys] = await Promise.all([
      this.getTables(),
      this.getColumns(),
      this.getConstraints(),
      this.getIndexes(),
      this.getForeignKeys(),
    ])

    return {
      tables: new Map(tables.map(t => [t.tableName, t])),
      columns: this.groupByTable(columns),
      constraints: this.groupByTable(constraints),
      indexes: this.groupByTable(indexes),
      foreignKeys: this.groupByTable(foreignKeys),
    }
  }

  /** Get all user-defined tables (excluding system tables) */
  async getTables(): Promise<DatabaseTable[]> {
    const results = await this.db`
      SELECT
        table_name as "tableName",
        table_schema as "schemaName"
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name != '_migrations'
      ORDER BY table_name
    `

    return results.map((row: any) => ({
      tableName: row.tableName,
      schemaName: row.schemaName,
    }))
  }

  /** Get all columns for all tables */
  async getColumns(): Promise<DatabaseColumn[]> {
    const results = await this.db`
      SELECT
        table_name as "tableName",
        column_name as "columnName",
        data_type as "dataType",
        is_nullable as "isNullable",
        column_default as "columnDefault",
        character_maximum_length as "characterMaximumLength",
        numeric_precision as "numericPrecision",
        numeric_scale as "numericScale",
        datetime_precision as "datetimePrecision",
        udt_name as "udtName"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name != '_migrations'
      ORDER BY table_name, ordinal_position
    `

    return results.map((row: any) => ({
      tableName: row.tableName,
      columnName: row.columnName,
      dataType: row.dataType,
      isNullable: row.isNullable === 'YES',
      columnDefault: row.columnDefault,
      characterMaximumLength: row.characterMaximumLength,
      numericPrecision: row.numericPrecision,
      numericScale: row.numericScale,
      datetimePrecision: row.datetimePrecision,
      udtName: row.udtName,
    }))
  }

  /** Get all constraints (PRIMARY KEY, UNIQUE, FOREIGN KEY, CHECK) */
  async getConstraints(): Promise<DatabaseConstraint[]> {
    const results = await this.db`
      SELECT
        tc.constraint_name as "constraintName",
        tc.table_name as "tableName",
        tc.constraint_type as "constraintType",
        array_agg(kcu.column_name ORDER BY kcu.ordinal_position) as "columnNames",
        pg_get_constraintdef(pgc.oid) as "definition"
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
        AND tc.table_name = kcu.table_name
      LEFT JOIN pg_catalog.pg_constraint pgc
        ON pgc.conname = tc.constraint_name
      WHERE tc.table_schema = 'public'
        AND tc.table_name != '_migrations'
      GROUP BY
        tc.constraint_name,
        tc.table_name,
        tc.constraint_type,
        pgc.oid
      ORDER BY tc.table_name, tc.constraint_type
    `

    return results.map((row: any) => ({
      constraintName: row.constraintName,
      tableName: row.tableName,
      constraintType: row.constraintType,
      columnNames: row.columnNames || [],
      definition: row.definition,
    }))
  }

  /** Get all indexes */
  async getIndexes(): Promise<DatabaseIndex[]> {
    const results = await this.db`
      SELECT
        i.relname as "indexName",
        t.relname as "tableName",
        array_agg(a.attname ORDER BY a.attnum) as "columnNames",
        ix.indisunique as "isUnique",
        ix.indisprimary as "isPrimary"
      FROM pg_class i
      JOIN pg_index ix ON i.oid = ix.indexrelid
      JOIN pg_class t ON ix.indrelid = t.oid
      JOIN pg_namespace n ON t.relnamespace = n.oid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE n.nspname = 'public'
        AND t.relkind = 'r'
        AND t.relname != '_migrations'
        AND i.relname NOT LIKE 'pg_%'
      GROUP BY
        i.relname,
        t.relname,
        ix.indisunique,
        ix.indisprimary
      ORDER BY t.relname, i.relname
    `

    return results.map((row: any) => ({
      indexName: row.indexName,
      tableName: row.tableName,
      columnNames: row.columnNames || [],
      isUnique: row.isUnique,
      isPrimary: row.isPrimary,
    }))
  }

  /** Get all foreign keys */
  async getForeignKeys(): Promise<ForeignKeyInfo[]> {
    const results = await this.db`
      SELECT
        tc.constraint_name as "constraintName",
        tc.table_name as "tableName",
        kcu.column_name as "columnName",
        ccu.table_name AS "foreignTableName",
        ccu.column_name AS "foreignColumnName",
        rc.delete_rule as "deleteRule",
        rc.update_rule as "updateRule"
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints AS rc
        ON tc.constraint_name = rc.constraint_name
        AND tc.table_schema = rc.constraint_schema
      WHERE tc.table_schema = 'public'
        AND tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name != '_migrations'
      ORDER BY tc.table_name, tc.constraint_name
    `

    return results.map((row: any) => ({
      constraintName: row.constraintName,
      tableName: row.tableName,
      columnName: row.columnName,
      foreignTableName: row.foreignTableName,
      foreignColumnName: row.foreignColumnName,
      onDelete: this.normalizeReferentialAction(row.deleteRule),
      onUpdate: this.normalizeReferentialAction(row.updateRule),
    }))
  }

  /** Check if a table exists */
  async tableExists(tableName: string): Promise<boolean> {
    const [result] = await this.db`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ${tableName}
      ) as exists
    `

    return result.exists
  }

  /** Check if a column exists in a table */
  async columnExists(tableName: string, columnName: string): Promise<boolean> {
    const [result] = await this.db`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = ${tableName}
          AND column_name = ${columnName}
      ) as exists
    `

    return result.exists
  }

  /** Get PostgreSQL version */
  async getVersion(): Promise<string> {
    const [result] = await this.db`SELECT version() as version`

    return result.version
  }

  // ========================================================================
  // Internal Helpers
  // ========================================================================

  private groupByTable<T extends { tableName: string }>(items: T[]): Map<string, T[]> {
    const grouped = new Map<string, T[]>()

    for (const item of items) {
      const existing = grouped.get(item.tableName) || []

      existing.push(item)
      grouped.set(item.tableName, existing)
    }

    return grouped
  }

  /** Normalize PostgreSQL referential action names to our standard format */
  private normalizeReferentialAction(
    action: string,
  ): 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'SET DEFAULT' {
    switch (action.toUpperCase()) {
    case 'CASCADE':
      return 'CASCADE'
    case 'SET NULL':
      return 'SET NULL'
    case 'RESTRICT':
      return 'RESTRICT'
    case 'NO ACTION':
      return 'NO ACTION'
    case 'SET DEFAULT':
      return 'SET DEFAULT'
    default:
      return 'NO ACTION'
    }
  }
}
