import type { SQL } from 'bun'
import type { SQLFragment } from './types/sql'
import { getDB } from './db'

export class QueryBuilder<T = unknown> {
  private selectFields: string[] = ['*']
  private fromTable: string
  private fromAlias: string
  private joins: string[] = []
  private whereFragments: SQLFragment[] = []
  private groupByFields: string[] = []
  private havingFragments: SQLFragment[] = []
  private orderByFields: string[] = []
  private limitValue?: number
  private offsetValue?: number
  private db: SQL

  constructor(table: string, alias?: string) {
    this.fromTable = table
    this.fromAlias = alias || table
    this.db = getDB()
  }

  /** Prevents SQL injection */
  private validateIdentifier(identifier: string): void {
    if (!(/^[\w.*]+$/).test(identifier)) {
      throw new Error(
        `Invalid identifier "${identifier}". Only alphanumeric characters, underscores, dots, and asterisks are allowed.`,
      )
    }
  }

  select(...fields: string[]): this {
    if (fields.length > 0) {
      this.selectFields = fields
    }

    return this
  }

  join(table: string, alias: string, condition: string): this {
    this.joins.push(`INNER JOIN ${table} ${alias} ON ${condition}`)

    return this
  }

  leftJoin(table: string, alias: string, condition: string): this {
    this.joins.push(`LEFT JOIN ${table} ${alias} ON ${condition}`)

    return this
  }

  /** @example qb.where(db`age > ${18}`) */
  where(fragment: SQLFragment): this {
    this.whereFragments.push(fragment)

    return this
  }

  /** @example qb.whereEquals('name', 'John') */
  whereEquals(field: string, value: unknown): this {
    this.whereFragments.push(this.db`${this.db(field)} = ${value}`)

    return this
  }

  groupBy(...fields: string[]): this {
    for (const field of fields) {
      this.validateIdentifier(field)
    }
    this.groupByFields.push(...fields)

    return this
  }

  /** Requires GROUP BY; @example qb.groupBy('status').having(db`COUNT(*) > ${10}`) */
  having(fragment: SQLFragment): this {
    this.havingFragments.push(fragment)

    return this
  }

  order(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.validateIdentifier(field)
    this.orderByFields.push(`${field} ${direction.toUpperCase()}`)

    return this
  }

  limit(n: number): this {
    this.limitValue = n

    return this
  }

  offset(n: number): this {
    this.offsetValue = n

    return this
  }

  private buildQuery(): SQLFragment {
    const db = this.db
    const selectClause = this.selectFields.join(', ')
    let query: SQLFragment = db`SELECT ${db.unsafe(selectClause)} FROM ${db(this.fromTable)}`

    if (this.fromAlias !== this.fromTable) {
      query = db`${query} ${db.unsafe(this.fromAlias)}`
    }

    if (this.joins.length > 0) {
      query = db`${query} ${db.unsafe(this.joins.join(' '))}`
    }

    if (this.whereFragments.length > 0) {
      let whereClause: SQLFragment = this.whereFragments[0]!

      for (let i = 1; i < this.whereFragments.length; i++) {
        whereClause = db`${whereClause} AND ${this.whereFragments[i]!}`
      }
      query = db`${query} WHERE ${whereClause}`
    }

    if (this.groupByFields.length > 0) {
      query = db`${query} GROUP BY ${db.unsafe(this.groupByFields.join(', '))}`
    }

    if (this.havingFragments.length > 0) {
      let havingClause: SQLFragment = this.havingFragments[0]!

      for (let i = 1; i < this.havingFragments.length; i++) {
        havingClause = db`${havingClause} AND ${this.havingFragments[i]!}`
      }
      query = db`${query} HAVING ${havingClause}`
    }

    if (this.orderByFields.length > 0) {
      query = db`${query} ORDER BY ${db.unsafe(this.orderByFields.join(', '))}`
    }

    if (this.limitValue !== undefined) {
      query = db`${query} LIMIT ${this.limitValue}`
    }

    if (this.offsetValue !== undefined) {
      query = db`${query} OFFSET ${this.offsetValue}`
    }

    return query
  }

