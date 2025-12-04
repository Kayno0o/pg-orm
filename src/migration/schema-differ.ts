import type { EntityDefinition, EntitySchema, FieldConfig, NumberFieldConfig } from '../types'
import type {
  DatabaseColumn,
  DatabaseIndex,
  DatabaseSchema,
  ForeignKeyInfo,
  MigrationConfig,
  PostgresTypeMapping,
  SchemaChange,
  SchemaDiff,
} from './types'
import { toSnake } from '@kaynooo/utils'
import normalizePostgresType from '../utils/normalizePostgresType'
import { DependencySorter } from './dependency-sorter'

// Schema Differ - Compare Entity Definitions with Database Schema

export class SchemaDiffer {
  constructor(
    private entities: Map<string, EntityDefinition<any>>,
    private config: Required<MigrationConfig>,
  ) {}

  /** Compare entity definitions with current database schema */
  async diff(dbSchema: DatabaseSchema): Promise<SchemaDiff> {
    // Store database schema for accessing indexes during comparison
    this.setDatabaseSchema(dbSchema)

    const changes: SchemaChange[] = []

    // Check for new tables and modified tables
    for (const [tableName, entityDef] of this.entities.entries()) {
      const tableExists = dbSchema.tables.has(tableName)

      if (!tableExists) {
        // New table - generate CREATE TABLE statement
        changes.push(this.generateCreateTable(entityDef))

        // Add foreign keys after table creation
        const fkChanges = this.generateForeignKeys(tableName, entityDef.schema)

        changes.push(...fkChanges)
      }
      else {
        // Existing table - check for column changes
        const columnChanges = this.compareColumns(
          tableName,
          entityDef.schema,
          dbSchema.columns.get(tableName) || [],
        )

        changes.push(...columnChanges)

        // Check for foreign key changes
        const fkChanges = this.compareForeignKeys(
          tableName,
          entityDef.schema,
          dbSchema.foreignKeys.get(tableName) || [],
        )

        changes.push(...fkChanges)
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

    // Sort changes by dependency order and validate foreign keys
    const sorter = new DependencySorter(this.entities, dbSchema)
    const sortedChanges = sorter.sortChanges(changes)

    const hasDestructiveChanges = sortedChanges.some(c => c.destructive)

    return {
      changes: sortedChanges,
      hasChanges: sortedChanges.length > 0,
      hasDestructiveChanges,
    }
  }

  /** Generates a CREATE TABLE statement. */
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

  /** Compares columns between entity definition and database schema. */
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

  /** Generates an ADD COLUMN statement. */
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

  /** Compares column type. */
  private compareColumnType(
    tableName: string,
    columnName: string,
    expectedType: PostgresTypeMapping,
    dbColumn: DatabaseColumn,
  ): SchemaChange | null {
    const actualType = normalizePostgresType(dbColumn)

    if (expectedType.type !== actualType) {
      return {
        type: 'MODIFY_COLUMN',
        tableName,
        sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${expectedType.type}`,
        description: `Change ${tableName}.${columnName} type from ${actualType} to ${expectedType.type}`,
        metadata: {
          columnName,
          oldValue: actualType,
          newValue: expectedType.type,
        },
      }
    }

    return null
  }

  /** Compares column nullability. */
  private compareColumnNullability(
    tableName: string,
    columnName: string,
    expectedType: PostgresTypeMapping,
    dbColumn: DatabaseColumn,
  ): SchemaChange | null {
    if (expectedType.nullable !== dbColumn.isNullable) {
      const nullConstraint = expectedType.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'

      return {
        type: 'MODIFY_COLUMN',
        tableName,
        sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} ${nullConstraint}`,
        description: `Change ${tableName}.${columnName} nullable from ${dbColumn.isNullable} to ${expectedType.nullable}`,
        metadata: {
          columnName,
          oldValue: dbColumn.isNullable,
          newValue: expectedType.nullable,
        },
      }
    }

    return null
  }

  /** Compares column default value. */
  private compareColumnDefault(
    tableName: string,
    columnName: string,
    expectedType: PostgresTypeMapping,
    dbColumn: DatabaseColumn,
  ): SchemaChange | null {
    const expectedDefault = expectedType.default
    const actualDefault = this.normalizeDefault(dbColumn.columnDefault)

    if (expectedDefault !== actualDefault) {
      if (expectedDefault) {
        return {
          type: 'MODIFY_COLUMN',
          tableName,
          sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${expectedDefault}`,
          description: `Set default value for ${tableName}.${columnName}`,
          metadata: {
            columnName,
            oldValue: actualDefault,
            newValue: expectedDefault,
          },
        }
      }

      if (actualDefault) {
        return {
          type: 'MODIFY_COLUMN',
          tableName,
          sql: `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP DEFAULT`,
          description: `Drop default value for ${tableName}.${columnName}`,
          metadata: {
            columnName,
            oldValue: actualDefault,
            newValue: null,
          },
        }
      }
    }

    return null
  }

  /** Compares column uniqueness. */
  private compareColumnUnique(
    tableName: string,
    columnName: string,
    fieldConfig: FieldConfig,
    dbColumn: DatabaseColumn,
  ): SchemaChange | null {
    const hasUniqueConstraint = fieldConfig.unique === true
    const dbHasUniqueIndex = this.hasUniqueIndex(columnName, dbColumn.tableName, this.getDbIndexes(tableName))

    if (hasUniqueConstraint && !dbHasUniqueIndex) {
      return {
        type: 'ADD_CONSTRAINT',
        tableName,
        sql: `ALTER TABLE ${tableName} ADD CONSTRAINT ${tableName}_${columnName}_unique UNIQUE (${columnName})`,
        description: `Add UNIQUE constraint to ${tableName}.${columnName}`,
        metadata: {
          columnName,
          constraintName: `${tableName}_${columnName}_unique`,
        },
      }
    }

    if (!hasUniqueConstraint && dbHasUniqueIndex) {
      if (!this.config.safeMigrations) {
        const uniqueIndexName = this.findUniqueIndexName(columnName, dbColumn.tableName, this.getDbIndexes(tableName))

        if (uniqueIndexName) {
          return {
            type: 'DROP_CONSTRAINT',
            tableName,
            sql: `ALTER TABLE ${tableName} DROP CONSTRAINT IF EXISTS ${uniqueIndexName}`,
            description: `Drop UNIQUE constraint from ${tableName}.${columnName}`,
            destructive: true,
            metadata: {
              columnName,
              constraintName: uniqueIndexName,
            },
          }
        }
      }
    }

    return null
  }

  /** Compares full column definition. */
  private compareColumnDefinition(
    tableName: string,
    fieldName: string,
    fieldConfig: FieldConfig,
    dbColumn: DatabaseColumn,
  ): SchemaChange[] {
    const changes: SchemaChange[] = []
    const columnName = this.getColumnName(fieldName)
    const expectedType = this.fieldToPostgresType(fieldConfig, columnName)

    const typeChange = this.compareColumnType(tableName, columnName, expectedType, dbColumn)

    if (typeChange)
      changes.push(typeChange)

    const nullChange = this.compareColumnNullability(tableName, columnName, expectedType, dbColumn)

    if (nullChange)
      changes.push(nullChange)

    const defaultChange = this.compareColumnDefault(tableName, columnName, expectedType, dbColumn)

    if (defaultChange)
      changes.push(defaultChange)

    const uniqueChange = this.compareColumnUnique(tableName, columnName, fieldConfig, dbColumn)

    if (uniqueChange)
      changes.push(uniqueChange)

    return changes
  }

  private dbSchema?: DatabaseSchema

  /** Sets the database schema for reference. */
  setDatabaseSchema(schema: DatabaseSchema): void {
    this.dbSchema = schema
  }

  /** Gets indexes for a table. */
  private getDbIndexes(tableName: string): DatabaseIndex[] {
    return this.dbSchema?.indexes.get(tableName) || []
  }

  /** Checks if a column has a unique index. */
  private hasUniqueIndex(columnName: string, tableName: string, indexes: DatabaseIndex[]): boolean {
    return indexes.some(
      idx =>
        idx.isUnique
        && !idx.isPrimary
        && idx.columnNames.length === 1
        && idx.columnNames[0] === columnName,
    )
  }

  /** Finds the name of a unique index. */
  private findUniqueIndexName(columnName: string, tableName: string, indexes: DatabaseIndex[]): string | null {
    const uniqueIndex = indexes.find(
      idx =>
        idx.isUnique
        && !idx.isPrimary
        && idx.columnNames.length === 1
        && idx.columnNames[0] === columnName,
    )

    return uniqueIndex?.indexName || null
  }

  /** Converts a field configuration to a PostgreSQL column definition. */
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

  /** Maps a field type to a PostgreSQL type. */
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

    case 'foreignKey':
      baseMapping.type = 'INTEGER'

      break
    }

    // Add default value
    if (fieldConfig.default !== undefined) {
      baseMapping.default = this.formatDefaultValue(fieldConfig.default, fieldConfig)
    }

    return baseMapping
  }

  /** Formats a default value for SQL. */
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

  /** Normalizes a PostgreSQL default value. */
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

  /** Generates SQL for a foreign key constraint. */
  private generateForeignKeySQL(
    tableName: string,
    fieldName: string,
    fk: NonNullable<NumberFieldConfig['foreignKey']>,
  ): { sql: string, constraintName: string, columnName: string } {
    const columnName = this.getColumnName(fieldName)
    const constraintName = `fk_${tableName}_${columnName}`
    const sql = `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${columnName}) REFERENCES ${fk.table}(${fk.column}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`

    return { sql, constraintName, columnName }
  }

  /** Generates foreign key changes for a table. */
  private generateForeignKeys(tableName: string, entitySchema: EntitySchema): SchemaChange[] {
    const changes: SchemaChange[] = []

    for (const [fieldName, fieldConfig] of Object.entries(entitySchema)) {
      const fk = (fieldConfig.type === 'number' && fieldConfig.foreignKey)
        ? fieldConfig.foreignKey
        : (fieldConfig.type === 'foreignKey' ? fieldConfig.foreignKey : null)

      if (fk) {
        const { sql, constraintName, columnName } = this.generateForeignKeySQL(tableName, fieldName, fk)

        changes.push({
          type: 'ADD_FOREIGN_KEY',
          tableName,
          sql,
          description: `Add foreign key: ${tableName}.${columnName} -> ${fk.table}.${fk.column}`,
          metadata: {
            columnName,
            constraintName,
          },
        })
      }
    }

    return changes
  }

  /** Finds new and modified foreign keys. */
  private findNewAndModifiedForeignKeys(
    tableName: string,
    entitySchema: EntitySchema,
    dbFkMap: Map<string, ForeignKeyInfo>,
  ): SchemaChange[] {
    const changes: SchemaChange[] = []

    for (const [fieldName, fieldConfig] of Object.entries(entitySchema)) {
      const fk = (fieldConfig.type === 'number' && fieldConfig.foreignKey)
        ? fieldConfig.foreignKey
        : (fieldConfig.type === 'foreignKey' ? fieldConfig.foreignKey : null)

      if (fk) {
        const columnName = this.getColumnName(fieldName)
        const dbFk = dbFkMap.get(columnName)

        if (!dbFk) {
          const { sql, constraintName } = this.generateForeignKeySQL(tableName, fieldName, fk)

          changes.push({
            type: 'ADD_FOREIGN_KEY',
            tableName,
            sql,
            description: `Add foreign key: ${tableName}.${columnName} -> ${fk.table}.${fk.column}`,
            metadata: {
              columnName,
              constraintName,
            },
          })
        }
        else {
          const needsUpdate
            = dbFk.foreignTableName !== fk.table
              || dbFk.foreignColumnName !== fk.column
              || dbFk.onDelete !== fk.onDelete
              || dbFk.onUpdate !== fk.onUpdate

          if (needsUpdate) {
            changes.push({
              type: 'DROP_FOREIGN_KEY',
              tableName,
              sql: `ALTER TABLE ${tableName} DROP CONSTRAINT ${dbFk.constraintName}`,
              description: `Drop foreign key constraint ${dbFk.constraintName}`,
              metadata: {
                constraintName: dbFk.constraintName,
              },
            })

            const { sql, constraintName } = this.generateForeignKeySQL(tableName, fieldName, fk)

            changes.push({
              type: 'ADD_FOREIGN_KEY',
              tableName,
              sql,
              description: `Add updated foreign key: ${tableName}.${columnName} -> ${fk.table}.${fk.column}`,
              metadata: {
                columnName,
                constraintName,
              },
            })
          }
        }
      }
    }

    return changes
  }

  /** Finds dropped foreign keys. */
  private findDroppedForeignKeys(
    tableName: string,
    entitySchema: EntitySchema,
    dbForeignKeys: ForeignKeyInfo[],
  ): SchemaChange[] {
    if (this.config.safeMigrations) {
      return []
    }

    const changes: SchemaChange[] = []
    const entityFkColumns = new Set<string>()

    for (const [fieldName, fieldConfig] of Object.entries(entitySchema)) {
      const hasFk = (fieldConfig.type === 'number' && fieldConfig.foreignKey) || fieldConfig.type === 'foreignKey'

      if (hasFk) {
        entityFkColumns.add(this.getColumnName(fieldName))
      }
    }

    for (const dbFk of dbForeignKeys) {
      if (!entityFkColumns.has(dbFk.columnName)) {
        changes.push({
          type: 'DROP_FOREIGN_KEY',
          tableName,
          sql: `ALTER TABLE ${tableName} DROP CONSTRAINT ${dbFk.constraintName}`,
          description: `Drop foreign key constraint ${dbFk.constraintName}`,
          destructive: true,
          metadata: {
            constraintName: dbFk.constraintName,
          },
        })
      }
    }

    return changes
  }

  /** Compares foreign keys between entity definition and database schema. */
  private compareForeignKeys(
    tableName: string,
    entitySchema: EntitySchema,
    dbForeignKeys: ForeignKeyInfo[],
  ): SchemaChange[] {
    const dbFkMap = new Map(
      dbForeignKeys.map(fk => [fk.columnName, fk]),
    )

    const newAndModified = this.findNewAndModifiedForeignKeys(tableName, entitySchema, dbFkMap)
    const dropped = this.findDroppedForeignKeys(tableName, entitySchema, dbForeignKeys)

    return [...newAndModified, ...dropped]
  }

  /** Converts a field name to a column name. */
  private getColumnName(fieldName: string): string {
    // Convert camelCase to snake_case (same logic as Repository)
    return toSnake(fieldName)
  }
}
