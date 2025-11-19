import type { SQL } from 'bun'
import type { EntitySchema, OrderBy, QueryOptions, WhereCondition } from './types'
import { toSnake } from '@kaynooo/utils'

// ============================================================================
// Query Generator - Reusable SQL Generation Logic
// ============================================================================

export class QueryGenerator<T extends EntitySchema> {
  private validColumnNames: Set<string>

  constructor(
    private schema: T,
    private getColumnNameFn?: (fieldName: string) => string,
  ) {
    this.validColumnNames = new Set([
      'id',
      ...Object.keys(this.schema).map(k => this.getColumnName(k)),
    ])
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

  applyWhereConditions(
    query: any,
    where: WhereCondition<T>,
    db: SQL,
  ): any {
    if (!where)
      return query

    // Build WHERE clause using proper SQL template interpolation
    let whereClause = query
    let conditionCount = 0

    for (const [key, condition] of Object.entries(where)) {
      if (condition === null || condition === undefined)
        continue

      const columnName = this.getColumnName(key)

      this.validateColumnName(columnName)

      const prefix = conditionCount === 0 ? 'WHERE' : 'AND'

      // Simple equality or IN clause
      if (Array.isArray(condition)) {
        if (condition.length === 0) {
          // Empty array - skip condition
          continue
        }

        whereClause = db`${whereClause} ${db.unsafe(prefix)} ${db.unsafe(columnName)} IN ${db(condition)}`
        conditionCount++
      }
      // Operator object
      else if (typeof condition === 'object' && !Array.isArray(condition)) {
        for (const [op, value] of Object.entries(condition)) {
          if (value === undefined)
            continue

          const opPrefix = conditionCount === 0 ? 'WHERE' : 'AND'

          switch (op) {
          case 'eq':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} = ${value}`
            conditionCount++

            break
          case 'ne':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} != ${value}`
            conditionCount++

            break
          case 'gt':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} > ${value}`
            conditionCount++

            break
          case 'gte':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} >= ${value}`
            conditionCount++

            break
          case 'lt':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} < ${value}`
            conditionCount++

            break
          case 'lte':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} <= ${value}`
            conditionCount++

            break
          case 'in':
            if (Array.isArray(value) && value.length > 0) {
              whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} IN ${db(value)}`
              conditionCount++
            }

            break
          case 'notIn':
            if (Array.isArray(value) && value.length > 0) {
              whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} NOT IN ${db(value)}`
              conditionCount++
            }

            break
          case 'like':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} LIKE ${value}`
            conditionCount++

            break
          case 'ilike':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} ILIKE ${value}`
            conditionCount++

            break
          case 'isNull':
            if (value === true) {
              whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} IS NULL`
              conditionCount++
            }

            break
          case 'isNotNull':
            if (value === true) {
              whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} IS NOT NULL`
              conditionCount++
            }

            break
          case 'contains':
            whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} @> ${db([value])}`
            conditionCount++

            break
          case 'overlaps':
            if (Array.isArray(value)) {
              whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} && ${db(value)}`
              conditionCount++
            }

            break
          }
        }
      }
      // Simple value
      else {
        whereClause = db`${whereClause} ${db.unsafe(prefix)} ${db.unsafe(columnName)} = ${condition}`
        conditionCount++
      }
    }

    return whereClause
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
