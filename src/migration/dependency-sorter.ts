import type { EntityDefinition, EntitySchema, FieldConfig } from '../types'
import type {
  DatabaseSchema,
  SchemaChange,
  SortedChangeGroups,
  TableDependency,
  ValidationError,
  ValidationResult,
} from './types'
import { toSnake } from '@kaynooo/utils'
import normalizePostgresType from '../utils/normalizePostgresType'

// Dependency Graph Builder

class DependencyGraphBuilder {
  constructor(private entities: Map<string, EntityDefinition<any>>) {}

  /** Build dependency graph from entity definitions */
  buildGraph(): Map<string, TableDependency> {
    const graph = new Map<string, TableDependency>()

    for (const [tableName, entityDef] of this.entities.entries()) {
      const dependsOn = new Set<string>()
      let selfReferencing = false

      // Extract FK dependencies from entity schema
      for (const [_fieldName, fieldConfig] of Object.entries(entityDef.schema)) {
        const config = fieldConfig as FieldConfig
        const fk = (config.type === 'number' && config.foreignKey)
          ? config.foreignKey
          : (config.type === 'foreignKey' ? config.foreignKey : null)

        if (fk) {
          const refTable = fk.table

          if (refTable === tableName) {
            selfReferencing = true
          }
          else {
            dependsOn.add(refTable)
          }
        }
      }

      graph.set(tableName, {
        tableName,
        dependsOn,
        selfReferencing,
      })
    }

    return graph
  }

  /** Extract all foreign key relationships from an entity */
  extractForeignKeys(
    tableName: string,
    schema: EntitySchema,
  ): { fieldName: string, table: string, column: string, isSelfReference: boolean }[] {
    const foreignKeys: { fieldName: string, table: string, column: string, isSelfReference: boolean }[] = []

    for (const [fieldName, fieldConfig] of Object.entries(schema)) {
      const config = fieldConfig as FieldConfig
      const fk = (config.type === 'number' && config.foreignKey)
        ? config.foreignKey
        : (config.type === 'foreignKey' ? config.foreignKey : null)

      if (fk) {
        foreignKeys.push({
          fieldName,
          table: fk.table,
          column: fk.column,
          isSelfReference: fk.table === tableName,
        })
      }
    }

    return foreignKeys
  }
}

// Topological Sorter - Kahn's Algorithm

class TopologicalSorter {
  /**
   * Sort tables by dependency order using Kahn's algorithm
   * Returns sorted table list or cycles if circular dependencies exist
   */
  sort(graph: Map<string, TableDependency>): { sorted: string[], cycles: string[][] | null } {
    // Calculate in-degree for each table
    const inDegree = new Map<string, number>()
    const queue: string[] = []
    const sorted: string[] = []

    // Initialize in-degrees
    for (const [tableName, deps] of graph.entries()) {
      inDegree.set(tableName, deps.dependsOn.size)

      if (deps.dependsOn.size === 0) {
        queue.push(tableName)
      }
    }

    // Process queue
    while (queue.length > 0) {
      const current = queue.shift()!

      sorted.push(current)

      // For each table that depends on current
      for (const [tableName, deps] of graph.entries()) {
        if (deps.dependsOn.has(current)) {
          const newDegree = inDegree.get(tableName)! - 1

          inDegree.set(tableName, newDegree)

          if (newDegree === 0) {
            queue.push(tableName)
          }
        }
      }
    }

    // Check if all tables were sorted
    if (sorted.length !== graph.size) {
      // Circular dependency detected
      const cycles = this.detectCycles(graph, sorted)

      return { sorted: [], cycles }
    }

    return { sorted, cycles: null }
  }

  /**
   * Detect circular dependencies in the graph
   * Returns array of cycle paths
   */
  private detectCycles(graph: Map<string, TableDependency>, sorted: string[]): string[][] {
    const cycles: string[][] = []
    const sortedSet = new Set(sorted)
    const visited = new Set<string>()
    const recursionStack = new Set<string>()
    const currentPath: string[] = []

    // Only process tables that weren't sorted (they're part of cycles)
    const unsortedTables = Array.from(graph.keys()).filter(t => !sortedSet.has(t))

    for (const table of unsortedTables) {
      if (!visited.has(table)) {
        this.dfs(table, graph, visited, recursionStack, currentPath, cycles)
      }
    }

    return cycles
  }

