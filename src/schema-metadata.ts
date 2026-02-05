import type { EntitySchema, FieldConfig } from './types'
import { toSnake } from '@kaynooo/utils'
import { hasColumnName } from './types'

/**
 * Centralized schema metadata for an entity.
 * Handles mapping between field names (JS/TS) and column names (SQL).
 */
export class SchemaMetadata<T extends EntitySchema = EntitySchema> {
  private fieldToColumnMap = new Map<string, string>()
  private columnToFieldMap = new Map<string, string>()
  private fieldConfigs = new Map<string, FieldConfig>()

  constructor(
    public readonly tableName: string,
    public readonly schema: T,
  ) {
    this.fieldToColumnMap.set('id', 'id')
    this.columnToFieldMap.set('id', 'id')

    for (const [fieldName, config] of Object.entries(schema)) {
      const columnName = hasColumnName(config) ? config.columnName : toSnake(fieldName)

      this.fieldToColumnMap.set(fieldName, columnName)
      this.columnToFieldMap.set(columnName, fieldName)
      this.fieldConfigs.set(fieldName, config)
    }
  }

  /**
   * Resolves a field name to its corresponding database column name.
   */
  getColumnName(fieldName: string): string {
    return this.fieldToColumnMap.get(fieldName) || toSnake(fieldName)
  }

  /**
   * Resolves a database column name to its corresponding entity field name.
   */
  getFieldName(columnName: string): string {
    return this.columnToFieldMap.get(columnName) || columnName
  }

  /**
   * Checks if a field name exists in the schema.
   */
  isValidField(fieldName: string): boolean {
    return fieldName === 'id' || fieldName in this.schema
  }

  /**
   * Checks if a column name exists in the database table.
   */
  isValidColumn(columnName: string): boolean {
    return this.columnToFieldMap.has(columnName)
  }

  /**
   * Retrieves the configuration for a specific field.
   */
  getFieldConfig(fieldName: string): FieldConfig | undefined {
    return this.fieldConfigs.get(fieldName)
  }

  /**
   * Returns all database column names for this entity.
   */
  getColumns(): string[] {
    return Array.from(this.columnToFieldMap.keys())
  }

  /**
   * Returns all entity field names.
   */
  getFields(): string[] {
    return ['id', ...Object.keys(this.schema)]
  }

  /**
   * Returns a list of all field-to-column mappings with their configurations.
   */
  getFieldToColumnMappings(): { fieldName: string, columnName: string, config: FieldConfig }[] {
    return Object.entries(this.schema).map(([fieldName, config]) => ({
      fieldName,
      columnName: this.getColumnName(fieldName),
      config,
    }))
  }
}
