import type { EntityDefinition, EntitySchema, FieldConfig } from '../types'
import type {
  DatabaseColumn,
  DatabaseSchema,
  MigrationConfig,
  PostgresType,
  PostgresTypeMapping,
  SchemaChange,
  SchemaDiff,
} from './types'
import { toSnake } from '@kaynooo/utils'

// ============================================================================
// Schema Differ - Compare Entity Definitions with Database Schema
// ============================================================================

export class SchemaDiffer {
  constructor(
    private entities: Map<string, EntityDefinition<any>>,
    private config: Required<MigrationConfig>,
  ) {}

  /**
   * Compare entity definitions with current database schema
   */
  async diff(dbSchema: DatabaseSchema): Promise<SchemaDiff> {
    const changes: SchemaChange[] = []

    // Check for new tables and modified tables
    for (const [tableName, entityDef] of this.entities.entries()) {
      const tableExists = dbSchema.tables.has(tableName)

      if (!tableExists) {
        // New table - generate CREATE TABLE statement
        changes.push(this.generateCreateTable(entityDef))
      }
      else {
        // Existing table - check for column changes
        const columnChanges = this.compareColumns(
          tableName,
          entityDef.schema,
          dbSchema.columns.get(tableName) || [],
        )

        changes.push(...columnChanges)
      }
    }

    // Check for dropped tables (tables in DB but not in entities)
    if (!this.config.safeMigrations) {
      for (const [tableName] of dbSchema.tables) {
        if (!this.entities.has(tableName)) {
          changes.push({
            type: 'DROP_TABLE',
            tableName,
            sql: `DROP TABLE ${tableName}`,
            description: `Drop table ${tableName}`,
            destructive: true,
          })
        }
      }
    }

    const hasDestructiveChanges = changes.some(c => c.destructive)

    return {
      changes,
      hasChanges: changes.length > 0,
      hasDestructiveChanges,
    }
  }

  // ========================================================================
  // Table Operations
  // ========================================================================

  private generateCreateTable(entityDef: EntityDefinition<any>): SchemaChange {
    const { tableName, schema } = entityDef
    const columnDefs: string[] = []

    // Add id column (auto-generated primary key)
    columnDefs.push('id SERIAL PRIMARY KEY')

    // Add entity fields
    for (const [fieldName, fieldConfig] of Object.entries(schema)) {
      const columnDef = this.fieldToColumnDefinition(fieldName, fieldConfig as FieldConfig)

      columnDefs.push(columnDef)
    }

    // Add unique constraints
    if (entityDef.unique && entityDef.unique.length > 0) {
      for (const uniqueColumns of entityDef.unique) {
        const columns = uniqueColumns.map(col => this.getColumnName(String(col))).join(', ')

        columnDefs.push(`UNIQUE (${columns})`)
      }
    }

    const sql = `CREATE TABLE ${tableName} (\n  ${columnDefs.join(',\n  ')}\n)`

    return {
      type: 'CREATE_TABLE',
      tableName,
      sql,
      description: `Create table ${tableName}`,
    }
  }

  // ========================================================================
  // Column Operations
  // ========================================================================

  private compareColumns(
    tableName: string,
    entitySchema: EntitySchema,
    dbColumns: DatabaseColumn[],
  ): SchemaChange[] {
    const changes: SchemaChange[] = []
    const dbColumnMap = new Map(dbColumns.map(col => [col.columnName, col]))

    // Check for new columns and modified columns
    for (const [fieldName, fieldConfig] of Object.entries(entitySchema)) {
      const columnName = this.getColumnName(fieldName)
      const dbColumn = dbColumnMap.get(columnName)

      if (!dbColumn) {
        // New column
        changes.push(this.generateAddColumn(tableName, fieldName, fieldConfig))
      }
      else {
        // Check if column definition changed
        const columnChanges = this.compareColumnDefinition(
          tableName,
          fieldName,
          fieldConfig,
          dbColumn,
        )

        changes.push(...columnChanges)
      }
    }

    // Check for dropped columns
    if (!this.config.safeMigrations) {
      const entityColumnNames = new Set(
        Object.keys(entitySchema).map(field => this.getColumnName(field)),
      )

      for (const dbColumn of dbColumns) {
        // Skip id column
        if (dbColumn.columnName === 'id')
          continue

        if (!entityColumnNames.has(dbColumn.columnName)) {
          changes.push({
            type: 'DROP_COLUMN',
            tableName,
            sql: `ALTER TABLE ${tableName} DROP COLUMN ${dbColumn.columnName}`,
            description: `Drop column ${tableName}.${dbColumn.columnName}`,
            destructive: true,
            metadata: { columnName: dbColumn.columnName },
          })
        }
      }
    }

    return changes
  }

  private generateAddColumn(
    tableName: string,
    fieldName: string,
    fieldConfig: FieldConfig,
  ): SchemaChange {
    const columnDef = this.fieldToColumnDefinition(fieldName, fieldConfig)
    const columnName = this.getColumnName(fieldName)

    return {
      type: 'ADD_COLUMN',
      tableName,
      sql: `ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`,
      description: `Add column ${tableName}.${columnName}`,
      metadata: { columnName },
    }
  }

