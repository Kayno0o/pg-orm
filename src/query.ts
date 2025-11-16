import type { SQL } from 'bun'
import type { EntitySchema, InferEntity, OrderDirection } from './types'

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

  // ========================================================================
  // Select
  // ========================================================================

  select(...fields: (keyof T | 'id')[]): this {
    this.selectFields = fields.map(String)

    return this
  }

  // ========================================================================
  // Where Clauses
  // ========================================================================

  where(field: keyof T | 'id', operator: string, value: any): this {
    this.whereConditions.push(`${String(field)} ${operator} ${this.db(value)}`)

    return this
  }

  whereEquals(field: keyof T | 'id', value: any): this {
    return this.where(field, '=', value)
  }

  whereIn(field: keyof T | 'id', values: any[]): this {
    this.whereConditions.push(`${String(field)} = ANY(${this.db(values)})`)

    return this
  }

  whereNotIn(field: keyof T | 'id', values: any[]): this {
    this.whereConditions.push(`${String(field)} != ALL(${this.db(values)})`)

    return this
  }

  whereLike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'LIKE', pattern)
  }

  whereILike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'ILIKE', pattern)
  }

  whereNull(field: keyof T | 'id'): this {
    this.whereConditions.push(`${String(field)} IS NULL`)

    return this
  }

  whereNotNull(field: keyof T | 'id'): this {
    this.whereConditions.push(`${String(field)} IS NOT NULL`)

    return this
  }

  whereBetween(field: keyof T | 'id', min: any, max: any): this {
    this.whereConditions.push(`${String(field)} BETWEEN ${this.db(min)} AND ${this.db(max)}`)

    return this
  }

  // PostgreSQL-specific operators
  whereJsonContains(field: keyof T, value: any): this {
    this.whereConditions.push(`${String(field)} @> ${this.db(JSON.stringify(value))}::jsonb`)

    return this
  }

  whereJsonHasKey(field: keyof T, key: string): this {
    this.whereConditions.push(`${String(field)} ? ${this.db(key)}`)

    return this
  }

  whereArrayContains(field: keyof T, value: any): this {
    this.whereConditions.push(`${String(field)} @> ${this.db([value])}`)

    return this
  }

  whereArrayOverlaps(field: keyof T, values: any[]): this {
    this.whereConditions.push(`${String(field)} && ${this.db(values)}`)

    return this
  }

  // ========================================================================
  // Order By
  // ========================================================================

  orderBy(field: keyof T | 'id', direction: OrderDirection = 'ASC'): this {
    this.orderByFields.push({ field: String(field), direction })

    return this
  }

  orderByDesc(field: keyof T | 'id'): this {
    return this.orderBy(field, 'DESC')
  }

  // ========================================================================
  // Group By
  // ========================================================================

  groupBy(...fields: (keyof T | 'id')[]): this {
    this.groupByFields = fields.map(String)

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
