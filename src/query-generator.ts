import type { SQL } from 'bun'
import type { EntitySchema, OrderBy, QueryOptions, WhereCondition } from './types'
import { toSnake } from '@kaynooo/utils'
import { validateSQLIdentifier } from './sql-utils'

// ============================================================================
// Query Generator - Reusable SQL Generation Logic
// ============================================================================

export class QueryGenerator<T extends EntitySchema> {
  private validColumnNames: Set<string>

  constructor(
    private schema: T,
    private getColumnNameFn?: (fieldName: string) => string,
  ) {
    // Validate all column names on construction
    const columnNames = Object.keys(this.schema).map(k => this.getColumnName(k))

    for (const columnName of columnNames) {
      validateSQLIdentifier(columnName, 'column')
    }
    validateSQLIdentifier('id', 'column')

    this.validColumnNames = new Set(['id', ...columnNames])
  }

  // ========================================================================
  // Column Name Resolution
  // ========================================================================

  getColumnName(fieldName: string): string {
    if (this.getColumnNameFn) {
      return this.getColumnNameFn(fieldName)
    }

    if (fieldName === 'id')
      return 'id'

    const fieldConfig = this.schema[fieldName]

    // If explicit columnName is set, use it
    if ((fieldConfig as any)?.columnName) {
      return (fieldConfig as any).columnName
    }

    // Otherwise, convert camelCase to snake_case automatically
    return toSnake(fieldName)
  }

  validateColumnName(columnName: string): void {
    if (!this.validColumnNames.has(columnName)) {
      throw new Error(`Invalid column name: ${columnName}`)
    }
  }

  // ========================================================================
  // Build SELECT Columns
  // ========================================================================

  buildSelectColumns(): string {
    // Build SELECT clause - cast array columns to TEXT to avoid Bun binary deserialization issues
    const selectColumns: string[] = ['id']

    for (const [fieldName, fieldConfig] of Object.entries(this.schema)) {
      const columnName = this.getColumnName(fieldName)

      if (fieldConfig.type === 'array') {
        // Cast arrays to TEXT format for proper deserialization
        selectColumns.push(`${columnName}::TEXT as ${columnName}`)
      }
      else {
        selectColumns.push(columnName)
      }
    }

    return selectColumns.join(', ')
  }

  // ========================================================================
  // Build ORDER BY Clause
  // ========================================================================

  buildOrderBy(order: OrderBy<T>): string {
    const orderClauses: string[] = []

    for (const [key, direction] of Object.entries(order)) {
      const columnName = this.getColumnName(key)

      this.validateColumnName(columnName)

      // Validate direction
      if (direction !== 'ASC' && direction !== 'DESC') {
        throw new Error(`Invalid ORDER BY direction: ${direction}`)
      }

      orderClauses.push(`${columnName} ${direction}`)
    }

    return orderClauses.join(', ')
  }

  // ========================================================================
  // Build WHERE Clause (using Bun SQL template)
  // ========================================================================

  // ========================================================================
  // Build WHERE Clause Components (optimized - single pass)
  // ========================================================================

  buildWhereComponents(where: WhereCondition<T>): {
    clauses: string[]
    values: unknown[]
    inClauses: { clause: string, values: unknown[] }[]
  } {
    const clauses: string[] = []
    const values: unknown[] = []
    const inClauses: { clause: string, values: unknown[] }[] = []

    for (const [key, condition] of Object.entries(where)) {
      if (condition === null || condition === undefined)
        continue

      const columnName = this.getColumnName(key)

      this.validateColumnName(columnName)

      // Simple equality or IN clause
      if (Array.isArray(condition)) {
        if (condition.length > 0) {
          inClauses.push({ clause: `${columnName} IN`, values: condition })
        }

        continue
      }

      // Operator object
      if (typeof condition === 'object') {
        for (const [op, value] of Object.entries(condition)) {
          if (value === undefined)
            continue

          switch (op) {
          case 'eq':
            clauses.push(`${columnName} =`)
            values.push(value)

            break
          case 'ne':
            clauses.push(`${columnName} !=`)
            values.push(value)

            break
          case 'gt':
            clauses.push(`${columnName} >`)
            values.push(value)

            break
          case 'gte':
            clauses.push(`${columnName} >=`)
            values.push(value)

            break
          case 'lt':
            clauses.push(`${columnName} <`)
            values.push(value)

            break
          case 'lte':
            clauses.push(`${columnName} <=`)
            values.push(value)

            break
          case 'in':
            if (Array.isArray(value) && value.length > 0) {
              inClauses.push({ clause: `${columnName} IN`, values: value })
            }

            break
          case 'notIn':
            if (Array.isArray(value) && value.length > 0) {
              inClauses.push({ clause: `${columnName} NOT IN`, values: value })
            }

            break
          case 'like':
            clauses.push(`${columnName} LIKE`)
            values.push(value)

            break
          case 'ilike':
            clauses.push(`${columnName} ILIKE`)
            values.push(value)

            break
          case 'isNull':
            if (value === true) {
              clauses.push(`${columnName} IS NULL`)
            }

            break
          case 'isNotNull':
            if (value === true) {
              clauses.push(`${columnName} IS NOT NULL`)
            }

            break
          case 'contains':
            inClauses.push({ clause: `${columnName} @>`, values: [value] })

            break
          case 'overlaps':
            if (Array.isArray(value)) {
              inClauses.push({ clause: `${columnName} &&`, values: value })
            }

            break
          }
        }

        continue
      }

      // Simple value
      clauses.push(`${columnName} =`)
      values.push(condition)
    }

    return { clauses, values, inClauses }
  }

  applyWhereConditions(
    query: any,
    where: WhereCondition<T>,
    db: SQL,
  ): any {
    if (!where)
      return query

    const { clauses, values, inClauses } = this.buildWhereComponents(where)
    const totalConditions = clauses.length + inClauses.length

    if (totalConditions === 0)
      return query

    let result = query
    let isFirst = true

    // Apply simple conditions
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i]!
      const prefix = isFirst ? 'WHERE' : 'AND'
      const value = values[i]

      // Clauses ending with IS NULL/IS NOT NULL have no value
      if (clause.endsWith('IS NULL') || clause.endsWith('IS NOT NULL')) {
        result = db`${result} ${db.unsafe(prefix)} ${db.unsafe(clause)}`
      }
      else {
        result = db`${result} ${db.unsafe(prefix)} ${db.unsafe(clause)} ${value}`
      }

      isFirst = false
    }

    // Apply IN/array conditions
    for (const { clause, values: inValues } of inClauses) {
      const prefix = isFirst ? 'WHERE' : 'AND'

      result = db`${result} ${db.unsafe(prefix)} ${db.unsafe(clause)} ${db(inValues)}`
      isFirst = false
    }

    return result
  }

  // ========================================================================
  // Build Complete SELECT Query
  // ========================================================================

  buildSelectQuery(
    tableName: string,
    options: QueryOptions<T>,
    db: SQL,
  ): any {
    const selectColumns = this.buildSelectColumns()
    let query = db`SELECT ${db.unsafe(selectColumns)} FROM ${db(tableName)}`

    if (options.where) {
      query = this.applyWhereConditions(query, options.where, db)
    }

    if (options.order) {
      const orderByClause = this.buildOrderBy(options.order)

      if (orderByClause) {
        query = db`${query} ORDER BY ${db.unsafe(orderByClause)}`
      }
    }

    if (options.limit !== undefined) {
      query = db`${query} LIMIT ${options.limit}`
    }

    if (options.offset !== undefined) {
      query = db`${query} OFFSET ${options.offset}`
    }

    return query
  }
}
