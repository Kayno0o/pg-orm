import type { SQL } from 'bun'
import type { AbstractEntity } from './entity'
import type { ColumnMetadata, EntityMetadata } from './metadata'
import type { PaginatedResult, QueryOptions } from './types'
import type { DatabaseRow, SQLFragment, WhereConditions } from './types/'
import { SQL as BunSQL } from 'bun'
import { getColumnMetadata, getEntityMetadata } from './metadata'

type EntityConstructor<T extends AbstractEntity> = new () => T

export class AbstractRepository<T extends AbstractEntity> {
  public db!: SQL
  public EntityClass: EntityConstructor<T>
  public tableName: string
  public txContext?: SQL
  public _columnMetadataCache?: Map<string, ColumnMetadata>
  public _entityMetadataCache?: EntityMetadata

  constructor(entityClass: EntityConstructor<T>) {
    this.EntityClass = entityClass
    const metadata = getEntityMetadata(entityClass)

    if (!metadata) {
      throw new Error(
        `Entity metadata not found for ${entityClass.name}. Did you use @Entity decorator?`,
      )
    }

    this.tableName = metadata.tableName
    this._entityMetadataCache = metadata
    this._columnMetadataCache = getColumnMetadata(entityClass)
  }

  setDB(db: SQL): void {
    this.db = db
  }

  getEntityClass(): EntityConstructor<T> {
    return this.EntityClass
  }

  public getDBContext(): SQL {
    return this.txContext || this.db
  }

  public getColumnsMetadata(): Map<string, ColumnMetadata> {
    return this._columnMetadataCache!
  }

  public getEntityMeta(): EntityMetadata {
    return this._entityMetadataCache!
  }

  public mapRowToEntity(row: DatabaseRow): T {
    const entity = new this.EntityClass()
    const columnsMetadata = this.getColumnsMetadata()
    const deserializedRow: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(row)) {
      const columnMeta = columnsMetadata.get(key)

      if (columnMeta?.type === 'array' && value !== null && value !== undefined) {
        if (Array.isArray(value)) {
          if (columnMeta.arrayType === 'text') {
            deserializedRow[key] = value.map((v) => {
              if (typeof v === 'string' && v.startsWith('"') && v.endsWith('"')) {
                return v.slice(1, -1)
              }

              return v
            })
          }
          else {
            deserializedRow[key] = value
          }
        }
        else if (ArrayBuffer.isView(value)) {
          deserializedRow[key] = Array.from(value as unknown as ArrayLike<unknown>)
        }
        else {
          deserializedRow[key] = value
        }
      }
      else {
        deserializedRow[key] = value
      }
    }

    Object.assign(entity, deserializedRow)