  private compareColumnDefinition(
    tableName: string,
    fieldName: string,
    fieldConfig: FieldConfig,
    dbColumn: DatabaseColumn,
  ): SchemaChange[] {
    const changes: SchemaChange[] = []
    const columnName = this.getColumnName(fieldName)
    const expectedType = this.fieldToPostgresType(fieldConfig, columnName)

    // Compare data type
    const actualType = this.normalizePostgresType(dbColumn)

    if (expectedType.type !== actualType) {
      changes.push({
        type: 'MODIFY_COLUMN',
        tableName,
        sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${expectedType.type}`,
        description: `Change ${tableName}.${columnName} type from ${actualType} to ${expectedType.type}`,
        metadata: {
          columnName,
          oldValue: actualType,
          newValue: expectedType.type,
        },
      })
    }

    // Compare nullable
    if (expectedType.nullable !== dbColumn.isNullable) {
      const nullConstraint = expectedType.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'

      changes.push({
        type: 'MODIFY_COLUMN',
        tableName,
        sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} ${nullConstraint}`,
        description: `Change ${tableName}.${columnName} nullable from ${dbColumn.isNullable} to ${expectedType.nullable}`,
        metadata: {
          columnName,
          oldValue: dbColumn.isNullable,
          newValue: expectedType.nullable,
        },
      })
    }

    // Compare default value
    const expectedDefault = expectedType.default // Already formatted by fieldToPostgresType
    const actualDefault = this.normalizeDefault(dbColumn.columnDefault)

    if (expectedDefault !== actualDefault) {
      if (expectedDefault) {
        changes.push({
          type: 'MODIFY_COLUMN',
          tableName,
          sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${expectedDefault}`,
          description: `Set default value for ${tableName}.${columnName}`,
          metadata: {
            columnName,
            oldValue: actualDefault,
            newValue: expectedDefault,
          },
        })
      }
      else if (actualDefault) {
        changes.push({
          type: 'MODIFY_COLUMN',
          tableName,
          sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP DEFAULT`,
          description: `Drop default value for ${tableName}.${columnName}`,
          metadata: {
            columnName,
            oldValue: actualDefault,
            newValue: null,
          },
        })
      }
    }

    // TODO: Compare unique constraints (requires more complex logic with indexes)

    return changes
  }

  // ========================================================================
  // Field to PostgreSQL Mapping
  // ========================================================================

  private fieldToColumnDefinition(fieldName: string, fieldConfig: FieldConfig): string {
    const columnName = this.getColumnName(fieldName)
    const pgType = this.fieldToPostgresType(fieldConfig, columnName)

    let definition = `${columnName} ${pgType.type}`

    // Add NOT NULL constraint
    if (!pgType.nullable) {
      definition += ' NOT NULL'
    }

    // Add DEFAULT value
    if (pgType.default) {
      definition += ` DEFAULT ${pgType.default}`
    }

    // Add UNIQUE constraint (inline)
    if (fieldConfig.unique) {
      definition += ' UNIQUE'
    }

    // Add CHECK constraint for enums
    if (fieldConfig.type === 'enum' && pgType.check) {
      definition += ` CHECK (${pgType.check})`
    }

    return definition
  }

  private fieldToPostgresType(fieldConfig: FieldConfig, columnName?: string): PostgresTypeMapping {
    const baseMapping: PostgresTypeMapping = {
      type: 'TEXT',
      nullable: fieldConfig.nullable,
    }

    switch (fieldConfig.type) {
    case 'string':
      if (fieldConfig.maxLength) {
        baseMapping.type = `VARCHAR(${fieldConfig.maxLength})`
      }
      else {
        baseMapping.type = 'TEXT'
      }

      break

    case 'number':
      if (fieldConfig.integer) {
        baseMapping.type = 'INTEGER'
      }
      else {
        baseMapping.type = 'DOUBLE PRECISION'
      }

      break

    case 'boolean':
      baseMapping.type = 'BOOLEAN'

      break

    case 'json':
      baseMapping.type = 'JSON'

      break

    case 'jsonb':
      baseMapping.type = 'JSONB'

      break

    case 'uuid':
      baseMapping.type = 'UUID'

      break

    case 'timestamp':
      baseMapping.type = 'TIMESTAMP WITH TIME ZONE'

      if (fieldConfig.autoUpdate) {
        // Note: Auto-update is handled at application level, not database level
      }

      break

    case 'date':
      baseMapping.type = 'DATE'

      break

    case 'array':
      switch (fieldConfig.arrayType) {
      case 'string':
        baseMapping.type = 'TEXT[]'

        break
      case 'number':
        baseMapping.type = 'INTEGER[]'

        break
      case 'boolean':
        baseMapping.type = 'BOOLEAN[]'

        break
      }

      break

    case 'enum': {
      baseMapping.type = 'TEXT'
      // Add CHECK constraint for enum values
      const values = fieldConfig.values.map((v: string) => `'${v}'`).join(', ')

      if (columnName) {
        baseMapping.check = `${columnName} IN (${values})`
      }

      break
    }

    case 'blob':
      baseMapping.type = 'BYTEA'

      break
    }

    // Add default value
    if (fieldConfig.default !== undefined) {
      baseMapping.default = this.formatDefaultValue(fieldConfig.default, fieldConfig)
    }

    return baseMapping
  }

