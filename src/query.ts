import type { SQL } from 'bun'
import type { EntitySchema, InferEntity, OrderDirection } from './types'
import { toSnake } from '@kaynooo/utils'

// ============================================================================
// Query Builder
// ============================================================================

export class QueryBuilder<T extends EntitySchema> {
  private selectFields: string[] = ['*']
  private whereConditions: string[] = []
  private orderByFields: { field: string, direction: OrderDirection }[] = []
  private limitValue?: number
  private offsetValue?: number
  private groupByFields: string[] = []

  constructor(
    private tableName: string,
    private db: SQL,
    private schema: T,
  ) {}

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

  // ========================================================================
  // Select
  // ========================================================================

  select(...fields: (keyof T | 'id')[]): this {
    this.selectFields = fields.map(f => this.getColumnName(String(f)))

    return this
  }

  // ========================================================================
  // Where Clauses
  // ========================================================================

  where(field: keyof T | 'id', operator: string, value: any): this {
    const columnName = this.getColumnName(String(field))
    // Use proper SQL escaping for values
    const escapedValue = typeof value === 'string' ? `'${String(value).replace(/'/g, "''")}'` : String(value)
    this.whereConditions.push(`${columnName} ${operator} ${escapedValue}`)

    return this
  }

  whereEquals(field: keyof T | 'id', value: any): this {
    return this.where(field, '=', value)
  }

  whereIn(field: keyof T | 'id', values: any[]): this {
    const columnName = this.getColumnName(String(field))
    // Build IN clause manually - PostgreSQL requires proper quoting
    const quotedValues = values.map(v => {
      if (typeof v === 'string') {
        return `'${String(v).replace(/'/g, "''")}'`
      }
      return String(v)
    }).join(', ')
    this.whereConditions.push(`${columnName} IN (${quotedValues})`)

    return this
  }

  whereNotIn(field: keyof T | 'id', values: any[]): this {
    const columnName = this.getColumnName(String(field))
    // Build NOT IN clause manually - PostgreSQL requires proper quoting
    const quotedValues = values.map(v => {
      if (typeof v === 'string') {
        return `'${String(v).replace(/'/g, "''")}'`
      }
      return String(v)
    }).join(', ')
    this.whereConditions.push(`${columnName} NOT IN (${quotedValues})`)

    return this
  }