    return entity
  }

  public prepareData(data: Record<string, unknown>): Record<string, unknown> {
    const columnsMetadata = this.getColumnsMetadata()
    const prepared: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(data)) {
      const columnMeta = columnsMetadata.get(key)

      if (columnMeta?.type === 'enum' && value !== null && value !== undefined) {
        if (columnMeta.enumValues && !columnMeta.enumValues.includes(String(value))) {
          throw new Error(
            `Invalid enum value "${value}" for column "${key}". Allowed values: ${columnMeta.enumValues.join(', ')}`,
          )
        }
      }

      prepared[key] = value
    }

    return prepared
  }

  async find(id: number): Promise<T | null> {
    const db = this.getDBContext()

    try {
      const [result] = await db`
        SELECT * FROM ${db(this.tableName)}
        WHERE id = ${id}
        LIMIT 1
      `

      return result ? this.mapRowToEntity(result) : null
    }
    catch (error) {
      if (error instanceof BunSQL.PostgresError) {
        throw new TypeError(
          `Failed to find entity in ${this.tableName}: ${error.message}\nCode: ${error.code || 'unknown'}`,
        )
      }

      throw error
    }
  }

  async findAll(): Promise<T[]> {
    const db = this.getDBContext()
    const results = await db`SELECT * FROM ${db(this.tableName)}`

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async create(data: Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>): Promise<T> {
    const db = this.getDBContext()

    try {
      const preparedData = this.prepareData(data as Record<string, unknown>)

      const hasArrays = Object.entries(preparedData).some(([key, value]) => {
        const columnMeta = this.getColumnsMetadata().get(key)

        return columnMeta?.type === 'array' && value !== null && value !== undefined
      })

      if (hasArrays) {
        const columns: string[] = []
        const values: any[] = []

        for (const [key, value] of Object.entries(preparedData)) {
          const columnMeta = this.getColumnsMetadata().get(key)

          columns.push(key)

          if (columnMeta?.type === 'array' && Array.isArray(value)) {
            const arrayType = columnMeta.arrayType || 'text'

            if (arrayType === 'int') {
              values.push(db.unsafe(`ARRAY[${value.join(',')}]::integer[]`))
            }
            else if (arrayType === 'float') {
              values.push(db.unsafe(`ARRAY[${value.join(',')}]::real[]`))
            }
            else {
              values.push((db as any).array(value))
            }
          }
          else {
            values.push(value)
          }
        }

        const columnsList = columns.join(', ')
        let query = db`INSERT INTO ${db(this.tableName)} (${db.unsafe(columnsList)}) VALUES (`

        for (let i = 0; i < values.length; i++) {
          if (i > 0) {
            query = db`${query}, `
          }

          query = db`${query}${values[i]}`
        }

        query = db`${query}) RETURNING *`
        const [result] = await query

        return this.mapRowToEntity(result)
      }

      const [result] = await db`
          INSERT INTO ${db(this.tableName)} ${db(preparedData)}
          RETURNING *
        `

      return this.mapRowToEntity(result)
    }
    catch (error) {
      if (error instanceof BunSQL.PostgresError) {
        throw new TypeError(
          `Failed to create entity in ${this.tableName}: ${error.message}\nCode: ${error.code || 'unknown'}${error.detail ? `\nDetail: ${error.detail}` : ''}`,
        )
      }

      throw error
    }
  }

  async update(
    id: number,
    data: Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>,
  ): Promise<T> {
    if (Object.keys(data).length === 0) {
      throw new Error('No fields to update')
    }

    const db = this.getDBContext()

    try {
      const preparedData = this.prepareData(data as Record<string, unknown>)
      const columnsMetadata = this.getColumnsMetadata()

      const autoUpdateFields: string[] = []

      for (const [key, columnMeta] of columnsMetadata.entries()) {
        if (columnMeta.autoUpdate && !(key in data)) {
          autoUpdateFields.push(key)
        }
      }

      const hasArrays = Object.entries(preparedData).some(([key, value]) => {
        const columnMeta = columnsMetadata.get(key)

        return columnMeta?.type === 'array' && value !== null && value !== undefined
      })

      let result: DatabaseRow

      if (hasArrays) {
        let query = db`UPDATE ${db(this.tableName)} SET `
        const keys = Object.keys(preparedData)
        let first = true

        for (const key of keys) {
          const columnMeta = columnsMetadata.get(key)
          const value = preparedData[key]

          if (!first) {
            query = db`${query}, `
          }

          first = false

          if (columnMeta?.type === 'array' && Array.isArray(value)) {
            const arrayType = columnMeta.arrayType || 'text'

            if (arrayType === 'int') {
              query = db`${query}${db.unsafe(key)} = ${db.unsafe(`ARRAY[${value.join(',')}]::integer[]`)}`
            }
            else if (arrayType === 'float') {
              query = db`${query}${db.unsafe(key)} = ${db.unsafe(`ARRAY[${value.join(',')}]::real[]`)}`
            }
            else {
              query = db`${query}${db.unsafe(key)} = ${(db as any).array(value)}`
            }
          }
          else {
            query = db`${query}${db.unsafe(key)} = ${value}`
          }
        }

        if (autoUpdateFields.length > 0) {
          const autoUpdateParts = autoUpdateFields.map(field => `${field} = NOW()`).join(', ')

          query = db`${query}, ${db.unsafe(autoUpdateParts)}`
        }

        query = db`${query} WHERE id = ${id} RETURNING *`
        const [row] = await query

        result = row
      }
      else if (autoUpdateFields.length > 0) {
        const autoUpdateParts = autoUpdateFields.map(field => `${field} = NOW()`).join(', ')
        const [row] = await db`
          UPDATE ${db(this.tableName)}
          SET ${db(preparedData)}, ${db.unsafe(autoUpdateParts)}
          WHERE id = ${id}
          RETURNING *
        `

        result = row
      }
      else {
        const [row] = await db`
          UPDATE ${db(this.tableName)}
          SET ${db(preparedData)}
          WHERE id = ${id}
          RETURNING *
        `

        result = row
      }

      if (!result) {
        throw new Error(`Entity with id ${id} not found in ${this.tableName}`)
      }

      return this.mapRowToEntity(result)
    }
    catch (error) {
      if (error instanceof BunSQL.PostgresError) {
        throw new TypeError(
          `Failed to update entity in ${this.tableName}: ${error.message}\nCode: ${error.code || 'unknown'}${error.detail ? `\nDetail: ${error.detail}` : ''}`,
        )
      }

      throw error
    }
  }

  async delete(id: number): Promise<void> {
    const db = this.getDBContext()

    await db`DELETE FROM ${db(this.tableName)} WHERE id = ${id}`
  }

  async persist(data: Partial<Omit<T, 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>): Promise<T> {
    const dataWithId = data as Partial<T> & { id?: number }
    const { id, ...updateData } = dataWithId

    if (id !== undefined && id !== null) {
      return await this.update(id, updateData as Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>)
    }

    return await this.create(updateData as Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>)
  }

  async createMany(dataArray: Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>[]): Promise<T[]> {
    if (dataArray.length === 0) {
      return []
    }

    const db = this.getDBContext()

    const preparedArray = dataArray.map(data => this.prepareData(data as Record<string, unknown>))

    const results = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedArray)}
      RETURNING *
    `

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async deleteMany(ids: number[]): Promise<void> {
    if (ids.length === 0) {
      return
    }

    const db = this.getDBContext()

    await db`DELETE FROM ${db(this.tableName)} WHERE id IN ${db(ids)}`
  }

  async updateMany(updates: (Partial<Omit<T, 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>> & { id: number })[]): Promise<T[]> {
    if (updates.length === 0) {
      return []
    }

    const db = this.getDBContext()
    const results: T[] = []

    const executeUpdates = async (txDb: SQL) => {
      for (const updateData of updates) {
        const { id, ...data } = updateData

        if (Object.keys(data).length > 0) {
          const updated = await this.withTransaction(txDb).update(id, data as Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>)

          results.push(updated)
        }
      }
    }

    if (this.txContext) {
      await executeUpdates(db)
    }
    else {
      await db.begin(async (tx) => {
        await executeUpdates(tx)
      })
    }

    return results
  }

  async findAllBy(options: QueryOptions<T>): Promise<T[]> {
    const db = this.getDBContext()
    const results = await this.buildAndExecuteSelectQuery(db, options)

    return results.map((row: DatabaseRow) => this.mapRowToEntity(row))
  }

  async findOneBy(options: QueryOptions<T>): Promise<T | null> {
    const db = this.getDBContext()
    const results = await this.buildAndExecuteSelectQuery(db, options, 1)
    const result = results[0]

    return result ? this.mapRowToEntity(result) : null
  }

  public async buildAndExecuteSelectQuery(
    db: SQL,
    options: QueryOptions<T>,
    limit?: number,
  ): Promise<DatabaseRow[]> {
    let query: SQLFragment = db`SELECT * FROM ${db(this.tableName)}`
    const whereFragments: SQLFragment[] = []

    if (options.where) {
      for (const [key, value] of Object.entries(options.where)) {
        this.validateColumnName(key)

        if (Array.isArray(value)) {
          whereFragments.push(db`${db(key)} IN ${db(value)}`)
        }
        else {
          whereFragments.push(db`${db(key)} = ${value}`)
        }
      }
    }

    if (options.notNull) {
      for (const [key, isNotNull] of Object.entries(options.notNull)) {
        this.validateColumnName(key)

        if (isNotNull) {
          whereFragments.push(db`${db(key)} IS NOT NULL`)
        }
        else {
          whereFragments.push(db`${db(key)} IS NULL`)
        }
      }
    }

    if (whereFragments.length > 0) {
      let whereClause: SQLFragment = whereFragments[0]!

      for (let i = 1; i < whereFragments.length; i++) {
        whereClause = db`${whereClause} AND ${whereFragments[i]!}`
      }
      query = db`${query} WHERE ${whereClause}`
    }

    if (options.order) {
      const orderParts: string[] = []

      for (const [key, direction] of Object.entries(options.order)) {
        this.validateColumnName(key)
        const dir = typeof direction === 'string' ? direction.toUpperCase() : 'ASC'

        orderParts.push(`${key} ${dir}`)
      }

      if (orderParts.length > 0) {
        query = db`${query} ORDER BY ${db.unsafe(orderParts.join(', '))}`
      }
    }

    const finalLimit = limit !== undefined ? limit : options.limit

    if (finalLimit !== undefined) {
      query = db`${query} LIMIT ${finalLimit}`
    }

    if (options.offset !== undefined) {
      query = db`${query} OFFSET ${options.offset}`
    }

    return await (query as Promise<DatabaseRow[]>)
  }

  public validateColumnName(columnName: string): void {
    const columns = this.getColumnsMetadata()

    if (!columns.has(columnName) && columnName !== 'id') {
      throw new Error(
        `Invalid column name '${columnName}' for entity ${this.EntityClass.name}. Valid columns: ${Array.from(columns.keys()).join(', ')}, id`,
      )
    }
  }

  async count(options?: QueryOptions<T>): Promise<number> {
    const db = this.getDBContext()

    if (!options || Object.keys(options).length === 0) {
      const [result] = await db`SELECT COUNT(*)::int as count FROM ${db(this.tableName)}`

      return result?.count || 0
    }

    const results = await this.buildAndExecuteSelectQuery(db, {
      ...options,
      limit: undefined,
      offset: undefined,
    })

    return results.length
  }

  async exists(id: number): Promise<boolean> {
    const db = this.getDBContext()
    const [result] = await db`SELECT 1 FROM ${db(this.tableName)} WHERE id = ${id} LIMIT 1`

    return Boolean(result)
  }

  async existsBy(options: QueryOptions<T>): Promise<boolean> {
    const result = await this.findOneBy(options)

    return result !== null
  }

  async findOrFail(id: number): Promise<T> {
    const entity = await this.find(id)

    if (!entity) {
      const { EntityNotFoundError } = await import('./errors')

      throw new EntityNotFoundError(this.EntityClass.name, id)
    }

    return entity
  }

  async findByOrFail(options: QueryOptions<T>): Promise<T> {
    const entity = await this.findOneBy(options)

    if (!entity) {
      const { EntityNotFoundError } = await import('./errors')

      throw new EntityNotFoundError(this.EntityClass.name, options as Record<string, unknown>)
    }

    return entity
  }

  async paginate(options: {
    page: number
    pageSize: number
    where?: QueryOptions<T>['where']
    order?: QueryOptions<T>['order']
    notNull?: QueryOptions<T>['notNull']
  }): Promise<PaginatedResult<T>> {
    const { page, pageSize, ...queryOptions } = options
    const offset = (page - 1) * pageSize
    const db = this.getDBContext()

    const [results, totalResult] = await Promise.all([
      this.buildAndExecuteSelectQuery(db, {
        ...queryOptions,
        limit: pageSize,
        offset,
      } as QueryOptions<T>),
      this.count(queryOptions as QueryOptions<T>),
    ])

    const data = results.map(row => this.mapRowToEntity(row))
    const total = totalResult
    const totalPages = Math.ceil(total / pageSize)

    return {
      data,
      meta: {
        total,
        page,
        pageSize,
        totalPages,
        hasNext: page < totalPages,
        hasPrevious: page > 1,
      },
    }
  }

  async upsert(data: Partial<Omit<T, 'id' | 'save' | 'reload' | 'remove' | 'toObject' | 'toJSON'>>): Promise<T> {
    const db = this.getDBContext()

    const uniqueColumns = Array.from(this.getColumnsMetadata().entries())
      .filter(([_, col]) => col.unique)
      .map(([name]) => name)

    if (uniqueColumns.length === 0) {
      return await this.create(data)
    }

    const conflictTarget = uniqueColumns[0]!
    const updateColumns = Object.keys(data).filter(k => k !== conflictTarget)

    const preparedData = this.prepareData(data as Record<string, unknown>)

    if (updateColumns.length === 0) {
      const [result] = await db`
        INSERT INTO ${db(this.tableName)} ${db(preparedData)}
        ON CONFLICT (${db.unsafe(conflictTarget)}) DO NOTHING
        RETURNING *
      `

      if (result) {
        return this.mapRowToEntity(result)
      }

      const existing = await this.findOneBy({
        where: { [conflictTarget]: (data as Record<string, unknown>)[conflictTarget] } as WhereConditions<T>,
      })

      return existing!
    }

    const updateSet = updateColumns.map(col => `${col} = EXCLUDED.${col}`).join(', ')

    const [result] = await db`
      INSERT INTO ${db(this.tableName)} ${db(preparedData)}
      ON CONFLICT (${db.unsafe(conflictTarget)})
      DO UPDATE SET ${db.unsafe(updateSet)}
      RETURNING *
    `

    return this.mapRowToEntity(result)
  }

  async transaction<R>(callback: () => Promise<R>): Promise<R> {
    return await this.db.begin(async (tx) => {
      const previousTx = this.txContext

      this.txContext = tx

      try {
        return await callback()
      }
      finally {
        this.txContext = previousTx
      }
    })
  }

  withTransaction(tx: SQL): this {
    const repo = Object.create(this) as this

    repo.txContext = tx

    return repo
  }
}