  async findAll(): Promise<T[]> {
    const query = this.buildQuery()

    return await (query as Promise<T[]>)
  }

  async findOne(): Promise<T | null> {
    const originalLimit = this.limitValue

    try {
      this.limitValue = 1
      const query = this.buildQuery()
      const results = await (query as Promise<T[]>)

      return results[0] || null
    }
    finally {
      this.limitValue = originalLimit
    }
  }

  async count(): Promise<number> {
    const originalSelect = this.selectFields

    try {
      this.selectFields = ['COUNT(*)::int as count']
      const query = this.buildQuery()
      const results = await (query as Promise<{ count: number }[]>)

      return results[0]?.count || 0
    }
    finally {
      this.selectFields = originalSelect
    }
  }

  whereIn(field: string, values: unknown[]): this {
    this.whereFragments.push(this.db`${this.db(field)} IN ${this.db(values)}`)

    return this
  }

  whereNotIn(field: string, values: unknown[]): this {
    this.whereFragments.push(this.db`${this.db(field)} NOT IN ${this.db(values)}`)

    return this
  }

  whereBetween(field: string, min: unknown, max: unknown): this {
    this.whereFragments.push(this.db`${this.db(field)} BETWEEN ${min} AND ${max}`)

    return this
  }

  whereNull(field: string): this {
    this.whereFragments.push(this.db`${this.db(field)} IS NULL`)

    return this
  }

  whereNotNull(field: string): this {
    this.whereFragments.push(this.db`${this.db(field)} IS NOT NULL`)

    return this
  }

  whereLike(field: string, pattern: string): this {
    this.whereFragments.push(this.db`${this.db(field)} LIKE ${pattern}`)

    return this
  }

  /** Case-insensitive LIKE */
  whereILike(field: string, pattern: string): this {
    this.whereFragments.push(this.db`${this.db(field)} ILIKE ${pattern}`)

    return this
  }

  /** JSONB contains */
  whereJsonContains(field: string, value: unknown): this {
    const jsonValue = JSON.stringify(value)

    this.whereFragments.push(this.db`${this.db(field)} @> ${jsonValue}::jsonb`)

    return this
  }

  /** JSONB has key */
  whereJsonHasKey(field: string, key: string): this {
    this.whereFragments.push(this.db`${this.db(field)} ? ${key}`)

    return this
  }

  /** Array contains value */
  whereArrayContains(field: string, value: unknown): this {
    this.whereFragments.push(this.db`${this.db(field)} @> ${(this.db as any).array([value])}`)

    return this
  }

  /** Array overlaps */
  whereArrayOverlaps(field: string, values: unknown[]): this {
    this.whereFragments.push(this.db`${this.db(field)} && ${(this.db as any).array(values)}`)

    return this
  }

  /** Full-text search */
  whereFullText(field: string, query: string, language = 'english'): this {
    this.whereFragments.push(
      this.db`to_tsvector(${this.db.unsafe(`'${language}'`)}, ${this.db(field)}) @@ plainto_tsquery(${this.db.unsafe(`'${language}'`)}, ${query})`,
    )

    return this
  }

  orderByDesc(field: string): this {
    return this.order(field, 'desc')
  }

  async latest(field = 'created_at'): Promise<T | null> {
    this.orderByFields = [`${field} DESC`]
    this.limitValue = 1
    const results = await this.findAll()

    return results[0] || null
  }

  async oldest(field = 'created_at'): Promise<T | null> {
    this.orderByFields = [`${field} ASC`]
    this.limitValue = 1
    const results = await this.findAll()

    return results[0] || null
  }

  random(limit?: number): this {
    this.orderByFields.push('RANDOM()')

    if (limit !== undefined) {
      this.limitValue = limit
    }

    return this
  }

  /** For inspection or manual execution */
  build(): SQLFragment {
    return this.buildQuery()
  }
}

export function queryBuilder<T>(
  table: string,
  alias?: string,
): QueryBuilder<T> {
  return new QueryBuilder<T>(table, alias)
}
