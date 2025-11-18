import type { SQL } from 'bun'

// ============================================================================
// Migration Configuration
// ============================================================================

export interface MigrationConfig {
  /**
   * Enable auto-migration (schema diffing) at startup
   * If true, prompts user to apply schema changes
   * If false, schema changes are ignored
   * @default true
   */
  autoMigrate?: boolean

  /**
   * Auto-approve migrations without user interaction
   * Only works when autoMigrate is true
   * @default false
   */
  noInteraction?: boolean

  /**
   * Kill process if schema updates are detected and user declines
   * @default true
   */
  killIfUpdate?: boolean

  /**
   * Prevent auto-dropping columns (safety feature)
   * When true, column drops are detected but not auto-executed
   * @default true
   */
  safeMigrations?: boolean

  /**
   * Path to migration files directory
   * @default 'migrations'
   */
  migrationsPath?: string

  /**
   * Name of the migrations tracking table
   * @default '_migrations'
   */
  migrationsTable?: string
}

// ============================================================================
// Migration File Definition
// ============================================================================

export interface Migration {
  /**
   * Unique migration name (usually timestamp-based)
   */
  name: string

  /**
   * Apply the migration
   */
  up: (db: SQL) => Promise<void>

  /**
   * Revert the migration
   */
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
  udtName: string // Underlying PostgreSQL type (e.g., _text for TEXT[])
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

export interface DatabaseSchema {
  tables: Map<string, DatabaseTable>
  columns: Map<string, DatabaseColumn[]> // Key: tableName
  constraints: Map<string, DatabaseConstraint[]> // Key: tableName
  indexes: Map<string, DatabaseIndex[]> // Key: tableName
}

// ============================================================================
// Schema Comparison Types
// ============================================================================

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

export interface SchemaChange {
  type: SchemaChangeType
  tableName: string
  sql: string
  description: string
  /**
   * Set to true for dangerous operations (DROP TABLE, DROP COLUMN)
   */
  destructive?: boolean
  /**
   * Additional metadata for the change
   */
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

// ============================================================================
// Migration Runner Types
// ============================================================================

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

// ============================================================================
// Field Type Mapping
// ============================================================================

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