  /** DFS to find cycles */
  // eslint-disable-next-line max-params -- DFS algorithm requires state tracking
  private dfs(
    table: string,
    graph: Map<string, TableDependency>,
    visited: Set<string>,
    recursionStack: Set<string>,
    currentPath: string[],
    cycles: string[][],
  ): void {
    visited.add(table)
    recursionStack.add(table)
    currentPath.push(table)

    const deps = graph.get(table)

    if (deps) {
      for (const depTable of deps.dependsOn) {
        if (!visited.has(depTable)) {
          this.dfs(depTable, graph, visited, recursionStack, currentPath, cycles)
        }
        else if (recursionStack.has(depTable)) {
          // Found a cycle
          const cycleStartIndex = currentPath.indexOf(depTable)
          const cycle = [...currentPath.slice(cycleStartIndex), depTable]

          cycles.push(cycle)
        }
      }
    }

    currentPath.pop()
    recursionStack.delete(table)
  }
}

// Foreign Key Validator

class ForeignKeyValidator {
  constructor(
    private entities: Map<string, EntityDefinition<any>>,
    private dbSchema: DatabaseSchema,
  ) {}

  /** Validate all foreign key references */
  validateForeignKeys(changes: SchemaChange[]): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: string[] = []

    for (const change of changes) {
      if (change.type === 'ADD_FOREIGN_KEY') {
        const fkInfo = this.extractForeignKeyInfo(change)

        if (!fkInfo)
          continue

        // Validate referenced table exists
        const tableValidation = this.validateReferencedTable(fkInfo, changes)

        if (!tableValidation.valid) {
          errors.push(...tableValidation.errors)
          warnings.push(...tableValidation.warnings)
        }

        // Validate type compatibility
        const typeValidation = this.validateTypeCompatibility(fkInfo, changes)

        if (!typeValidation.valid) {
          errors.push(...typeValidation.errors)
          warnings.push(...typeValidation.warnings)
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /** Extract FK metadata from ADD_FOREIGN_KEY change */
  private extractForeignKeyInfo(change: SchemaChange): {
    sourceTable: string
    sourceColumn: string
    targetTable: string
    targetColumn: string
  } | null {
    // Parse SQL: ALTER TABLE source ADD CONSTRAINT ... FOREIGN KEY (col) REFERENCES target(col)
    const match = change.sql.match(
      /FOREIGN KEY \((\w+)\) REFERENCES (\w+)\((\w+)\)/,
    )

    if (!match) {
      return null
    }

    return {
      sourceTable: change.tableName,
      sourceColumn: match[1]!,
      targetTable: match[2]!,
      targetColumn: match[3]!,
    }
  }

  /** Validate that referenced table exists */
  private validateReferencedTable(
    fkInfo: { sourceTable: string, sourceColumn: string, targetTable: string, targetColumn: string },
    changes: SchemaChange[],
  ): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: string[] = []

    const { targetTable } = fkInfo

    // Check if table exists in entities
    const existsInEntities = this.entities.has(targetTable)

    // Check if table exists in database
    const existsInDB = this.dbSchema.tables.has(targetTable)

    // Check if table will be created in this migration
    const willBeCreated = changes.some(
      c => c.type === 'CREATE_TABLE' && c.tableName === targetTable,
    )

    if (!existsInDB && !willBeCreated) {
      if (existsInEntities) {
        errors.push({
          error: `Foreign key ${fkInfo.sourceTable}.${fkInfo.sourceColumn} references table '${targetTable}' which does not exist in database`,
          tableName: fkInfo.sourceTable,
          columnName: fkInfo.sourceColumn,
        })
      }
      else {
        warnings.push(
          `Foreign key ${fkInfo.sourceTable}.${fkInfo.sourceColumn} references unmanaged table '${targetTable}' (not defined in ORM entities)`,
        )
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /** Validate type compatibility between FK column and referenced column */
  private validateTypeCompatibility(
    fkInfo: { sourceTable: string, sourceColumn: string, targetTable: string, targetColumn: string },
    changes: SchemaChange[],
  ): ValidationResult {
    const errors: ValidationError[] = []
    const warnings: string[] = []

    const sourceType = this.resolveColumnType(fkInfo.sourceTable, fkInfo.sourceColumn, changes)
    const targetType = this.resolveColumnType(fkInfo.targetTable, fkInfo.targetColumn, changes)

    if (!sourceType || !targetType) {
      // Can't determine types - skip validation
      return { valid: true, errors: [], warnings: [] }
    }

    const normalizedSource = this.normalizeTypeForFK(sourceType)
    const normalizedTarget = this.normalizeTypeForFK(targetType)

    if (normalizedSource !== normalizedTarget) {
      errors.push({
        error: `Foreign key type mismatch: ${fkInfo.sourceTable}.${fkInfo.sourceColumn} (${sourceType}) cannot reference ${fkInfo.targetTable}.${fkInfo.targetColumn} (${targetType})`,
        fix: `Ensure both columns have compatible types. INTEGER, BIGINT, and SERIAL are compatible. Change ${fkInfo.sourceTable}.${fkInfo.sourceColumn} to match ${targetType}.`,
        tableName: fkInfo.sourceTable,
        columnName: fkInfo.sourceColumn,
      })
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /** Resolve the PostgreSQL type for a column from entity definition or database schema */
  private resolveColumnType(
    tableName: string,
    columnName: string,
    changes: SchemaChange[],
  ): string | null {
    // Special case: 'id' column is always SERIAL/INTEGER
    if (columnName === 'id') {
      return 'INTEGER'
    }

    // First, check pending changes (CREATE_TABLE or ADD_COLUMN) - these take precedence
    // because they represent the actual SQL that will be executed
    for (const change of changes) {
      if (change.tableName === tableName) {
        if (change.type === 'CREATE_TABLE') {
          // Parse CREATE TABLE statement for column type
          const typeMatch = change.sql.match(new RegExp(`${columnName}\\s+(\\w+[\\w\\s\\[\\]()]+)`, 'i'))

          if (typeMatch) {
            return typeMatch[1]!.trim().split(/\s+/)[0]!
          }
        }
        else if (change.type === 'ADD_COLUMN' && change.metadata?.columnName === columnName) {
          // Parse ADD COLUMN statement
          const typeMatch = change.sql.match(new RegExp(`ADD COLUMN ${columnName}\\s+(\\w+[\\w\\s\\[\\]()]+)`, 'i'))

          if (typeMatch) {
            return typeMatch[1]!.trim().split(/\s+/)[0]!
          }
        }
      }
    }

    // Try to get from database schema (existing columns)
    const dbColumns = this.dbSchema.columns.get(tableName)

    if (dbColumns) {
      const column = dbColumns.find(c => c.columnName === columnName)

      if (column) {
        return normalizePostgresType(column)
      }
    }

    // Finally, fall back to entity definition
    const entity = this.entities.get(tableName)

    if (entity) {
      // Find field by column name
      for (const [fieldName, fieldConfig] of Object.entries(entity.schema)) {
        const config = fieldConfig as FieldConfig
        const fieldColumnName = this.getColumnName(tableName, fieldName, config)

        if (fieldColumnName === columnName) {
          return this.fieldConfigToPostgresType(config)
        }
      }
    }

    return null
  }

  /** Convert field config to PostgreSQL type */
  private fieldConfigToPostgresType(fieldConfig: FieldConfig): string {
    switch (fieldConfig.type) {
    case 'string':
      return fieldConfig.maxLength ? `VARCHAR(${fieldConfig.maxLength})` : 'TEXT'
    case 'number':
      return fieldConfig.integer ? 'INTEGER' : 'DOUBLE PRECISION'
    case 'boolean':
      return 'BOOLEAN'
    case 'json':
      return 'JSON'
    case 'jsonb':
      return 'JSONB'
    case 'uuid':
      return 'UUID'
    case 'timestamp':
      return 'TIMESTAMP WITH TIME ZONE'
    case 'date':
      return 'DATE'
    case 'blob':
      return 'BYTEA'
    case 'array':
      switch (fieldConfig.arrayType) {
      case 'string':
        return 'TEXT[]'
      case 'number':
        return 'INTEGER[]'
      case 'boolean':
        return 'BOOLEAN[]'
      }

      break
    case 'enum':
      return 'TEXT'
    case 'foreignKey':
      return 'INTEGER'
    }

    return 'TEXT'
  }

  /**
   * Normalize PostgreSQL types for foreign key compatibility checking
   * Some types are compatible even if not identical
   */
  private normalizeTypeForFK(type: string): string {
    const upperType = type.toUpperCase()

    // Integer types are compatible
    if (upperType === 'INTEGER' || upperType === 'BIGINT' || upperType === 'SERIAL' || upperType === 'BIGSERIAL') {
      return 'INTEGER'
    }

    // Text types are compatible
    if (upperType === 'TEXT' || upperType.startsWith('VARCHAR')) {
      return 'TEXT'
    }

    // Floating point types are compatible
    if (upperType === 'DOUBLE PRECISION' || upperType === 'REAL') {
      return 'DOUBLE PRECISION'
    }

    // Timestamp types are compatible
    if (upperType.startsWith('TIMESTAMP')) {
      return 'TIMESTAMP'
    }

    // Others require exact match
    return upperType
  }

  /** Get column name from field name (same logic as Repository) */
  private getColumnName(tableName: string, fieldName: string, fieldConfig: FieldConfig): string {
    const entity = this.entities.get(tableName)

    if (entity) {
      return entity.metadata.getColumnName(fieldName)
    }

    if (fieldConfig.columnName) {
      return fieldConfig.columnName
    }

    return toSnake(fieldName)
  }
}

// Dependency Sorter - Main Class

export class DependencySorter {
  private graphBuilder: DependencyGraphBuilder
  private sorter: TopologicalSorter
  private validator: ForeignKeyValidator

  constructor(
    private entities: Map<string, EntityDefinition<any>>,
    private dbSchema: DatabaseSchema,
  ) {
    this.graphBuilder = new DependencyGraphBuilder(entities)
    this.sorter = new TopologicalSorter()
    this.validator = new ForeignKeyValidator(entities, dbSchema)
  }

  /** Sort schema changes by dependency order */
  sortChanges(changes: SchemaChange[]): SchemaChange[] {
    // Step 1: Validate foreign key references
    const validation = this.validator.validateForeignKeys(changes)

    if (!validation.valid) {
      const errorMessages = validation.errors.map(e =>
        e.fix ? `${e.error}\n   Fix: ${e.fix}` : e.error,
      ).join('\n')

      throw new Error(`Invalid foreign key references:\n${errorMessages}`)
    }

    // Display warnings if any
    if (validation.warnings.length > 0) {
      console.warn('\n⚠️  Foreign Key Warnings:')
      for (const warning of validation.warnings) {
        console.warn(`   ${warning}`)
      }
    }

    // Step 2: Group changes by type
    const groups = this.groupChangesByType(changes)

    // Step 3: Build dependency graph and sort tables
    const graph = this.graphBuilder.buildGraph()
    const { sorted, cycles } = this.sorter.sort(graph)

    // Step 4: Handle circular dependencies
    if (cycles && cycles.length > 0) {
      const cycleDesc = cycles.map(cycle => cycle.join(' → ')).join('\n   ')

      throw new Error(
        `Circular foreign key dependencies detected:\n   ${cycleDesc}\n\n`
        + 'To fix this, you can:\n'
        + '1. Remove one FK constraint and add it manually after table creation\n'
        + '2. Redesign your schema to remove circular references\n'
        + '3. Use nullable foreign keys where appropriate',
      )
    }

    // Step 5: Sort changes by dependency order
    const sortedCreateTables = this.sortByDependency(groups.createTables, sorted)
    const sortedAddForeignKeys = this.sortByDependency(groups.addForeignKeys, sorted)

    // Step 6: Return changes in correct execution order
    return [
      ...groups.dropForeignKeys, // Drop FKs first
      ...groups.dropColumns, // Then drop columns
      ...sortedCreateTables, // Create tables in dependency order
      ...groups.addColumns, // Add columns to existing tables
      ...groups.modifyColumns, // Modify existing columns
      ...sortedAddForeignKeys, // Add FKs last (all tables/columns exist)
      ...groups.other, // Other changes
      ...groups.dropTables, // Drop tables last
    ]
  }

  /** Group changes by type for ordered execution */
  private groupChangesByType(changes: SchemaChange[]): SortedChangeGroups {
    const groups: SortedChangeGroups = {
      createTables: [],
      addColumns: [],
      modifyColumns: [],
      addForeignKeys: [],
      dropForeignKeys: [],
      dropColumns: [],
      dropTables: [],
      other: [],
    }

    for (const change of changes) {
      switch (change.type) {
      case 'CREATE_TABLE':
        groups.createTables.push(change)

        break
      case 'ADD_COLUMN':
        groups.addColumns.push(change)

        break
      case 'MODIFY_COLUMN':
        groups.modifyColumns.push(change)

        break
      case 'ADD_FOREIGN_KEY':
        groups.addForeignKeys.push(change)

        break
      case 'DROP_FOREIGN_KEY':
        groups.dropForeignKeys.push(change)

        break
      case 'DROP_COLUMN':
        groups.dropColumns.push(change)

        break
      case 'DROP_TABLE':
        groups.dropTables.push(change)

        break
      default:
        groups.other.push(change)

        break
      }
    }

    return groups
  }

  /** Sort changes by table dependency order */
  private sortByDependency(changes: SchemaChange[], sortedTables: string[]): SchemaChange[] {
    if (changes.length === 0) {
      return changes
    }

    // Create a map of table name to its position in sorted order
    const tableOrder = new Map<string, number>()

    for (let i = 0; i < sortedTables.length; i++) {
      tableOrder.set(sortedTables[i]!, i)
    }

    // Sort changes by table order
    return changes.sort((a, b) => {
      const orderA = tableOrder.get(a.tableName) ?? Number.MAX_SAFE_INTEGER
      const orderB = tableOrder.get(b.tableName) ?? Number.MAX_SAFE_INTEGER

      return orderA - orderB
    })
  }
}
