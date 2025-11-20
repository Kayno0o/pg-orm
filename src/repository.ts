import type { SQL } from 'bun'
import type {
  CursorPaginationResult,
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
import { getDatabase } from './db'
import { QueryBuilder } from './query'
import { QueryGenerator } from './query-generator'
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
  private entityRepositoryMap = new WeakMap<any, Repository<T, TTraits>>()
  private queryGenerator: QueryGenerator<T>

  constructor(entityDef: EntityDefinition<T, TTraits>) {
    this.definition = entityDef
    this.tableName = entityDef.tableName
    this.schema = entityDef.schema
    this.validator = new Validator()
    this.queryGenerator = new QueryGenerator(this.schema, this.getColumnName.bind(this))

    // Build entity prototype once for performance (instead of per-entity injection)
    this.entityPrototype = this.buildEntityPrototype()
  }

  // ========================================================================
  // Core CRUD Operations
  // ========================================================================

  async find(id: number): Promise<InferEntity<T, TTraits> | null> {
    const db = this.getDB()

    const selectColumns = this.queryGenerator.buildSelectColumns()
    const [result] = await db`
      SELECT ${db.unsafe(selectColumns)} FROM ${db(this.tableName)}
      WHERE id = ${id}
      LIMIT 1
    `

    return result ? this.mapRowToEntity(result) : null
  }

  async findAll(): Promise<InferEntity<T, TTraits>[]> {
    const db = this.getDB()
    const selectColumns = this.queryGenerator.buildSelectColumns()
    const results = await db`SELECT ${db.unsafe(selectColumns)} FROM ${db(this.tableName)}`

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async create(data: InferCreateData<T>): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    // Validate input data
    this.validator.validate(data as Record<string, unknown>, this.schema, 'create', this.tableName)

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeCreate) {
      await hook(data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)
    const selectColumns = this.queryGenerator.buildSelectColumns()
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
    this.validator.validate(data as Record<string, unknown>, this.schema, 'update', this.tableName)

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

    const selectColumns = this.queryGenerator.buildSelectColumns()
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

    const [result] = await db`
      DELETE FROM ${db(this.tableName)}
      WHERE id = ${id}
      RETURNING id
    `

    if (!result) {
      throw new Error(`Entity with id ${id} not found in ${this.tableName}`)
    }

    // Execute after hooks
    for (const hook of this.definition.hooks.afterDelete) {
      await hook(id)
    }
  }

  // ========================================================================
  // Query Operations
  // ========================================================================

  async findBy(options: QueryOptions<T>): Promise<InferEntity<T, TTraits>[]> {
    const db = this.getDB()
    const query = this.queryGenerator.buildSelectQuery(this.tableName, options, db)
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
      query = this.queryGenerator.applyWhereConditions(query, options.where, db)
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

  async paginateCursor(options: {
    after?: number
    pageSize: number
    where?: QueryOptions<T>['where']
    order?: QueryOptions<T>['order']
  }): Promise<CursorPaginationResult<InferEntity<T, TTraits>>> {
    const { after, pageSize, where, order } = options

    // Build WHERE clause with cursor condition
    const whereWithCursor = after
      ? { ...where, id: { ...((where as any)?.id || {}), gt: after } as any }
      : where

    // Fetch pageSize + 1 to check if more results exist
    const data = await this.findBy({
      where: whereWithCursor,
      order: order || ({ id: 'ASC' } as any),
      limit: pageSize + 1,
    })

    // Check if more results exist
    const hasMore = data.length > pageSize

    // Return only the requested pageSize
    const results = hasMore ? data.slice(0, pageSize) : data

    // Next cursor is the ID of the last item
    const lastItem = results[results.length - 1]
    const nextCursor = hasMore && lastItem ? (lastItem.id as number) : undefined

    return {
      data: results,
      nextCursor,
      hasMore,
      pageSize,
    }
  }

  // ========================================================================
  // Bulk Operations
  // ========================================================================

  async createMany(dataArray: InferCreateData<T>[]): Promise<InferEntity<T, TTraits>[]> {
    if (dataArray.length === 0)
      return []

    const db = this.getDB()

    // Step 1: Validate all items first
    for (const data of dataArray) {
      this.validator.validate(data as Record<string, unknown>, this.schema, 'create', this.tableName)
    }

    // Step 2: Execute beforeCreate hooks for each item (allows mutation)
    for (const data of dataArray) {
      for (const hook of this.definition.hooks.beforeCreate) {
        await hook(data)
      }
    }

    // Step 3: Prepare all data for insertion
    const preparedDataArray = dataArray.map(data => this.prepareData(data as Record<string, unknown>))

    // Step 4: Single bulk INSERT for performance
    const selectColumns = this.queryGenerator.buildSelectColumns()
    const results = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedDataArray)}
      RETURNING ${db.unsafe(selectColumns)}
    `

    // Step 5: Map database rows to entities
    const entities = results.map((row: DatabaseRow) => this.mapRowToEntity(row))

    // Step 6: Execute afterCreate hooks for each created entity
    for (const entity of entities) {
      for (const hook of this.definition.hooks.afterCreate) {
        await hook(entity as any)
      }
    }

    return entities
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
    return new QueryBuilder<T>(
      this.tableName,
      this.getDB(),
      this.schema,
      (row: DatabaseRow) => this.mapRowToEntity(row),
    )
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

  private buildEntityPrototype(): any {
    const prototype: any = {}
    const entityRepositoryMap = this.entityRepositoryMap

    // Inject trait methods into prototype (performance optimization)
    for (const trait of this.definition.traits) {
      if (trait.methods) {
        for (const [methodName, method] of Object.entries(trait.methods)) {
          prototype[methodName] = function (this: any, ...args: any[]) {
            // 'this' is bound to entity instance
            // Retrieve repository from WeakMap instead of direct property
            const repo = entityRepositoryMap.get(this)

            if (!repo) {
              throw new Error(`Repository not found for entity. This should never happen.`)
            }

            return (method as any).call(this, repo, ...args)
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
    // Store repository reference in WeakMap to avoid memory leaks
    this.entityRepositoryMap.set(entity, this)

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

    // Parse array elements handling quoted strings properly
    const elements: string[] = []
    let current = ''
    let inQuotes = false
    let i = 0

    while (i < content.length) {
      const char = content[i]

      if (char === '"' && (i === 0 || content[i - 1] !== '\\')) {
        // Toggle quote state (not escaped quote)
        inQuotes = !inQuotes
        i++

        continue
      }

      if (char === ',' && !inQuotes) {
        // Element separator outside quotes
        elements.push(current)
        current = ''
        i++

        continue
      }

      if (char === '\\' && inQuotes && i + 1 < content.length) {
        // Handle escape sequences in quoted strings
        const nextChar = content[i + 1]

        if (nextChar === '"' || nextChar === '\\') {
          // Escaped quote or backslash
          current += nextChar
          i += 2

          continue
        }
      }

      current += char
      i++
    }

    // Add last element
    if (current || content[content.length - 1] === ',') {
      elements.push(current)
    }

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
        const arrayType = (fieldConfig as any).arrayType

        if (arrayType === 'string') {
          // For strings, properly escape and quote when necessary
          const formatted = value.map((v) => {
            const str = String(v)

            // Check if string needs quoting (contains special characters)
            const needsQuoting = (/[",\\{}\s]/).test(str) || str === ''

            if (needsQuoting) {
              // Escape backslashes and quotes, then wrap in quotes
              const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

              return `"${escaped}"`
            }

            return str
          })

          prepared[columnName] = `{${formatted.join(',')}}`
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
}

// Export ValidationError for user error handling
export { ValidationError }
