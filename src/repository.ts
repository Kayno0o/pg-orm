import type { SQL } from 'bun'
import type {
  DatabaseRow,
  EntityDefinition,
  EntitySchema,
  InferCreateData,
  InferEntity,
  InferUpdateData,
} from './types'
import { toSnake } from '@kaynooo/utils'
import { getDatabase, getDatabaseConfig } from './db'
import { BulkOperationError, EntityNotFoundError } from './errors'
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

  // Performance caches
  private cachedSelectColumns: string
  private columnNameMap: Map<string, string>
  private fieldConfigs: { fieldName: string, columnName: string, config: any }[]
  private autoUpdateColumns: string[] // Pre-computed for update operations

  constructor(entityDef: EntityDefinition<T, TTraits>) {
    this.definition = entityDef
    this.tableName = entityDef.tableName
    this.schema = entityDef.schema
    this.validator = new Validator()

    // Pre-compute column name map
    this.columnNameMap = new Map()
    this.columnNameMap.set('id', 'id')
    for (const fieldName of Object.keys(this.schema)) {
      this.columnNameMap.set(fieldName, this.computeColumnName(fieldName))
    }

    // Pre-compute field configs for mapRowToEntity
    this.fieldConfigs = Object.entries(this.schema).map(([fieldName, config]) => ({
      fieldName,
      columnName: this.columnNameMap.get(fieldName)!,
      config,
    }))

    // Pre-compute auto-update columns (avoid scanning all fields on every update)
    this.autoUpdateColumns = this.fieldConfigs
      .filter(({ config }) => config.type === 'timestamp' && config.autoUpdate)
      .map(({ columnName }) => columnName)

    // Cache select columns string (inlined from QueryGenerator.buildSelectColumns)
    const columns = ['id', ...Object.keys(this.schema).map(k => this.columnNameMap.get(k)!)]

    this.cachedSelectColumns = columns
      .map((col) => {
        // Check if column is array type and add TEXT[] casting for proper deserialization
        const fieldName = [...this.columnNameMap.entries()].find(([_, v]) => v === col)?.[0]

        if (fieldName) {
          const config = this.schema[fieldName]

          if (config?.type === 'array') {
            return `${col}::TEXT[] as ${col}`
          }
        }

        return col
      })
      .join(', ')

    // Build entity prototype once for performance (instead of per-entity injection)
    this.entityPrototype = this.buildEntityPrototype()
  }

  private computeColumnName(fieldName: string): string {
    const fieldConfig = this.schema[fieldName]

    if ((fieldConfig as any)?.columnName) {
      return (fieldConfig as any).columnName
    }

    return toSnake(fieldName)
  }

  // Get configured limits with defaults
  private getLimits() {
    try {
      const config = getDatabaseConfig()

      return {
        bulkOperations: config.limits?.bulkOperations ?? 1000,
        arraySize: config.limits?.arraySize ?? 1000,
        stringLength: config.limits?.stringLength ?? 1_000_000,
        jsonSize: config.limits?.jsonSize ?? 10_000_000,
      }
    }
    catch {
      // If config not available, use defaults
      return {
        bulkOperations: 1000,
        arraySize: 1000,
        stringLength: 1_000_000,
        jsonSize: 10_000_000,
      }
    }
  }

  // Check if strict validation mode is enabled
  private isStrictMode(): boolean {
    try {
      const config = getDatabaseConfig()

      return config.validation?.strict ?? false
    }
    catch {
      return false
    }
  }

  // ========================================================================
  // Core CRUD Operations
  // ========================================================================

  async find(id: number): Promise<InferEntity<T, TTraits> | null> {
    const db = this.getDB()

    const [result] = await db`
      SELECT ${db.unsafe(this.cachedSelectColumns)} FROM ${db(this.tableName)}
      WHERE id = ${id}
      LIMIT 1
    `

    return result ? this.mapRowToEntity(result) : null
  }

  async findAll(): Promise<InferEntity<T, TTraits>[]> {
    const db = this.getDB()
    const results = await db`SELECT ${db.unsafe(this.cachedSelectColumns)} FROM ${db(this.tableName)}`

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async create(data: InferCreateData<T>, options?: { skipValidation?: boolean }): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    // Validate input data (skip if explicitly disabled for performance)
    if (!options?.skipValidation) {
      this.validator.validate(data as Record<string, unknown>, this.schema, 'create', this.tableName)
    }

    // Execute before hooks
    for (const hook of this.definition.hooks.beforeCreate) {
      await hook(data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)
    const [result] = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedData)}
      RETURNING ${db.unsafe(this.cachedSelectColumns)}
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

    // Handle auto-update fields (using pre-computed list)
    if (this.autoUpdateColumns.length > 0) {
      const now = new Date()

      for (const columnName of this.autoUpdateColumns) {
        (preparedData as any)[columnName] = now
      }
    }

    const [result] = await db`
      UPDATE ${db(this.tableName)}
      SET ${db(preparedData)}
      WHERE id = ${id}
      RETURNING ${db.unsafe(this.cachedSelectColumns)}
    `

    if (!result) {
      throw new EntityNotFoundError(this.tableName, id, {
        suggestion: `Check if entity exists using repo.exists(${id})`,
      })
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
      throw new EntityNotFoundError(this.tableName, id, {
        suggestion: `Entity may have already been deleted`,
      })
    }

    // Execute after hooks
    for (const hook of this.definition.hooks.afterDelete) {
      await hook(id)
    }
  }

  // ========================================================================
  // Query Operations
  // ========================================================================

  async count(exact = true): Promise<number> {
    const db = this.getDB()

    // Fast estimation for large tables
    if (!exact) {
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

    // Exact count - use QueryBuilder for consistency
    return await this.query().count()
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

  // ========================================================================
  // Bulk Operations
  // ========================================================================

  async createMany(dataArray: InferCreateData<T>[], options?: { skipValidation?: boolean }): Promise<InferEntity<T, TTraits>[]> {
    if (dataArray.length === 0)
      return []

    // Check bulk operation limit
    const limits = this.getLimits()

    if (dataArray.length > limits.bulkOperations) {
      throw new BulkOperationError('createMany', dataArray.length, limits.bulkOperations)
    }

    // Check strict validation mode
    if (options?.skipValidation && this.isStrictMode()) {
      throw new Error(
        'Cannot skip validation in strict mode. '
        + 'Set validation.strict to false in database config to allow skipValidation.',
      )
    }

    const db = this.getDB()

    // Step 1: Validate all items first (skip if explicitly disabled for performance)
    if (!options?.skipValidation) {
      for (const data of dataArray) {
        this.validator.validate(data as Record<string, unknown>, this.schema, 'create', this.tableName)
      }
    }

    // Step 2: Execute beforeCreate hooks (parallelized across items)
    const beforeHooks = this.definition.hooks.beforeCreate

    if (beforeHooks.length > 0) {
      await Promise.all(dataArray.map(async (data) => {
        for (const hook of beforeHooks) {
          await hook(data)
        }
      }))
    }

    // Step 3: Prepare all data for insertion
    const preparedDataArray = dataArray.map(data => this.prepareData(data as Record<string, unknown>))

    // Step 4: Single bulk INSERT for performance
    const results = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedDataArray)}
      RETURNING ${db.unsafe(this.cachedSelectColumns)}
    `

    // Step 5: Map database rows to entities
    const entities = results.map((row: DatabaseRow) => this.mapRowToEntity(row))

    // Step 6: Execute afterCreate hooks (parallelized across items)
    const afterHooks = this.definition.hooks.afterCreate

    if (afterHooks.length > 0) {
      await Promise.all(entities.map(async (entity: any) => {
        for (const hook of afterHooks) {
          await hook(entity as any)
        }
      }))
    }

    return entities
  }

  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0)
      return

    // Check bulk operation limit
    const limits = this.getLimits()

    if (ids.length > limits.bulkOperations) {
      throw new BulkOperationError('deleteMany', ids.length, limits.bulkOperations)
    }

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
  // Projections
  // ========================================================================

  /**
   * Select specific fields for projection
   * @example
   * const users = await repo.select('id', 'name', 'email')
   *   .where('age', '>', 18)
   *   .execute()
   * // Type: { id: number, name: string, email: string }[]
   * @deprecated Use query().select() instead for better clarity.
   * Example: repo.query().select('id', 'name').where(...).execute()
   */
  select<F extends readonly (keyof T | 'id')[]>(
    ...fields: F
  ): QueryBuilder<T, F> {
    // Emit deprecation warning in development
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[DEPRECATED] repo.select() is deprecated. Use repo.query().select() instead.\n`
        + `Example: repo.query().select('id', 'name').where(...).execute()`,
      )
    }

    return new QueryBuilder<T, F>(
      this.tableName,
      this.getDB(),
      this.schema,
      (row: DatabaseRow) => this.mapRowToEntity(row),
    ).select(...fields)
  }

  // ========================================================================
  // Transaction Support
  // ========================================================================

  withTransaction(tx: SQL): Repository<T, TTraits> {
    // Create lightweight wrapper sharing precomputed caches
    const wrapper = Object.create(this) as Repository<T, TTraits>

    wrapper.txContext = tx

    return wrapper
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
    return this.columnNameMap.get(fieldName) || toSnake(fieldName)
  }

  private buildEntityPrototype(): any {
    const prototype: any = {}
    // eslint-disable-next-line ts/no-this-alias
    const self = this // Capture repository in closure for direct access

    // Inject trait methods into prototype (performance optimization)
    for (const trait of this.definition.traits) {
      if (trait.methods) {
        for (const [methodName, method] of Object.entries(trait.methods)) {
          prototype[methodName] = function (this: any, ...args: any[]) {
            // 'this' is bound to entity instance
            // Use 'self' from closure - no WeakMap lookup needed (10-20% faster)
            return (method as any).call(this, self, ...args)
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

    // Map database columns using pre-computed field configs
    for (const { fieldName, columnName, config } of this.fieldConfigs) {
      const value = row[columnName]

      if (value === undefined)
        continue

      // Deserialize arrays (they come as TEXT format from PostgreSQL due to casting)
      if (config.type === 'array' && value !== null) {
        if (Array.isArray(value)) {
          entity[fieldName] = value
        }
        else if (typeof value === 'string') {
          // Parse PostgreSQL array text format: {val1,val2,val3}
          entity[fieldName] = this.parsePostgresArray(value, config.arrayType)
        }
        else {
          entity[fieldName] = Array.from(value as any)
        }
      }
      // Deserialize timestamps/dates
      else if ((config.type === 'timestamp' || config.type === 'date') && value !== null) {
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

    // Fast path: simple arrays without quotes (most common case)
    // Single-pass parsing with inline type conversion
    if (!content.includes('"')) {
      if (elementType === 'number') {
        // Single-pass number parsing
        const result: number[] = []
        let start = 0

        for (let i = 0; i <= content.length; i++) {
          if (i === content.length || content[i] === ',') {
            result.push(Number(content.slice(start, i)))
            start = i + 1
          }
        }

        return result
      }

      if (elementType === 'boolean') {
        // Single-pass boolean parsing
        const result: boolean[] = []
        let start = 0

        for (let i = 0; i <= content.length; i++) {
          if (i === content.length || content[i] === ',') {
            const val = content.slice(start, i)

            result.push(val === 't' || val === 'true')
            start = i + 1
          }
        }

        return result
      }

      // String: split is efficient enough
      return content.split(',')
    }

    // Slow path: parse complex arrays with quoted strings
    const elements: string[] = []
    let current = ''
    let inQuotes = false
    let i = 0

    while (i < content.length) {
      const char = content[i]

      if (char === '"' && (i === 0 || content[i - 1] !== '\\')) {
        inQuotes = !inQuotes
        i++

        continue
      }

      if (char === ',' && !inQuotes) {
        elements.push(current)
        current = ''
        i++

        continue
      }

      if (char === '\\' && inQuotes && i + 1 < content.length) {
        const nextChar = content[i + 1]

        if (nextChar === '"' || nextChar === '\\') {
          current += nextChar
          i += 2

          continue
        }
      }

      current += char
      i++
    }

    if (current || content[content.length - 1] === ',') {
      elements.push(current)
    }

    return elements
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