  private normalizePostgresType(dbColumn: DatabaseColumn): PostgresType {
    // Handle array types
    if (dbColumn.udtName.startsWith('_')) {
      switch (dbColumn.udtName) {
      case '_text':
        return 'TEXT[]'
      case '_int4':
      case '_int8':
        return 'INTEGER[]'
      case '_bool':
        return 'BOOLEAN[]'
      }
    }

    // Handle standard types
    switch (dbColumn.dataType.toUpperCase()) {
    case 'CHARACTER VARYING':
      // Preserve length for VARCHAR columns
      if (dbColumn.characterMaximumLength) {
        return `VARCHAR(${dbColumn.characterMaximumLength})` as PostgresType
      }

      return 'VARCHAR'
    case 'TEXT':
      return 'TEXT'
    case 'INTEGER':
    case 'BIGINT':
      return 'INTEGER'
    case 'DOUBLE PRECISION':
    case 'REAL':
      return 'DOUBLE PRECISION'
    case 'BOOLEAN':
      return 'BOOLEAN'
    case 'JSON':
      return 'JSON'
    case 'JSONB':
      return 'JSONB'
    case 'UUID':
      return 'UUID'
    case 'TIMESTAMP WITH TIME ZONE':
    case 'TIMESTAMP WITHOUT TIME ZONE':
      return 'TIMESTAMP WITH TIME ZONE'
    case 'DATE':
      return 'DATE'
    case 'BYTEA':
      return 'BYTEA'
    default:
      return dbColumn.dataType.toUpperCase() as PostgresType
    }
  }

  private formatDefaultValue(value: any, fieldConfig: FieldConfig): string | undefined {
    if (value === undefined)
      return undefined

    if (typeof value === 'string') {
      // Check for SQL functions
      if (value.toUpperCase() === 'NOW()' || value.toUpperCase() === 'CURRENT_TIMESTAMP') {
        return 'NOW()'
      }

      return `'${value}'`
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value)
    }

    if (Array.isArray(value)) {
      // Proper PostgreSQL array literal syntax with type casting
      // Use '{...}'::TYPE[] format which works in template literals
      if (fieldConfig.type === 'array') {
        if (value.length === 0) {
          // Empty array
          switch (fieldConfig.arrayType) {
          case 'string':
            return `'{}'::TEXT[]`
          case 'number':
            return `'{}'::INTEGER[]`
          case 'boolean':
            return `'{}'::BOOLEAN[]`
          }
        }
        else {
          // Non-empty array
          switch (fieldConfig.arrayType) {
          case 'string':
            return `'{${value.map(v => `"${v}"`).join(',')}}'::TEXT[]`
          case 'number':
            return `'{${value.join(',')}}'::INTEGER[]`
          case 'boolean':
            return `'{${value.join(',')}}'::BOOLEAN[]`
          }
        }
      }

      // Fallback for non-array types (shouldn't happen)
      return `'{}'`
    }

    // For objects (JSON), serialize to string
    if (typeof value === 'object' && value !== null) {
      return `'${JSON.stringify(value)}'`
    }

    return undefined
  }

  private normalizeDefault(defaultValue: string | null): string | undefined {
    if (!defaultValue)
      return undefined

    let normalized = defaultValue.trim()

    // Normalize SQL functions first
    if (normalized.toUpperCase().includes('NOW()') || normalized.toUpperCase().includes('CURRENT_TIMESTAMP')) {
      return 'NOW()'
    }

    // For array types, keep the full syntax including type cast
    // PostgreSQL returns: '{}'::integer[] or 'ARRAY[]::integer[]'
    if (normalized.match(/ARRAY\[\]::\w+\[\]/i) || normalized.match(/'\{\}'::\w+\[\]/)) {
      // Normalize to our expected format: '{}'::TYPE[]
      const typeMatch = normalized.match(/::(\w+\[\])/)

      if (typeMatch) {
        return `'{}'::${typeMatch[1]!.toUpperCase()}`
      }
    }

    // Remove PostgreSQL's type casting for non-array types (e.g., '0'::integer -> 0)
    normalized = normalized.replace(/::[\w\s]+/g, '')

    // Remove quotes for simple values
    normalized = normalized.replace(/^'(.*)'$/, '$1')

    return normalized
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private getColumnName(fieldName: string): string {
    // Convert camelCase to snake_case (same logic as Repository)
    return toSnake(fieldName)
  }
}
