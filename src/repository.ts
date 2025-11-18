import type { SQL } from 'bun'
import type {
  DatabaseRow,
  EntityDefinition,
  EntitySchema,
  InferCreateData,
  InferEntity,
  InferUpdateData,
  PaginationResult,
  QueryOptions,
} from './types'
import { toSnake } from '@kaynooo/utils'
import { SQL as BunSQL } from 'bun'
import { getDatabase } from './db'
import { QueryBuilder } from './query'
import { ValidationError, Validator } from './validation'

// ============================================================================
// Base Repository (Secure & Optimized)
// ============================================================================

export class Repository<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
> {
  private tableName: string
  private schema: T
  private definition: EntityDefinition<T, TTraits>
  private txContext?: SQL
  private validator: Validator
  private entityPrototype: any
  private validColumnNames: Set<string>

  constructor(entityDef: EntityDefinition<T, TTraits>) {
    this.definition = entityDef
    this.tableName = entityDef.tableName
    this.schema = entityDef.schema
    this.validator = new Validator()

    // Build entity prototype once for performance (instead of per-entity injection)
    this.entityPrototype = this.buildEntityPrototype()

    // Cache valid column names for security validation
    this.validColumnNames = new Set(['id', ...Object.keys(this.schema).map(k => this.getColumnName(k))])
  }

  // ========================================================================
  // Core CRUD Operations
  // ========================================================================

  async find(id: number): Promise<InferEntity<T, TTraits> | null> {
    const db = this.getDB()

    const selectColumns = this.buildSelectColumns()
    const [result] = await db`
      SELECT ${db.unsafe(selectColumns)} FROM ${db(this.tableName)}
      WHERE id = ${id}
      LIMIT 1
    `

    return result ? this.mapRowToEntity(result) : null
  }

  async findAll(): Promise<InferEntity<T, TTraits>[]> {
    const db = this.getDB()
    const selectColumns = this.buildSelectColumns()
    const results = await db`SELECT ${db.unsafe(selectColumns)} FROM ${db(this.tableName)}`

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async create(data: InferCreateData<T>): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    // Validate input data
    this.validator.validate(data as Record<string, unknown>, this.schema, 'create')

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeCreate) {
      await hook(data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)
    const selectColumns = this.buildSelectColumns()
    const [result] = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedData)}
      RETURNING ${db.unsafe(selectColumns)}
    `

    const entity = this.mapRowToEntity(result)

    // Execute after hooks
    for (const hook of this.definition.hooks.afterCreate) {
      await hook(entity as any)
    }

    return entity
  }

  async update(id: number, data: InferUpdateData<T>): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    // Validate input data
    this.validator.validate(data as Record<string, unknown>, this.schema, 'update')

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeUpdate) {
      await hook(id, data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)

    // Handle auto-update fields
    for (const [key, fieldConfig] of Object.entries(this.schema)) {
      if (fieldConfig.type === 'timestamp' && (fieldConfig as any).autoUpdate) {
        (preparedData as any)[this.getColumnName(key)] = new Date()
      }
    }

    const selectColumns = this.buildSelectColumns()
    const [result] = await db`
      UPDATE ${db(this.tableName)}
      SET ${db(preparedData)}
      WHERE id = ${id}
      RETURNING ${db.unsafe(selectColumns)}
    `

    if (!result) {
      throw new Error(`Entity with id ${id} not found in ${this.tableName}`)
    }

    const entity = this.mapRowToEntity(result)

    // Execute after hooks
    for (const hook of this.definition.hooks.afterUpdate) {
      await hook(entity as any)
    }

    return entity
  }

  async delete(id: number): Promise<void> {
    const db = this.getDB()

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeDelete) {
      await hook(id)
    }

    await db`
      DELETE FROM ${db(this.tableName)}
      WHERE id = ${id}
    `

    // Execute after hooks
    for (const hook of this.definition.hooks.afterDelete) {
      await hook(id)
    }
  }

  // ========================================================================
  // Query Operations
  // ========================================================================

  async findBy(options: QueryOptions<T>): Promise<InferEntity<T, TTraits>[]> {
    const query = this.buildSelectQuery(options)
    const results = await query

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async findOneBy(options: QueryOptions<T>): Promise<InferEntity<T, TTraits> | null> {
    const results = await this.findBy({ ...options, limit: 1 })

    return results[0] || null
  }

  async count(options?: QueryOptions<T>, exact = true): Promise<number> {
    const db = this.getDB()

    // Fast estimation for large tables without WHERE clause
    if (!exact && !options?.where) {
      try {
        const [result] = await db`
          SELECT reltuples::bigint AS estimate
          FROM pg_class
          WHERE relname = ${this.tableName}
        `

        return Number(result.estimate)
      }
      catch {
        // Fall back to exact count if estimation fails
      }
    }

    // Exact count
    let query = db`SELECT COUNT(id) as count FROM ${db(this.tableName)}`

    if (options?.where) {
      query = this.applyWhereConditions(query, options.where)
    }

    const [result] = await query

    return Number(result.count)
  }

  async exists(id: number): Promise<boolean> {
    const db = this.getDB()
    const [result] = await db`
      SELECT 1 FROM ${db(this.tableName)}
      WHERE id = ${id}
      LIMIT 1
    `

    return result !== undefined
  }

  async paginate(options: {
    page: number
    pageSize: number
    where?: QueryOptions<T>['where']
    order?: QueryOptions<T>['order']
  }): Promise<PaginationResult<InferEntity<T, TTraits>>> {
    const { page, pageSize, where, order } = options

    const total = await this.count({ where })
    const totalPages = Math.ceil(total / pageSize)
    const offset = (page - 1) * pageSize

    const data = await this.findBy({
      where,
      order,
      limit: pageSize,
      offset,
    })

    return {
      data,
      total,
      page,
      pageSize,
      totalPages,
    }
  }

  // ========================================================================
  // Bulk Operations
  // ========================================================================

  async createMany(dataArray: InferCreateData<T>[]): Promise<InferEntity<T, TTraits>[]> {
    if (dataArray.length === 0)
      return []

    for (const data of dataArray) {
      this.validator.validate(data as Record<string, unknown>, this.schema, 'create')
    }

    const results: InferEntity<T, TTraits>[] = []

    for (const data of dataArray) {
      const result = await this.create(data)

      results.push(result)
    }

    return results
  }

  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0)
      return

    const db = this.getDB()

    await db`
      DELETE FROM ${db(this.tableName)}
      WHERE id IN ${db(ids)}
    `
  }

  // ========================================================================
  // Query Builder
  // ========================================================================

  query(): QueryBuilder<T> {
    return new QueryBuilder<T>(this.tableName, this.getDB(), this.schema)
  }

  // ========================================================================
  // Transaction Support
  // ========================================================================

  withTransaction(tx: SQL): Repository<T, TTraits> {
    const cloned = Object.create(Object.getPrototypeOf(this))

    Object.assign(cloned, this)
    cloned.txContext = tx

    return cloned
  }

  async transaction<R>(callback: (repo: Repository<T, TTraits>) => Promise<R>): Promise<R> {
    const db = this.getDB()

    return await db.begin(async (tx) => {
      const txRepo = this.withTransaction(tx)

      return await callback(txRepo)
    })
  }

  // ========================================================================
  // Extension API
  // ========================================================================

  extend<Methods extends Record<string, (this: Repository<T, TTraits>, ...args: any[]) => any>>(
    methods: Methods,
  ): Repository<T, TTraits> & Methods {
    const extended = Object.create(this)

    for (const [name, method] of Object.entries(methods)) {
      extended[name] = method.bind(extended)
    }

    return extended as Repository<T, TTraits> & Methods
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  cleanup(): void {
    this.txContext = undefined
  }

  // ========================================================================
  // Internal Helpers
  // ========================================================================

  private getDB(): SQL {
    return this.txContext || getDatabase()
  }

  private getColumnName(fieldName: string): string {
    const fieldConfig = this.schema[fieldName]

    // If explicit columnName is set, use it
    if ((fieldConfig as any)?.columnName) {
      return (fieldConfig as any).columnName
    }

    // Otherwise, convert camelCase to snake_case automatically
    return toSnake(fieldName)
  }

  private validateColumnName(columnName: string): void {
    if (!this.validColumnNames.has(columnName)) {
      throw new Error(`Invalid column name: ${columnName}`)
    }
  }

  private buildEntityPrototype(): any {
    const prototype: any = {}

    // Inject trait methods into prototype (performance optimization)
    for (const trait of this.definition.traits) {
      if (trait.methods) {
        for (const [methodName, method] of Object.entries(trait.methods)) {
          prototype[methodName] = function (this: any, ...args: any[]) {
            // 'this' is bound to entity instance
            // Pass repository as first argument to trait method
            return (method as any).call(this, this.__repo__, ...args)
          }
        }
      }
    }

    return prototype
  }

  private mapRowToEntity(row: DatabaseRow): InferEntity<T, TTraits> {
    // Use prototype for trait methods (performance optimization)
    const entity: any = Object.create(this.entityPrototype)

    entity.id = row.id
    entity.__repo__ = this // Store repository reference for trait methods

    // Map database columns (snake_case) to entity fields (camelCase)
    for (const [fieldName, fieldConfig] of Object.entries(this.schema)) {
      const columnName = this.getColumnName(fieldName)
      const value = row[columnName]

      if (value === undefined)
        continue

      // Deserialize arrays (they come as TEXT format from PostgreSQL due to casting)
      if (fieldConfig?.type === 'array' && value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          entity[fieldName] = value
        }
        else if (typeof value === 'string') {
          // Parse PostgreSQL array text format: {val1,val2,val3}
          entity[fieldName] = this.parsePostgresArray(value, (fieldConfig as any).arrayType)
        }
        else {
          entity[fieldName] = Array.from(value as any)
        }
      }
      // Deserialize timestamps/dates
      else if (
        (fieldConfig?.type === 'timestamp' || fieldConfig?.type === 'date')
        && value !== null
        && value !== undefined
      ) {
        entity[fieldName] = value instanceof Date ? value : new Date(value as string)
      }
      // Default
      else {
        entity[fieldName] = value
      }
    }

    return entity as InferEntity<T, TTraits>
  }

  private buildSelectColumns(): string {
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

  private parsePostgresArray(textValue: string, elementType: string): any[] {
    // Handle empty array
    if (textValue === '{}') {
      return []
    }

    // Remove surrounding braces
    const content = textValue.slice(1, -1)
    if (content === '') {
      return []
    }

    // Split by comma (simple parsing - doesn't handle nested arrays or escaped commas)
    const elements = content.split(',')

    // Convert based on element type
    switch (elementType) {
      case 'number':
        return elements.map(e => Number(e))
      case 'boolean':
        return elements.map(e => e === 't' || e === 'true')
      case 'string':
      default:
        return elements
    }
  }

  private prepareData(data: Record<string, unknown>): Record<string, unknown> {
    const prepared: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data)) {
      const fieldConfig = this.schema[key]

      if (!fieldConfig)
        continue

      // Get the database column name (converts camelCase to snake_case)
      const columnName = this.getColumnName(key)

      // Convert arrays to PostgreSQL array format
      if (fieldConfig.type === 'array' && Array.isArray(value)) {
        // Convert JavaScript array to PostgreSQL array literal format
        // e.g., ['a', 'b'] -> '{a,b}'
        const arrayType = (fieldConfig as any).arrayType

        if (arrayType === 'string') {
          // Escape quotes and backslashes in strings
          const escaped = value.map(v => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"'))
          prepared[columnName] = `{${escaped.join(',')}}`
        }
        else {
          // For numbers and booleans, no escaping needed
          prepared[columnName] = `{${value.join(',')}}`
        }
      }
      else {
        prepared[columnName] = value
      }
    }

    return prepared
  }

  private buildSelectQuery(options: QueryOptions<T>): any {
    const db = this.getDB()

    const selectColumns = this.buildSelectColumns()
    let query = db`SELECT ${db.unsafe(selectColumns)} FROM ${db(this.tableName)}`

    if (options.where) {
      query = this.applyWhereConditions(query, options.where)
    }

    if (options.order) {
      const orderClauses: string[] = []

      for (const [key, direction] of Object.entries(options.order)) {
        const columnName = this.getColumnName(key)

        this.validateColumnName(columnName)

        // Validate direction
        if (direction !== 'ASC' && direction !== 'DESC') {
          throw new Error(`Invalid ORDER BY direction: ${direction}`)
        }

        orderClauses.push(`${columnName} ${direction}`)
      }

      if (orderClauses.length > 0) {
        query = db`${query} ORDER BY ${db.unsafe(orderClauses.join(', '))}`
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

  private applyWhereConditions(query: any, where: QueryOptions<T>['where']): any {
    const db = this.getDB()

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

  private handleError(error: unknown, operation: string): never {
    if (error instanceof ValidationError) {
      throw error
    }

    if (error instanceof BunSQL.PostgresError) {
      throw new Error(
        `Failed to ${operation} in ${this.tableName}: ${error.message}\n`
        + `Code: ${error.code || 'unknown'}\n${
          String(error.detail ? `Detail: ${error.detail}\n` : '')
        }${String(error.hint ? `Hint: ${error.hint}` : '')}`,
      )
    }

    throw error
  }
}

// Export ValidationError for user error handling
export { ValidationError }
