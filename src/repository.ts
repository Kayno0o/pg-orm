import type { SQL } from 'bun'
import type { CacheAdapter } from './cache'
import type { RelationSchema, WithRelations } from './relations/types'
import type {
  DatabaseRow,
  EntityDefinition,
  EntitySchema,
  InferCreateData,
  InferEntity,
  InferUpdateData,
} from './types'
import { toSnake } from '@kaynooo/utils'
import { getDatabaseConfig } from './db'
import { BulkOperationError, EntityNotFoundError } from './errors'
import { extractOperation, queryLogger } from './logger'
import { EntityMapper } from './mapper'
import { QueryBuilder } from './query'
import { RelationLoader } from './relations/loader'
import { SchemaValidator } from './schema-validator'
import { hasColumnName, isArrayFieldConfig } from './types'
import { mapDatabaseError } from './utils/error-mapper'
import { ValidationError } from './validation'

/**
 * Repository for managing entity persistence and data access.
 * Provides generic CRUD operations and query building capabilities.
 */
export class Repository<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
  TScopes extends string = string,
  // eslint-disable-next-line ts/no-empty-object-type
  TRelations extends RelationSchema = {},
> {
  private tableName: string
  private schema: T
  private definition: EntityDefinition<T, TTraits, TScopes, TRelations>
  private txContext?: SQL
  private entityPrototype: any
  private cachedSelectColumns: string
  private columnNameMap: Map<string, string>
  private reverseColumnMap: Map<string, string>
  private fieldConfigs: { fieldName: string, columnName: string, config: any }[]
  private mapper: EntityMapper<T, TTraits>
  private schemaValidator: SchemaValidator<T>
  private cacheAdapter?: CacheAdapter
  private _relationLoader?: RelationLoader<T, TRelations>
  private orm: any

  constructor(
    entityDef: EntityDefinition<T, TTraits, TScopes, TRelations>,
    cacheAdapter: CacheAdapter | undefined,
    orm: any,
  ) {
    this.definition = entityDef
    this.tableName = entityDef.tableName
    this.schema = entityDef.schema
    this.cacheAdapter = cacheAdapter
    this.orm = orm

    this.columnNameMap = new Map()
    this.columnNameMap.set('id', 'id')
    for (const fieldName of Object.keys(this.schema)) {
      this.columnNameMap.set(fieldName, this.computeColumnName(fieldName))
    }

    this.reverseColumnMap = new Map()
    this.reverseColumnMap.set('id', 'id')
    for (const [fieldName, columnName] of this.columnNameMap) {
      this.reverseColumnMap.set(columnName, fieldName)
    }

    this.fieldConfigs = Object.entries(this.schema).map(([fieldName, config]) => ({
      fieldName,
      columnName: this.columnNameMap.get(fieldName)!,
      config,
    }))

    const columns = ['id', ...Object.keys(this.schema).map(k => this.columnNameMap.get(k)!)]

    // SECURITY AUDIT: cachedSelectColumns is constructed from schema field names only,
    // which are validated at entity definition time. All column names are derived from
    // schema keys via computeColumnName() which applies toSnake() transformation.
    // This string is safe for use with db.unsafe() since it contains no user input.
    this.cachedSelectColumns = columns
      .map((col) => {
        const fieldName = this.reverseColumnMap.get(col)

        if (fieldName) {
          const config = this.schema[fieldName]

          if (config?.type === 'array') {
            return `${col}::TEXT[] as ${col}`
          }
        }

        return col
      })
      .join(', ')

    this.entityPrototype = this.buildEntityPrototype()

    this.mapper = new EntityMapper(
      this.schema,
      this.definition,
      this.fieldConfigs,
      this.reverseColumnMap,
      this.entityPrototype,
    )

    this.schemaValidator = new SchemaValidator(this.schema, this.tableName)
  }

  private get relationLoader(): RelationLoader<T, TRelations> {
    this._relationLoader ||= new RelationLoader(this.getDB(), this.orm, this.definition)

    return this._relationLoader
  }

  private computeColumnName(fieldName: string): string {
    const fieldConfig = this.schema[fieldName]

    if (!fieldConfig) {
      return toSnake(fieldName)
    }

    if (hasColumnName(fieldConfig)) {
      return fieldConfig.columnName
    }

    return toSnake(fieldName)
  }

  private getLimits() {
    try {
      const config = getDatabaseConfig()

      return {
        bulkOperations: config.limits?.bulkOperations ?? 1000,
        arraySize: config.limits?.arraySize ?? 1000,
        stringLength: config.limits?.stringLength ?? 1_000_000,
        jsonSize: config.limits?.jsonSize ?? 10_000_000,
        jsonDepth: config.limits?.jsonDepth ?? 32,
      }
    }
    catch {
      return {
        bulkOperations: 1000,
        arraySize: 1000,
        stringLength: 1_000_000,
        jsonSize: 10_000_000,
        jsonDepth: 32,
      }
    }
  }

  private isStrictMode(): boolean {
    try {
      const config = getDatabaseConfig()

      return config.validation?.strict ?? true
    }
    catch {
      return true
    }
  }

  private async loggedQuery<R>(
    queryFn: () => Promise<R>,
    query: string,
    params: unknown[],
  ): Promise<R> {
    const start = performance.now()
    let error: Error | undefined

    try {
      return await queryFn()
    }
    catch (err) {
      error = mapDatabaseError(err, this.tableName)
      throw error
    }
    finally {
      const duration = performance.now() - start

      await queryLogger.log({
        query,
        params,
        duration,
        timestamp: new Date(),
        operation: extractOperation(query),
        table: this.tableName,
        error,
      })
    }
  }

  /**
   * Finds a single entity by its ID.
   * @param id - The entity ID.
   * @param options - Optional configuration object.
   * @param options.with - Array of relation names to eager load.
   */
  async find<With extends (keyof TRelations)[] = []>(
    id: number,
    options?: { with?: With },
  ): Promise<
    With extends [] | undefined
      ? InferEntity<T, TTraits> | null
      : [With[number]] extends [never]
        ? InferEntity<T, TTraits> | null
        : WithRelations<T, TRelations, With, TTraits> | null
  > {
    const entity = await this.findBasic(id)

    if (!entity)
      return null as any

    // Explicitly handle empty array and undefined cases
    if (!options?.with || options.with.length === 0) {
      return entity as any
    }

    const loaded = (await this.relationLoader.loadRelations([entity] as any, options.with)) as unknown as any[]

    return loaded[0] as any
  }

  private async findBasic(id: number): Promise<InferEntity<T, TTraits> | null> {
    const db = this.getDB()

    // SECURITY: cachedSelectColumns is pre-validated schema-derived column list (see constructor)
    return this.loggedQuery(
      async () => {
        const [result] = await db`
          SELECT ${db.unsafe(this.cachedSelectColumns)} FROM ${db(this.tableName)}
          WHERE id = ${id}
          LIMIT 1
        `

        return result ? this.mapper.mapRowToEntity(result) : null
      },
      `SELECT ${this.cachedSelectColumns} FROM ${this.tableName} WHERE id = $1 LIMIT 1`,
      [id],
    )
  }

  /**
   * Retrieves all entities.
   * @param options - Optional configuration object.
   * @param options.with - Array of relation names to eager load.
   */
  async findAll<With extends (keyof TRelations)[] = []>(
    options?: { with?: With },
  ): Promise<
    With extends [] | undefined
      ? InferEntity<T, TTraits>[]
      : [With[number]] extends [never]
        ? InferEntity<T, TTraits>[]
        : WithRelations<T, TRelations, With, TTraits>[]
  > {
    const entities = await this.findAllBasic()

    // Explicitly handle empty array and undefined cases
    if (!options?.with || options.with.length === 0) {
      return entities as any
    }

    return (await this.relationLoader.loadRelations(entities as any, options.with)) as any
  }

  private async findAllBasic(): Promise<InferEntity<T, TTraits>[]> {
    const db = this.getDB()

    // SECURITY: cachedSelectColumns is pre-validated schema-derived column list (see constructor)
    return this.loggedQuery(
      async () => {
        const results = await db`SELECT ${db.unsafe(this.cachedSelectColumns)} FROM ${db(this.tableName)}`

        return results.map((row: DatabaseRow) => this.mapper.mapRowToEntity(row))
      },
      `SELECT ${this.cachedSelectColumns} FROM ${this.tableName}`,
      [],
    )
  }

  /**
   * Creates a new entity.
   * @param data - The data for the new entity.
   * @param options - Optional configuration object.
   * @param options.skipValidation - If true, skips validation for the data.
   */
  async create(data: InferCreateData<T>, options?: { skipValidation?: boolean }): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    if (!options?.skipValidation) {
      const limits = this.getLimits()

      await this.schemaValidator.validateCreate(data as Record<string, unknown>, limits.jsonDepth)
    }

    for (const hook of this.definition.hooks.beforeCreate) {
      await hook(data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)

    // SECURITY: cachedSelectColumns is pre-validated schema-derived column list (see constructor)
    return this.loggedQuery(
      async () => {
        const [result] = await db`
          INSERT INTO ${db(this.tableName)} ${db(preparedData)}
          RETURNING ${db.unsafe(this.cachedSelectColumns)}
        `

        const entity = this.mapper.mapRowToEntity(result)

        for (const hook of this.definition.hooks.afterCreate) {
          await hook(entity as any)
        }

        return entity
      },
      `INSERT INTO ${this.tableName} RETURNING ${this.cachedSelectColumns}`,
      [preparedData],
    )
  }

  /**
   * Updates an existing entity.
   * @param id - The ID of the entity to update.
   * @param data - The data to update.
   */
  async update(id: number, data: InferUpdateData<T>): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    const limits = this.getLimits()

    await this.schemaValidator.validateUpdate(data as Record<string, unknown>, limits.jsonDepth)

    for (const hook of this.definition.hooks.beforeUpdate) {
      await hook(id, data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)

    // SECURITY: cachedSelectColumns is pre-validated schema-derived column list (see constructor)
    return this.loggedQuery(
      async () => {
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

        const entity = this.mapper.mapRowToEntity(result)

        for (const hook of this.definition.hooks.afterUpdate) {
          await hook(entity as any)
        }

        return entity
      },
      `UPDATE ${this.tableName} SET ... WHERE id = $1 RETURNING ${this.cachedSelectColumns}`,
      [id, preparedData],
    )
  }

  /**
   * Deletes an entity.
   * @param id - The ID of the entity to delete.
   */
  async delete(id: number): Promise<void> {
    const db = this.getDB()

    for (const hook of this.definition.hooks.beforeDelete) {
      await hook(id)
    }

    return this.loggedQuery(
      async () => {
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

        for (const hook of this.definition.hooks.afterDelete) {
          await hook(id)
        }
      },
      `DELETE FROM ${this.tableName} WHERE id = $1 RETURNING id`,
      [id],
    )
  }

  /**
   * Counts entities in the table.
   * @param exact - Whether to perform an exact count (default: true).
   */
  async count(exact = true): Promise<number> {
    const db = this.getDB()

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
        // Fall back to exact count
      }
    }

    return await this.query().count()
  }

  /**
   * Checks if an entity exists.
   * @param id - The entity ID.
   */
  async exists(id: number): Promise<boolean> {
    const db = this.getDB()

    return this.loggedQuery(
      async () => {
        const [result] = await db`
          SELECT 1 FROM ${db(this.tableName)}
          WHERE id = ${id}
          LIMIT 1
        `

        return result !== undefined
      },
      `SELECT 1 FROM ${this.tableName} WHERE id = $1 LIMIT 1`,
      [id],
    )
  }

  /**
   * Creates multiple entities in bulk.
   * @param dataArray - Array of entity data.
   * @param options - Optional configuration object.
   * @param options.skipValidation - If true, skips validation for the data.
   */
  async createMany(dataArray: InferCreateData<T>[], options?: { skipValidation?: boolean }): Promise<InferEntity<T, TTraits>[]> {
    if (dataArray.length === 0)
      return []

    const limits = this.getLimits()

    if (dataArray.length > limits.bulkOperations) {
      throw new BulkOperationError('createMany', dataArray.length, limits.bulkOperations)
    }

    if (options?.skipValidation && this.isStrictMode()) {
      throw new Error(
        'Cannot skip validation in strict mode. '
        + 'Set validation.strict to false in database config to allow skipValidation.',
      )
    }

    const db = this.getDB()

    if (!options?.skipValidation) {
      const limits = this.getLimits()

      for (const data of dataArray) {
        await this.schemaValidator.validateCreate(data as Record<string, unknown>, limits.jsonDepth)
      }
    }

    const beforeHooks = this.definition.hooks.beforeCreate

    if (beforeHooks.length > 0) {
      await Promise.all(dataArray.map(async (data) => {
        for (const hook of beforeHooks) {
          await hook(data)
        }
      }))
    }

    const preparedDataArray = dataArray.map(data => this.prepareData(data as Record<string, unknown>))

    // SECURITY: cachedSelectColumns is pre-validated schema-derived column list (see constructor)
    return this.loggedQuery(
      async () => {
        const results = await db`
          INSERT INTO ${db(this.tableName)} ${db(preparedDataArray)}
          RETURNING ${db.unsafe(this.cachedSelectColumns)}
        `

        const entities = results.map((row: DatabaseRow) => this.mapper.mapRowToEntity(row))

        const afterHooks = this.definition.hooks.afterCreate

        if (afterHooks.length > 0) {
          await Promise.all(entities.map(async (entity: any) => {
            for (const hook of afterHooks) {
              await hook(entity as any)
            }
          }))
        }

        return entities
      },
      `INSERT INTO ${this.tableName} (bulk ${dataArray.length} rows) RETURNING ${this.cachedSelectColumns}`,
      preparedDataArray,
    )
  }

  /**
   * Deletes multiple entities by ID.
   * @param ids - Array of entity IDs to delete.
   */
  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0)
      return

    const limits = this.getLimits()

    if (ids.length > limits.bulkOperations) {
      throw new BulkOperationError('deleteMany', ids.length, limits.bulkOperations)
    }

    const db = this.getDB()

    await this.loggedQuery(
      async () => {
        await db`
          DELETE FROM ${db(this.tableName)}
          WHERE id IN ${db(ids)}
        `
      },
      `DELETE FROM ${this.tableName} WHERE id IN ($1)`,
      [ids],
    )
  }

  /**
   * Creates a query builder for the entity.
   */
  query(): QueryBuilder<T, never, TScopes> {
    return new QueryBuilder<T, never, TScopes>(
      this.tableName,
      this.getDB(),
      this.schema,
      (row: DatabaseRow) => this.mapper.mapRowToEntity(row),
      this.definition.scopes,
      this.cacheAdapter,
    )
  }

  /**
   * Applies a named scope to the query.
   * @param name - The name of the scope.
   */
  scope(name: TScopes) {
    const scopeFn = this.definition.scopes.get(name)

    if (!scopeFn) {
      throw new Error(`Scope "${name}" not found on entity ${this.tableName}`)
    }

    const query = this.query()

    return scopeFn(query as QueryBuilder<T, any, any>)
  }

  /**
   * Binds the repository to a specific transaction.
   * @param tx - The transaction instance.
   */
  withTransaction(tx: SQL): this {
    const wrapper = Object.create(this)

    wrapper.txContext = tx

    return wrapper
  }

  /**
   * Executes a callback within a transaction.
   * @param callback - Function to execute with a transaction-bound repository.
   */
  async transaction<R>(callback: (repo: Repository<T, TTraits, TScopes, TRelations>) => Promise<R>): Promise<R> {
    const db = this.getDB()

    return await db.begin(async (tx) => {
      const txRepo = this.withTransaction(tx)

      return await callback(txRepo)
    })
  }

  /**
   * Extends the repository with custom methods.
   * @param methods - Object containing custom methods.
   */
  extend<Methods extends Record<string, (this: Repository<T, TTraits, TScopes, TRelations>, ...args: any[]) => any>>(
    methods: Methods,
  ): Repository<T, TTraits, TScopes, TRelations> & {
    [K in keyof Methods]: Methods[K] extends (this: any, ...args: infer Args) => infer Return
      ? (...args: Args) => Return
      : never
  } {
    const extended = Object.create(this)

    for (const [name, method] of Object.entries(methods)) {
      extended[name] = method.bind(extended)
    }

    return extended as any
  }

  /**
   * Cleans up the repository state (e.g., transaction context).
   */
  cleanup(): void {
    this.txContext = undefined
  }

  /**
   * Gets the current database connection (or transaction).
   */
  getDB(): SQL {
    return this.txContext || this.orm.getDB()
  }

  private getColumnName(fieldName: string): string {
    return this.columnNameMap.get(fieldName) || toSnake(fieldName)
  }

  private buildEntityPrototype(): Record<string, (...args: unknown[]) => unknown> {
    const prototype: Record<string, (...args: unknown[]) => unknown> = {}
    // eslint-disable-next-line ts/no-this-alias
    const self = this

    for (const trait of this.definition.traits) {
      if (trait.methods) {
        for (const [methodName, method] of Object.entries(trait.methods)) {
          prototype[methodName] = function (this: InferEntity<T, TTraits>, ...args: unknown[]) {
            return (method as (...args: unknown[]) => unknown).call(this, self, ...args)
          }
        }
      }
    }

    return prototype
  }

  private prepareData(data: Record<string, unknown>): Record<string, unknown> {
    const prepared: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data)) {
      const fieldConfig = this.schema[key]

      if (!fieldConfig)
        continue

      const columnName = this.getColumnName(key)

      if (isArrayFieldConfig(fieldConfig) && Array.isArray(value)) {
        const arrayType = fieldConfig.arrayType

        if (arrayType === 'string') {
          const formatted = value.map((v) => {
            const str = String(v)
            const needsQuoting = (/[",\\{}\s]/).test(str) || str === ''

            if (needsQuoting) {
              const escaped = str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

              return `"${escaped}"`
            }

            return str
          })

          prepared[columnName] = `{${formatted.join(',')}}`
        }
        else {
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

export { ValidationError }
