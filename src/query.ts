import type { SQL } from 'bun'
import type { AggregationResult, DatabaseRow, EntitySchema, InferEntity, InferProjectionClean, OrderDirection } from './types'
import { toSnake } from '@kaynooo/utils'
import { validateSQLIdentifier } from './sql-utils'

// ============================================================================
// Query Builder (Secure with Parameterized Queries)
// ============================================================================

export class QueryBuilder<
  T extends EntitySchema,
  SelectedFields extends readonly (keyof T | 'id')[] = never,
> {
  private selectFields: string[] = ['*']
  private whereConditions: string[] = []
  private whereParams: any[] = []
  private orderByFields: { field: string, direction: OrderDirection }[] = []
  private limitValue?: number
  private offsetValue?: number
  private groupByFields: string[] = []
  private aggregations = new Map<string, { func: string, field: string }>()
  private validColumns: Set<string>

  constructor(
    private tableName: string,
    private db: SQL,
    private schema: T,
    private mapper?: (row: DatabaseRow) => any,
  ) {
    // Validate table name on construction to prevent SQL injection
    validateSQLIdentifier(tableName, 'table')
    // Cache valid columns at construction time for O(1) lookup
    this.validColumns = new Set(['id', ...Object.keys(schema).map(k => this.getColumnName(k))])
  }

  // Helper to get column name from field name
  private getColumnName(fieldName: string): string {
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

  // Helper to validate column name (security: prevent SQL injection)
  private validateColumnName(field: string): string {
    const columnName = this.getColumnName(field)

    if (!this.validColumns.has(columnName)) {
      throw new Error(`Invalid column name: ${field}. Column not found in schema.`)
    }

    return columnName
  }

  // Helper to add parameter and return placeholder
  private addParam(value: any): string {
    this.whereParams.push(value)

    return `$${this.whereParams.length}`
  }

  // ========================================================================
  // Select
  // ========================================================================

  select<F extends readonly (keyof T | 'id')[]>(
    ...fields: F
  ): QueryBuilder<T, F> {
    this.selectFields = fields.map(f => this.validateColumnName(String(f)))

    return this as any as QueryBuilder<T, F>
  }

  // ========================================================================
  // Where Clauses (Secure with Parameterization)
  // ========================================================================

  where(field: keyof T | 'id', operator: string, value: any): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(value)

    this.whereConditions.push(`${columnName} ${operator} ${placeholder}`)

    return this
  }

  whereEquals(field: keyof T | 'id', value: any): this {
    return this.where(field, '=', value)
  }

  whereIn(field: keyof T | 'id', values: any[]): this {
    if (values.length === 0) {
      // Empty IN clause always returns false
      this.whereConditions.push('FALSE')

      return this
    }

    const columnName = this.validateColumnName(String(field))
    const placeholders = values.map(v => this.addParam(v)).join(', ')

    this.whereConditions.push(`${columnName} IN (${placeholders})`)

    return this
  }

  whereNotIn(field: keyof T | 'id', values: any[]): this {
    if (values.length === 0) {
      // Empty NOT IN clause always returns true
      return this
    }

    const columnName = this.validateColumnName(String(field))
    const placeholders = values.map(v => this.addParam(v)).join(', ')

    this.whereConditions.push(`${columnName} NOT IN (${placeholders})`)

    return this
  }

  whereLike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'LIKE', pattern)
  }

  whereILike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'ILIKE', pattern)
  }

  whereNull(field: keyof T | 'id'): this {
    const columnName = this.validateColumnName(String(field))

    this.whereConditions.push(`${columnName} IS NULL`)

    return this
  }

  whereNotNull(field: keyof T | 'id'): this {
    const columnName = this.validateColumnName(String(field))

    this.whereConditions.push(`${columnName} IS NOT NULL`)

    return this
  }

  whereBetween(field: keyof T | 'id', min: any, max: any): this {
    const columnName = this.validateColumnName(String(field))
    const minPlaceholder = this.addParam(min)
    const maxPlaceholder = this.addParam(max)

    this.whereConditions.push(`${columnName} BETWEEN ${minPlaceholder} AND ${maxPlaceholder}`)

    return this
  }

  // PostgreSQL-specific operators
  whereJsonContains(field: keyof T, value: any): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(JSON.stringify(value))

    this.whereConditions.push(`${columnName} @> ${placeholder}::jsonb`)

    return this
  }

  whereJsonHasKey(field: keyof T, key: string): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(key)

    this.whereConditions.push(`${columnName} ? ${placeholder}`)

    return this
  }

  whereArrayContains(field: keyof T, value: any): this {
    const columnName = this.validateColumnName(String(field))

    // For array operations, we need to pass the array value directly and let PostgreSQL handle it
    // This is secure because the value goes through parameterization
    const placeholder = this.addParam([value])

    // Use ANY for checking if array contains value (more secure than string formatting)
    this.whereConditions.push(`${placeholder} = ANY(${columnName})`)

    return this
  }

  whereArrayOverlaps(field: keyof T, values: any[]): this {
    const columnName = this.validateColumnName(String(field))

    // For array overlap, pass array directly through parameterization
    const placeholder = this.addParam(values)

    this.whereConditions.push(`${columnName} && ${placeholder}`)

    return this
  }

  // ========================================================================
  // Order By (Validated Column Names)
  // ========================================================================

  orderBy(field: keyof T | 'id', direction: OrderDirection = 'ASC'): this {
    const columnName = this.validateColumnName(String(field))

    // Validate direction to prevent SQL injection
    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new Error(`Invalid ORDER BY direction: ${direction}. Must be ASC or DESC.`)
    }

    this.orderByFields.push({ field: columnName, direction })

    return this
  }

  orderByDesc(field: keyof T | 'id'): this {
    return this.orderBy(field, 'DESC')
  }

  // ========================================================================
  // Group By (Validated Column Names)
  // ========================================================================

  groupBy(...fields: (keyof T | 'id')[]): this {
    this.groupByFields = fields.map(f => this.validateColumnName(String(f)))

    return this
  }

  // ========================================================================
  // Aggregations
  // ========================================================================

  sum(field: keyof T): this {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('sum', { func: 'SUM', field: columnName })

    return this
  }

  avg(field: keyof T): this {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('avg', { func: 'AVG', field: columnName })

    return this
  }

  min(field: keyof T): this {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('min', { func: 'MIN', field: columnName })

    return this
  }

  max(field: keyof T): this {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('max', { func: 'MAX', field: columnName })

    return this
  }

  countAs(alias = 'count'): this {
    this.aggregations.set(alias, { func: 'COUNT', field: '*' })

    return this
  }

  /**
   * Execute aggregation query
   */
  async aggregate(): Promise<AggregationResult> {
    // Build aggregation SELECT
    const aggParts: string[] = []

    for (const [alias, { func, field }] of this.aggregations) {
      aggParts.push(`${func}(${field}) as ${alias}`)
    }

    const selectClause = aggParts.join(', ')
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

    const query = `SELECT ${selectClause} FROM ${this.tableName} ${whereClause}`
    const [result] = await this.db.unsafe(query, this.whereParams)

    if (!result)
      return {}

    // Convert string numbers to actual numbers
    const converted: AggregationResult = {}

    for (const [key, value] of Object.entries(result)) {
      (converted as any)[key] = value !== null ? Number(value) : undefined
    }

    return converted
  }

  // ========================================================================
  // Limit/Offset
  // ========================================================================

  limit(value: number): this {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid LIMIT value: ${value}. Must be a non-negative integer.`)
    }

    this.limitValue = value

    return this
  }

  offset(value: number): this {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid OFFSET value: ${value}. Must be a non-negative integer.`)
    }

    this.offsetValue = value

    return this
  }

  // ========================================================================
  // Build Query (Public for inspection/debugging)
  // ========================================================================

  build(): { sql: string, params: any[] } {
    return {
      sql: this.buildQuery(),
      params: [...this.whereParams],
    }
  }

  // ========================================================================
  // Execution
  // ========================================================================

  async execute(): Promise<SelectedFields extends never ? InferEntity<T>[] : InferProjectionClean<T, SelectedFields>[]> {
    const { sql, params } = this.build()
    const results = await this.db.unsafe(sql, params)

    // If aggregations are present, don't use mapper (aggregation results are plain objects)
    if (this.aggregations.size > 0) {
      // Convert string numbers from aggregations to actual numbers
      return results.map((row: DatabaseRow) => {
        const converted: any = { ...row }

        for (const alias of this.aggregations.keys()) {
          if (converted[alias] !== null && converted[alias] !== undefined) {
            converted[alias] = Number(converted[alias])
          }
        }

        return converted
      }) as any
    }

    // Use mapper if provided to properly convert database rows to entities
    // This ensures arrays are parsed, dates are converted, and trait methods work
    if (this.mapper) {
      return results.map((row: DatabaseRow) => this.mapper!(row))
    }

    // Fallback to raw results (won't have trait methods or proper array/date handling)
    return results as any
  }

  async findOne(): Promise<SelectedFields extends never ? InferEntity<T> | null : InferProjectionClean<T, SelectedFields> | null> {
    this.limit(1)
    const results = await this.execute()

    return (results[0] || null) as any
  }

  async count(): Promise<number> {
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

    const query = `SELECT COUNT(id) as count FROM ${this.tableName} ${whereClause}`
    const [result] = await this.db.unsafe(query, this.whereParams)

    return Number(result.count)
  }

  async latest(field: keyof T | 'id' = 'id'): Promise<SelectedFields extends never ? InferEntity<T> | null : InferProjectionClean<T, SelectedFields> | null> {
    return this.orderByDesc(field).findOne() as any
  }

  async oldest(field: keyof T | 'id' = 'id'): Promise<SelectedFields extends never ? InferEntity<T> | null : InferProjectionClean<T, SelectedFields> | null> {
    return this.orderBy(field, 'ASC').findOne() as any
  }

  async random(limitValue = 1): Promise<SelectedFields extends never ? InferEntity<T>[] : InferProjectionClean<T, SelectedFields>[]> {
    if (!Number.isInteger(limitValue) || limitValue < 1) {
      throw new Error(`Invalid random limit: ${limitValue}. Must be a positive integer.`)
    }

    const selectClause = this.selectFields.join(', ')
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

    const limitPlaceholder = this.addParam(limitValue)
    const query = `SELECT ${selectClause} FROM ${this.tableName} ${whereClause} ORDER BY RANDOM() LIMIT ${limitPlaceholder}`
    const results = await this.db.unsafe(query, this.whereParams)

    return results as any
  }

  // ========================================================================
  // Build Query (Private)
  // ========================================================================

  private buildQuery(): string {
    // Handle aggregation SELECT
    let selectClause: string

    if (this.aggregations.size > 0) {
      const aggParts: string[] = []

      // Add GROUP BY fields first
      if (this.groupByFields.length > 0) {
        aggParts.push(...this.groupByFields)
      }

      // Add aggregations
      for (const [alias, { func, field }] of this.aggregations) {
        aggParts.push(`${func}(${field}) as ${alias}`)
      }

      selectClause = aggParts.join(', ')
    }
    else {
      selectClause = this.selectFields.join(', ')
    }

    let query = `SELECT ${selectClause} FROM ${this.tableName}`

    if (this.whereConditions.length > 0) {
      query += ` WHERE ${this.whereConditions.join(' AND ')}`
    }

    if (this.groupByFields.length > 0) {
      query += ` GROUP BY ${this.groupByFields.join(', ')}`
    }

    if (this.orderByFields.length > 0) {
      const orderClauses = this.orderByFields.map(o => `${o.field} ${o.direction}`).join(', ')

      query += ` ORDER BY ${orderClauses}`
    }

    // LIMIT and OFFSET are now parameterized for security
    if (this.limitValue !== undefined) {
      const limitParam = this.addParam(this.limitValue)

      query += ` LIMIT ${limitParam}`
    }

    if (this.offsetValue !== undefined) {
      const offsetParam = this.addParam(this.offsetValue)

      query += ` OFFSET ${offsetParam}`
    }

    return query
  }
}
