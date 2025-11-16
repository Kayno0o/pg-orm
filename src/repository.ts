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
import { SQL as BunSQL } from 'bun'
import { getDatabase } from './db'
import { QueryBuilder } from './query'

// ============================================================================
// Base Repository
// ============================================================================

export class Repository<T extends EntitySchema> {
  private tableName: string
  private schema: T
  private definition: EntityDefinition<T>
  private txContext?: SQL

  constructor(entityDef: EntityDefinition<T>) {
    this.definition = entityDef
    this.tableName = entityDef.tableName
    this.schema = entityDef.schema
  }

  // ========================================================================
  // Core CRUD Operations
  // ========================================================================

  async find(id: number): Promise<InferEntity<T> | null> {
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

  async findAll(): Promise<InferEntity<T>[]> {
    const db = this.getDB()
    const results = await db`SELECT * FROM ${db(this.tableName)}`

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async create(data: InferCreateData<T>): Promise<InferEntity<T>> {
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
        await hook(entity)
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

  async update(id: number, data: InferUpdateData<T>): Promise<InferEntity<T>> {
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
        await hook(entity)
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

  async findBy(options: QueryOptions<T>): Promise<InferEntity<T>[]> {
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

  async findOneBy(options: QueryOptions<T>): Promise<InferEntity<T> | null> {
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
  }): Promise<PaginationResult<InferEntity<T>>> {
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

  async createMany(dataArray: InferCreateData<T>[]): Promise<InferEntity<T>[]> {
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

  withTransaction(tx: SQL): Repository<T> {
    const cloned = new Repository(this.definition)

    cloned.txContext = tx

    return cloned
  }

  async transaction<R>(callback: (repo: Repository<T>) => Promise<R>): Promise<R> {
    const db = this.getDB()

    return await db.begin(async (tx) => {
      const txRepo = this.withTransaction(tx)

      return await callback(txRepo)
    })
  }

  // ========================================================================
  // Extension API
  // ========================================================================

  extend<Methods extends Record<string, (this: Repository<T>, ...args: any[]) => any>>(
    methods: Methods,
  ): Repository<T> & Methods {
    const extended = Object.create(this)

    for (const [name, method] of Object.entries(methods)) {
      extended[name] = method.bind(extended)
    }

    return extended as Repository<T> & Methods
  }

  // ========================================================================
  // Internal Helpers
  // ========================================================================

  private getDB(): SQL {
    return this.txContext || getDatabase()
  }

  private mapRowToEntity(row: DatabaseRow): InferEntity<T> {
    const entity: any = { id: row.id }

    for (const [key, value] of Object.entries(row)) {
      if (key === 'id')
        continue

      const fieldConfig = this.schema[key]

      // Deserialize arrays
      if (fieldConfig?.type === 'array' && value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          entity[key] = value
        }
        else if (ArrayBuffer.isView(value)) {
          entity[key] = Array.from(value as unknown as ArrayLike<unknown>)
        }
        else {
          entity[key] = value
        }
      }
      // Deserialize timestamps/dates
      else if (
        (fieldConfig?.type === 'timestamp' || fieldConfig?.type === 'date')
        && value !== null
        && value !== undefined
      ) {
        entity[key] = value instanceof Date ? value : new Date(value as string)
      }
      // Default
      else {
        entity[key] = value
      }
    }

    // Inject trait methods
    this.injectTraitMethods(entity)

    return entity as InferEntity<T>
  }

  private prepareData(data: Record<string, unknown>): Record<string, unknown> {
    const prepared: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data)) {
      const fieldConfig = this.schema[key]

      if (!fieldConfig)
        continue

      // Validate enums
      if (fieldConfig.type === 'enum' && value !== null && value !== undefined) {
        const enumValues = (fieldConfig as any).values

        if (enumValues && !enumValues.includes(String(value))) {
          throw new Error(
            `Invalid enum value "${value}" for column "${key}". Allowed values: ${enumValues.join(', ')}`,
          )
        }
      }

      prepared[key] = value
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
        orderClauses.push(`${key} ${direction}`)
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
    const conditions: string[] = []

    if (!where)
      return query

    for (const [key, condition] of Object.entries(where)) {
      if (condition === null || condition === undefined)
        continue

      // Simple equality or IN clause
      if (Array.isArray(condition)) {
        conditions.push(`${key} = ANY(${db(condition)})`)
      }
      // Operator object
      else if (typeof condition === 'object' && !Array.isArray(condition)) {
        for (const [op, value] of Object.entries(condition)) {
          if (value === undefined)
            continue

          switch (op) {
          case 'eq':
            conditions.push(`${key} = ${db(value)}`)

            break
          case 'ne':
            conditions.push(`${key} != ${db(value)}`)

            break
          case 'gt':
            conditions.push(`${key} > ${db(value)}`)

            break
          case 'gte':
            conditions.push(`${key} >= ${db(value)}`)

            break
          case 'lt':
            conditions.push(`${key} < ${db(value)}`)

            break
          case 'lte':
            conditions.push(`${key} <= ${db(value)}`)

            break
          case 'in':
            if (Array.isArray(value)) {
              conditions.push(`${key} = ANY(${db(value)})`)
            }

            break
          case 'notIn':
            if (Array.isArray(value)) {
              conditions.push(`${key} != ALL(${db(value)})`)
            }

            break
          case 'like':
            conditions.push(`${key} LIKE ${db(value)}`)

            break
          case 'ilike':
            conditions.push(`${key} ILIKE ${db(value)}`)

            break
          }
        }
      }
      // Simple value
      else {
        conditions.push(`${key} = ${db(condition)}`)
      }
    }

    if (conditions.length > 0) {
      query = db`${query} WHERE ${db.unsafe(conditions.join(' AND '))}`
    }

    return query
  }

  private injectTraitMethods(entity: any): void {
    for (const trait of this.definition.traits) {
      if (trait.methods) {
        for (const [methodName, method] of Object.entries(trait.methods)) {
          entity[methodName] = method.bind(entity)
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