  whereLike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'LIKE', pattern)
  }

  whereILike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'ILIKE', pattern)
  }

  whereNull(field: keyof T | 'id'): this {
    const columnName = this.getColumnName(String(field))
    this.whereConditions.push(`${columnName} IS NULL`)

    return this
  }

  whereNotNull(field: keyof T | 'id'): this {
    const columnName = this.getColumnName(String(field))
    this.whereConditions.push(`${columnName} IS NOT NULL`)

    return this
  }

  whereBetween(field: keyof T | 'id', min: any, max: any): this {
    const columnName = this.getColumnName(String(field))
    const escapedMin = typeof min === 'string' ? `'${String(min).replace(/'/g, "''")}'` : String(min)
    const escapedMax = typeof max === 'string' ? `'${String(max).replace(/'/g, "''")}'` : String(max)
    this.whereConditions.push(`${columnName} BETWEEN ${escapedMin} AND ${escapedMax}`)

    return this
  }

  // PostgreSQL-specific operators
  whereJsonContains(field: keyof T, value: any): this {
    const columnName = this.getColumnName(String(field))
    const jsonStr = JSON.stringify(value).replace(/'/g, "''")
    this.whereConditions.push(`${columnName} @> '${jsonStr}'::jsonb`)

    return this
  }

  whereJsonHasKey(field: keyof T, key: string): this {
    const columnName = this.getColumnName(String(field))
    this.whereConditions.push(`${columnName} ? '${key.replace(/'/g, "''")}'`)

    return this
  }

  whereArrayContains(field: keyof T, value: any): this {
    const columnName = this.getColumnName(String(field))
    // Format single value as array: value -> '{value}'
    const escapedValue = typeof value === 'string' ? value.replace(/'/g, "''") : String(value)
    this.whereConditions.push(`${columnName} @> '{${escapedValue}}'`)

    return this
  }

  whereArrayOverlaps(field: keyof T, values: any[]): this {
    const columnName = this.getColumnName(String(field))
    // Format array for PostgreSQL: ['a', 'b'] -> '{a,b}'
    const escaped = values.map(v => typeof v === 'string' ? String(v).replace(/'/g, "''") : String(v))
    this.whereConditions.push(`${columnName} && '{${escaped.join(',')}}'`)

    return this
  }

  // ========================================================================
  // Order By
  // ========================================================================

  orderBy(field: keyof T | 'id', direction: OrderDirection = 'ASC'): this {
    const columnName = this.getColumnName(String(field))
    this.orderByFields.push({ field: columnName, direction })

    return this
  }

  orderByDesc(field: keyof T | 'id'): this {
    return this.orderBy(field, 'DESC')
  }

  // ========================================================================
  // Group By
  // ========================================================================

  groupBy(...fields: (keyof T | 'id')[]): this {
    this.groupByFields = fields.map(f => this.getColumnName(String(f)))

    return this
  }

  // ========================================================================
  // Limit/Offset
  // ========================================================================

  limit(value: number): this {
    this.limitValue = value

    return this
  }

  offset(value: number): this {
    this.offsetValue = value

    return this
  }

  // ========================================================================
  // Execution
  // ========================================================================

  async execute(): Promise<InferEntity<T>[]> {
    const query = this.build()
    const results = await query

    return results as InferEntity<T>[]
  }

  async findOne(): Promise<InferEntity<T> | null> {
    this.limit(1)
    const results = await this.execute()

    return results[0] || null
  }

  async count(): Promise<number> {
    let query = this.db`SELECT COUNT(*) as count FROM ${this.db(this.tableName)}`

    if (this.whereConditions.length > 0) {
      query = this.db`${query} WHERE ${this.db.unsafe(this.whereConditions.join(' AND '))}`
    }

    const [result] = await query

    return Number(result.count)
  }

  async latest(field: keyof T | 'id' = 'id'): Promise<InferEntity<T> | null> {
    return this.orderByDesc(field).findOne()
  }

  async oldest(field: keyof T | 'id' = 'id'): Promise<InferEntity<T> | null> {
    return this.orderBy(field, 'ASC').findOne()
  }

  async random(limitValue = 1): Promise<InferEntity<T>[]> {
    let query = this.db`SELECT ${this.db.unsafe(this.selectFields.join(', '))} FROM ${this.db(this.tableName)}`

    if (this.whereConditions.length > 0) {
      query = this.db`${query} WHERE ${this.db.unsafe(this.whereConditions.join(' AND '))}`
    }

    query = this.db`${query} ORDER BY RANDOM() LIMIT ${limitValue}`

    const results = await query

    return results as InferEntity<T>[]
  }

  // ========================================================================
  // Build Query
  // ========================================================================

  build(): any {
    let query = this.db`SELECT ${this.db.unsafe(this.selectFields.join(', '))} FROM ${this.db(this.tableName)}`

    if (this.whereConditions.length > 0) {
      query = this.db`${query} WHERE ${this.db.unsafe(this.whereConditions.join(' AND '))}`
    }

    if (this.groupByFields.length > 0) {
      query = this.db`${query} GROUP BY ${this.db.unsafe(this.groupByFields.join(', '))}`
    }

    if (this.orderByFields.length > 0) {
      const orderClauses = this.orderByFields.map(o => `${o.field} ${o.direction}`).join(', ')

      query = this.db`${query} ORDER BY ${this.db.unsafe(orderClauses)}`
    }

    if (this.limitValue !== undefined) {
      query = this.db`${query} LIMIT ${this.limitValue}`
    }

    if (this.offsetValue !== undefined) {
      query = this.db`${query} OFFSET ${this.offsetValue}`
    }

    return query
  }
}
