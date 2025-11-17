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

// ============================================================================
// Base Repository
// ============================================================================

export class Repository<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
> {
  private tableName: string
  private schema: T
  private definition: EntityDefinition<T, TTraits>
  private txContext?: SQL

  constructor(entityDef: EntityDefinition<T, TTraits>) {
    this.definition = entityDef
    this.tableName = entityDef.tableName
    this.schema = entityDef.schema
  }

  // ========================================================================
  // Core CRUD Operations
  // ========================================================================

  async find(id: number): Promise<InferEntity<T, TTraits> | null> {
    const db = this.getDB()

    try {
      const [result] = await db`
        SELECT * FROM ${db(this.tableName)}
        WHERE id = ${id}
        LIMIT 1
      `

      return result ? this.mapRowToEntity(result) : null
    }
    catch (error) {
      this.handleError(error, 'find')

      return null
    }
  }

  async findAll(): Promise<InferEntity<T, TTraits>[]> {
    const db = this.getDB()
    const results = await db`SELECT * FROM ${db(this.tableName)}`

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async create(data: InferCreateData<T>): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeCreate) {
      await hook(data)
    }

    try {
      const preparedData = this.prepareData(data as Record<string, unknown>)
      const [result] = await db`
        INSERT INTO ${db(this.tableName)} ${db(preparedData)}
        RETURNING *
      `

      const entity = this.mapRowToEntity(result)

      // Execute after hooks
      for (const hook of this.definition.hooks.afterCreate) {
        await hook(entity as any)
      }

      // Inject trait methods
      this.injectTraitMethods(entity)

      return entity
    }
    catch (error) {
      this.handleError(error, 'create')
      throw error
    }
  }

  async update(id: number, data: InferUpdateData<T>): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeUpdate) {
      await hook(id, data)
    }

    try {
      const preparedData = this.prepareData(data as Record<string, unknown>)

      // Handle auto-update fields
      for (const [key, fieldConfig] of Object.entries(this.schema)) {
        if (fieldConfig.type === 'timestamp' && (fieldConfig as any).autoUpdate) {
          (preparedData as any)[key] = new Date()
        }
      }

      const [result] = await db`
        UPDATE ${db(this.tableName)}
        SET ${db(preparedData)}
        WHERE id = ${id}
        RETURNING *
      `

      if (!result) {
        throw new Error(`Entity with id ${id} not found in ${this.tableName}`)
      }

      const entity = this.mapRowToEntity(result)

      // Execute after hooks
      for (const hook of this.definition.hooks.afterUpdate) {
        await hook(entity as any)
      }

      // Inject trait methods
      this.injectTraitMethods(entity)

      return entity
    }
    catch (error) {
      this.handleError(error, 'update')
      throw error
    }
  }

  async delete(id: number): Promise<void> {
    const db = this.getDB()

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeDelete) {
      await hook(id)
    }

    try {
      await db`
        DELETE FROM ${db(this.tableName)}
        WHERE id = ${id}
      `

      // Execute after hooks
      for (const hook of this.definition.hooks.afterDelete) {
        await hook(id)
      }
    }
    catch (error) {
      this.handleError(error, 'delete')
    }
  }

  // ========================================================================
  // Query Operations
  // ========================================================================

  async findBy(options: QueryOptions<T>): Promise<InferEntity<T, TTraits>[]> {
    const query = this.buildSelectQuery(options)

    try {
      const results = await query

      return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
    }
    catch (error) {
      this.handleError(error, 'findBy')

      return []
    }
  }

  async findOneBy(options: QueryOptions<T>): Promise<InferEntity<T, TTraits> | null> {
    const results = await this.findBy({ ...options, limit: 1 })

    return results[0] || null
  }

  async count(options?: QueryOptions<T>): Promise<number> {
    const db = this.getDB()

    try {
      let query = db`SELECT COUNT(*) as count FROM ${db(this.tableName)}`

      if (options?.where) {
        query = this.applyWhereConditions(query, options.where)
      }

      const [result] = await query

      return Number(result.count)
    }
    catch (error) {
      this.handleError(error, 'count')

      return 0
    }
  }

  async exists(id: number): Promise<boolean> {
    const entity = await this.find(id)

    return entity !== null
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
    const db = this.getDB()

    try {
      const preparedArray = dataArray.map(data => this.prepareData(data as Record<string, unknown>))

      const results = await db`
        INSERT INTO ${db(this.tableName)} ${db(preparedArray)}
        RETURNING *
      `

      return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
    }
    catch (error) {
      this.handleError(error, 'createMany')

      return []
    }
  }

  async deleteMany(ids: number[]): Promise<void> {
    const db = this.getDB()

    try {
      await db`
        DELETE FROM ${db(this.tableName)}
        WHERE id IN ${db(ids)}
      `
    }
    catch (error) {
      this.handleError(error, 'deleteMany')
    }
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
    const cloned = new Repository(this.definition)

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

  private mapRowToEntity(row: DatabaseRow): InferEntity<T, TTraits> {
    const entity: any = { id: row.id }

    // Map database columns (snake_case) to entity fields (camelCase)
    for (const [fieldName, fieldConfig] of Object.entries(this.schema)) {
      const columnName = this.getColumnName(fieldName)
      const value = row[columnName]

      if (value === undefined)
        continue

      // Deserialize arrays
      if (fieldConfig?.type === 'array' && value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          entity[fieldName] = value
        }
        else if (ArrayBuffer.isView(value)) {
          entity[fieldName] = Array.from(value as unknown as ArrayLike<unknown>)
        }
        else {
          entity[fieldName] = value
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

    // Inject trait methods
    this.injectTraitMethods(entity)

    return entity as InferEntity<T, TTraits>
  }

  private prepareData(data: Record<string, unknown>): Record<string, unknown> {
    const prepared: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data)) {
      const fieldConfig = this.schema[key]

      if (!fieldConfig)
        continue

      // Get the database column name (converts camelCase to snake_case)
      const columnName = this.getColumnName(key)

      // Validate enums
      if (fieldConfig.type === 'enum' && value !== null && value !== undefined) {
        const enumValues = (fieldConfig as any).values

        if (enumValues && !enumValues.includes(String(value))) {
          throw new Error(
            `Invalid enum value "${value}" for column "${key}". Allowed values: ${enumValues.join(', ')}`,
          )
        }
      }

      // Convert arrays to PostgreSQL array format
      if (fieldConfig.type === 'array' && Array.isArray(value)) {
        // Convert JavaScript array to PostgreSQL array literal format
        // e.g., ['a', 'b'] -> '{a,b}'
        const elementType = (fieldConfig as any).elementType

        if (elementType === 'string') {
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
    let query = db`SELECT * FROM ${db(this.tableName)}`

    if (options.where) {
      query = this.applyWhereConditions(query, options.where)
    }

    if (options.order) {
      const orderClauses: string[] = []

      for (const [key, direction] of Object.entries(options.order)) {
        const columnName = this.getColumnName(key)

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
      const prefix = conditionCount === 0 ? 'WHERE' : 'AND'

      // Simple equality or IN clause
      if (Array.isArray(condition)) {
        // Build IN clause manually - PostgreSQL requires proper quoting
        const quotedValues = condition.map((v) => {
          if (typeof v === 'string') {
            return `'${String(v).replace(/'/g, '\'\'')}'`
          }

          return String(v)
        }).join(', ')

        whereClause = db`${whereClause} ${db.unsafe(prefix)} ${db.unsafe(columnName)} IN (${db.unsafe(quotedValues)})`
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
            if (Array.isArray(value)) {
              // Build IN clause manually - PostgreSQL requires proper quoting
              const quotedValues = value.map((v) => {
                if (typeof v === 'string') {
                  return `'${String(v).replace(/'/g, '\'\'')}'`
                }

                return String(v)
              }).join(', ')

              whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} IN (${db.unsafe(quotedValues)})`
              conditionCount++
            }

            break
          case 'notIn':
            if (Array.isArray(value)) {
              // Build NOT IN clause manually - PostgreSQL requires proper quoting
              const quotedValues = value.map((v) => {
                if (typeof v === 'string') {
                  return `'${String(v).replace(/'/g, '\'\'')}'`
                }

                return String(v)
              }).join(', ')

              whereClause = db`${whereClause} ${db.unsafe(opPrefix)} ${db.unsafe(columnName)} NOT IN (${db.unsafe(quotedValues)})`
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

  private injectTraitMethods(entity: any): void {
    for (const trait of this.definition.traits) {
      if (trait.methods) {
        for (const [methodName, method] of Object.entries(trait.methods)) {
          // Bind method to entity and inject repository as first argument
          entity[methodName] = (...args: any[]) => {
            return (method as any).call(entity, this, ...args)
          }
        }
      }
    }
  }

  private handleError(error: unknown, operation: string): void {
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
