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
import { hasColumnName, isArrayFieldConfig } from './types'
import { parsePostgresArray } from './utils/array-parser'
import { ValidationError, Validator } from './validation'

export class Repository<
  T extends EntitySchema,
  TTraits extends readonly any[] = readonly any[],
> {
  private tableName: string
  private schema: T
  private definition: EntityDefinition<T, TTraits>
  private txContext?: SQL
  private validator: Validator
  private validatorCache: Map<number, Validator>
  private entityPrototype: any
  private cachedSelectColumns: string
  private columnNameMap: Map<string, string>
  private reverseColumnMap: Map<string, string>
  private fieldConfigs: { fieldName: string, columnName: string, config: any }[]

  constructor(entityDef: EntityDefinition<T, TTraits>) {
    this.definition = entityDef
    this.tableName = entityDef.tableName
    this.schema = entityDef.schema

    this.validator = new Validator({
      maxJsonDepth: 32,
    })

    this.validatorCache = new Map()

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

  private getValidator(): Validator {
    const limits = this.getLimits()

    if (limits.jsonDepth === 32) {
      return this.validator
    }

    let cached = this.validatorCache.get(limits.jsonDepth)

    if (!cached) {
      cached = new Validator({ maxJsonDepth: limits.jsonDepth })
      this.validatorCache.set(limits.jsonDepth, cached)
    }

    return cached
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

    if (!options?.skipValidation) {
      this.getValidator().validate(data as Record<string, unknown>, this.schema, 'create', this.tableName)
    }

    for (const hook of this.definition.hooks.beforeCreate) {
      await hook(data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)
    const [result] = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedData)}
      RETURNING ${db.unsafe(this.cachedSelectColumns)}
    `

    const entity = this.mapRowToEntity(result)

    for (const hook of this.definition.hooks.afterCreate) {
      await hook(entity as any)
    }

    return entity
  }

  async update(id: number, data: InferUpdateData<T>): Promise<InferEntity<T, TTraits>> {
    const db = this.getDB()

    this.getValidator().validate(data as Record<string, unknown>, this.schema, 'update', this.tableName)

    for (const hook of this.definition.hooks.beforeUpdate) {
      await hook(id, data)
    }

    const preparedData = this.prepareData(data as Record<string, unknown>)

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

    for (const hook of this.definition.hooks.afterUpdate) {
      await hook(entity as any)
    }

    return entity
  }

  async delete(id: number): Promise<void> {
    const db = this.getDB()

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

    for (const hook of this.definition.hooks.afterDelete) {
      await hook(id)
    }
  }

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

  async exists(id: number): Promise<boolean> {
    const db = this.getDB()
    const [result] = await db`
      SELECT 1 FROM ${db(this.tableName)}
      WHERE id = ${id}
      LIMIT 1
    `

    return result !== undefined
  }

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
      const validator = this.getValidator()

      for (const data of dataArray) {
        validator.validate(data as Record<string, unknown>, this.schema, 'create', this.tableName)
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

    const results = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedDataArray)}
      RETURNING ${db.unsafe(this.cachedSelectColumns)}
    `

    const entities = results.map((row: DatabaseRow) => this.mapRowToEntity(row))

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

  query(): QueryBuilder<T> {
    return new QueryBuilder<T>(
      this.tableName,
      this.getDB(),
      this.schema,
      (row: DatabaseRow) => this.mapRowToEntity(row),
    )
  }

  withTransaction(tx: SQL): this {
    const wrapper = Object.create(this)

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

  extend<Methods extends Record<string, (this: Repository<T, TTraits>, ...args: any[]) => any>>(
    methods: Methods,
  ): Repository<T, TTraits> & {
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

  cleanup(): void {
    this.txContext = undefined
  }

  private getDB(): SQL {
    return this.txContext || getDatabase()
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

  private mapRowToEntity(row: DatabaseRow): InferEntity<T, TTraits> {
    const entity: any = Object.create(this.entityPrototype)

    entity.id = row.id

    for (const { fieldName, columnName, config } of this.fieldConfigs) {
      const value = row[columnName]

      if (value === undefined)
        continue

      if (config.type === 'array' && value !== null) {
        if (Array.isArray(value)) {
          entity[fieldName] = value
        }
        else if (typeof value === 'string') {
          entity[fieldName] = this.parsePostgresArray(value, config.arrayType)
        }
        else {
          entity[fieldName] = Array.from(value as any)
        }
      }
      else if ((config.type === 'timestamp' || config.type === 'date') && value !== null) {
        entity[fieldName] = value instanceof Date ? value : new Date(value as string)
      }
      else {
        entity[fieldName] = value
      }
    }

    return entity as InferEntity<T, TTraits>
  }

  private parsePostgresArray(textValue: string, elementType: string): any[] {
    return parsePostgresArray(textValue, elementType as 'string' | 'number' | 'boolean')
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
