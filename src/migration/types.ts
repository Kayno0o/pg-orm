import type { AnyColumnDef, AnyColumns } from '../types/index'

// Internal migration tracking table name
export const MIGRATION_TABLE = '_pgorm_migrations'

// The `pg_advisory_xact_lock` key every migration transaction takes, so two never interleave: derived once from "pg-orm-sync".
export const MIGRATION_LOCK_KEY = 741953258

export interface LiveColumn {
  name: string
  dataType: string
  isNullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isUnique: boolean
  isGenerated: boolean
  /** A generated column's expression as Postgres prints it back. */
  generationExpression?: string | null
  /** The name of the single-column UNIQUE constraint making the column unique, which a rename leaves under the old column's name. */
  uniqueConstraint?: string
  /** How an identity column is generated, null for any other. */
  identity?: 'always' | 'by default' | null
  comment?: string | null
}

export interface LiveTable {
  name: string
  columns: LiveColumn[]
  /** The name of the table's PRIMARY KEY constraint, when it has one. */
  primaryKeyConstraint?: string
  comment?: string | null
  /** Its UNIQUE constraints over several columns. */
  uniques?: { name: string, columns: string[] }[]
}

export interface LiveEnum {
  name: string
  values: string[]
}

export interface LiveForeignKey {
  constraintName: string
  tableName: string
  columnName: string
  referencedTable: string
  referencedColumn: string
  onUpdate: string
  onDelete: string
  deferrable?: 'immediate' | 'deferred'
}

export interface LiveCheck {
  name: string
  tableName: string
}

export interface LiveIndex {
  name: string
  tableName: string
  columns: string[]
  isUnique: boolean
  method: string
  definition: string
}

export interface MigrationOp {
  type: 'create_table' | 'drop_table' | 'add_column' | 'drop_column' | 'alter_column'
    | 'create_enum' | 'alter_enum_add' | 'alter_enum_remove' | 'add_constraint' | 'drop_constraint'
    | 'add_fk' | 'drop_fk'
    | 'create_index' | 'drop_index'
    | 'rename_column' | 'rename_table' | 'rename_index' | 'comment'
    // SQLite: a change its ALTER TABLE cannot make, made by copying the table into a new one built to the definition.
    | 'rebuild_table'
  table?: string
  column?: string
  sql: string
  destructive: boolean
  description: string
  /** The statement undoing this one, when the op itself knows it (a comment's previous text, a table's previous name). */
  down?: string
}

export interface MigrationFile {
  name: string
  up: string
  down: string
}

/** Minimal query interface shared across migration internals. */
export type QueryFn = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>

// Typed Object.entries for column maps — shared helper.
export function columnEntries(columns: AnyColumns): [string, AnyColumnDef][] {
  return Object.entries(columns)
}
