import type { AnyColumnDef, AnyColumns } from '../types/index'

// Internal migration tracking table name
export const MIGRATION_TABLE = '_pgorm_migrations'

export interface LiveColumn {
  name: string
  dataType: string
  isNullable: boolean
  defaultValue: string | null
  isPrimaryKey: boolean
  isUnique: boolean
  isGenerated: boolean
}

export interface LiveTable {
  name: string
  columns: LiveColumn[]
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
    | 'rename_column'
    // SQLite: a change its ALTER TABLE cannot make, made by copying the table into a new one built to the definition.
    | 'rebuild_table'
  table?: string
  column?: string
  sql: string
  destructive: boolean
  description: string
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
