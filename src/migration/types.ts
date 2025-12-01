import type { SQL } from 'bun'

export interface MigrationConfig {
  autoMigrate?: boolean
  noInteraction?: boolean
  killIfUpdate?: boolean
  safeMigrations?: boolean
  migrationsPath?: string
  migrationsTable?: string
}

export interface Migration {
  name: string
  up: (db: SQL) => Promise<void>
  down: (db: SQL) => Promise<void>
}

export interface MigrationRecord {
  id: number
  name: string
  executed_at: Date
  batch: number
}

// ============================================================================
// Schema Inspection Types
// ============================================================================

export interface DatabaseTable {
  tableName: string
  schemaName: string
}

export interface DatabaseColumn {
  tableName: string
  columnName: string
  dataType: string
  isNullable: boolean
  columnDefault: string | null
  characterMaximumLength: number | null
  numericPrecision: number | null
  numericScale: number | null
  datetimePrecision: number | null
  udtName: string
}

export interface DatabaseConstraint {
  constraintName: string
  tableName: string
  constraintType: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK'
  columnNames: string[]
  definition?: string
}

export interface DatabaseIndex {
  indexName: string
  tableName: string
  columnNames: string[]
  isUnique: boolean
  isPrimary: boolean
}

export interface ForeignKeyInfo {
  constraintName: string
  tableName: string
  columnName: string
  foreignTableName: string
  foreignColumnName: string
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'SET DEFAULT'
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' | 'SET DEFAULT'
}

export interface DatabaseSchema {
  tables: Map<string, DatabaseTable>
  columns: Map<string, DatabaseColumn[]>
  constraints: Map<string, DatabaseConstraint[]>
  indexes: Map<string, DatabaseIndex[]>
  foreignKeys: Map<string, ForeignKeyInfo[]>
}

export type SchemaChangeType
  = | 'CREATE_TABLE'
    | 'DROP_TABLE'
    | 'ADD_COLUMN'
    | 'DROP_COLUMN'
    | 'MODIFY_COLUMN'
    | 'RENAME_COLUMN'
    | 'ADD_CONSTRAINT'
    | 'DROP_CONSTRAINT'
    | 'ADD_INDEX'
    | 'DROP_INDEX'
    | 'ADD_FOREIGN_KEY'
    | 'DROP_FOREIGN_KEY'
    | 'MODIFY_FOREIGN_KEY'

export interface SchemaChange {
  type: SchemaChangeType
  tableName: string
  sql: string
  description: string
  destructive?: boolean
  metadata?: {
    columnName?: string
    oldValue?: any
    newValue?: any
    constraintName?: string
    indexName?: string
  }
}

export interface SchemaDiff {
  changes: SchemaChange[]
  hasChanges: boolean
  hasDestructiveChanges: boolean
}

export interface MigrationRunResult {
  executed: string[]
  failed: string[]
  skipped: string[]
}

export interface MigrationStatus {
  pending: string[]
  executed: MigrationRecord[]
  total: number
  pendingCount: number
  executedCount: number
}

export interface PostgresTypeMapping {
  type: string
  nullable: boolean
  default?: string
  length?: number
  precision?: number
  scale?: number
  unique?: boolean
  check?: string
}

export type PostgresType
  = | 'TEXT'
    | 'VARCHAR'
    | `VARCHAR(${string})`
    | 'INTEGER'
    | 'BIGINT'
    | 'DOUBLE PRECISION'
    | 'BOOLEAN'
    | 'JSON'
    | 'JSONB'
    | 'UUID'
    | 'TIMESTAMP WITH TIME ZONE'
    | 'DATE'
    | 'BYTEA'
    | 'TEXT[]'
    | 'INTEGER[]'
    | 'BOOLEAN[]'

export interface TableDependency {
  tableName: string
  dependsOn: Set<string>
  selfReferencing: boolean
}

export interface DependencyGraph {
  nodes: Map<string, TableDependency>
  sorted: string[] | null
  cycles: string[][] | null
}

export interface ValidationError {
  error: string
  fix?: string
  tableName?: string
  columnName?: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
  warnings: string[]
}

export interface SortedChangeGroups {
  createTables: SchemaChange[]
  addColumns: SchemaChange[]
  modifyColumns: SchemaChange[]
  addForeignKeys: SchemaChange[]
  dropForeignKeys: SchemaChange[]
  dropColumns: SchemaChange[]
  dropTables: SchemaChange[]
  other: SchemaChange[]
}
