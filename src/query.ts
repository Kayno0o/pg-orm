import type { SQL } from 'bun'
import type { CacheAdapter } from './cache'
import type { AllWhereOperator, ArrayFieldKeys, DatabaseRow, EntityDefinition, EntitySchema, InferArrayElement, InferEntity, InferProjectionClean, InferUpdateData, JsonFieldKeys, OperatorsForKey, OrderDirection, QueryResult, ScopeDefinition, SQLValue, StringLikeFieldKeys, WhereValueForKey } from './types'
import { hashCacheKey } from './cache'
import { InvalidColumnError } from './errors'
import { extractOperation, queryLogger } from './logger'
import { SchemaMetadata } from './schema-metadata'
import { validateSQLIdentifier } from './sql-utils'
import { mapDatabaseError } from './utils/error-mapper'

type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'

interface JoinClause {
  type: JoinType
  table: string
  leftColumn: string
  operator: string
  rightColumn: string
}

/**
 * Builder for constructing and executing type-safe SQL queries.
 */
export class QueryBuilder<
  T extends EntitySchema,
  SelectedFields extends readonly (keyof T | 'id' | string)[] = never,
  TScopes extends string = never,
  TTraits extends readonly any[] = readonly [],
  TAggregations extends Record<string, any> = {},
  TGroupedFields extends readonly (keyof T | 'id')[] = never,
> {
  private selectFields: string[]
  private whereConditions: string[] = []
  private whereConnectors: ('AND' | 'OR')[] = []
  private whereParams: SQLValue[] = []
  private orderByFields: { field: string, direction: OrderDirection }[] = []
  private limitValue?: number
  private offsetValue?: number
  private groupByFields: string[] = []
  private readonly aggregations = new Map<string, { func: string, field: string }>()
  private validColumns: Set<string>
  private scopes?: Map<string, ScopeDefinition<T>>
  private joinClauses: JoinClause[] = []
  private cacheTtl?: number
  private cacheAdapter?: CacheAdapter
  private hasCustomSelect = false
  private schemaName?: string
  private metadata: SchemaMetadata<T>

  // eslint-disable-next-line max-params
  constructor(
    private tableName: string,
    private db: SQL,
    private schema: T,
    private mapper?: (row: DatabaseRow) => any,
    scopes?: Map<string, ScopeDefinition<T>>,
    cacheAdapter?: CacheAdapter,
    schemaName?: string,
    private entity?: EntityDefinition<T, any, any>,
    private orm?: any,
  ) {
    validateSQLIdentifier(tableName, 'table')
    this.selectFields = [`${tableName}.*`]

    this.metadata = this.entity?.metadata || new SchemaMetadata(tableName, schema)
    this.validColumns = new Set(this.metadata.getColumns())

    this.scopes = scopes
    this.cacheAdapter = cacheAdapter
    this.schemaName = schemaName
  }

  private getColumnName(fieldName: string): string {
    return this.metadata.getColumnName(fieldName)
  }

  private validateColumnName(field: string): string {
    const columnName = this.getColumnName(field)

    if (!this.validColumns.has(columnName)) {
      throw new InvalidColumnError(
        field,
        this.tableName,
        Array.from(this.validColumns),
      )
    }

    return columnName
  }

  private addParam(value: SQLValue): string {
    this.whereParams.push(value)

    return `$${this.whereParams.length}`
  }

  private pushCondition(sql: string, connector: 'AND' | 'OR' = 'AND'): void {
    this.whereConditions.push(sql)
    this.whereConnectors.push(connector)
  }

  private buildWhereClause(): string {
    if (this.whereConditions.length === 0)
      return ''

    let clause = this.whereConditions[0]

    for (let i = 1; i < this.whereConditions.length; i++) {
      clause += ` ${this.whereConnectors[i]} ${this.whereConditions[i]}`
    }

    return `WHERE ${clause}`
  }

  /**
   * Selects specific fields to return.
   * Supports dot notation for joined relations (e.g., 'author.name').
   * @param fields - The fields to select.
   */
  select<F extends readonly (keyof T | 'id' | `${string}.${string}`)[]>(
    ...fields: F

  ): QueryBuilder<T, F, TScopes, TTraits, TAggregations, TGroupedFields> {
    this.hasCustomSelect = true
    this.selectFields = fields.map((f) => {
      const fieldStr = String(f)

      if (fieldStr.includes('.')) {
        return fieldStr
      }

      return this.validateColumnName(fieldStr)
    })

    return this as any
  }

  private _where(field: string, operator: string, value: SQLValue, connector: 'AND' | 'OR' = 'AND'): this {
    const columnName = field.includes('.')
      ? field
      : this.validateColumnName(field)
    const placeholder = this.addParam(value)

    this.pushCondition(`${columnName} ${operator} ${placeholder}`, connector)

    return this
  }

  where<K extends keyof T | 'id'>(field: K, operator: OperatorsForKey<T, K>, value: WhereValueForKey<T, K>): this
  where(field: `${string}.${string}`, operator: AllWhereOperator, value: SQLValue): this
  where(field: any, operator: any, value: any): this {
    return this._where(String(field), operator, value)
  }

  orWhere<K extends keyof T | 'id'>(field: K, operator: OperatorsForKey<T, K>, value: WhereValueForKey<T, K>): this
  orWhere(field: `${string}.${string}`, operator: AllWhereOperator, value: SQLValue): this
  orWhere(field: any, operator: any, value: any): this {
    return this._where(String(field), operator, value, 'OR')
  }

  private _whereGroup(callback: (q: this) => void, connector: 'AND' | 'OR'): this {
    const startIdx = this.whereConditions.length

    callback(this)

    const groupConditions = this.whereConditions.splice(startIdx)
    const groupConnectors = this.whereConnectors.splice(startIdx)

    if (groupConditions.length > 0) {
      let groupSql = groupConditions[0]

      for (let i = 1; i < groupConditions.length; i++) {
        groupSql += ` ${groupConnectors[i]} ${groupConditions[i]}`
      }

      this.pushCondition(`(${groupSql})`, connector)
    }

    return this
  }

  whereGroup(callback: (q: this) => void): this {
    return this._whereGroup(callback, 'AND')
  }

  orWhereGroup(callback: (q: this) => void): this {
    return this._whereGroup(callback, 'OR')
  }

  whereEquals<K extends keyof T | 'id'>(field: K, value: WhereValueForKey<T, K>): this {
    return this._where(String(field), '=', value as SQLValue)
  }

  whereIn<K extends keyof T | 'id'>(field: K, values: WhereValueForKey<T, K>[]): this {
    if (values.length === 0) {
      this.pushCondition('FALSE')

      return this
    }

    const columnName = this.validateColumnName(String(field))
    const placeholders = values.map(v => this.addParam(v as SQLValue)).join(', ')

    this.pushCondition(`${columnName} IN (${placeholders})`)

    return this
  }

  whereNotIn<K extends keyof T | 'id'>(field: K, values: WhereValueForKey<T, K>[]): this {
    if (values.length === 0) {
      return this
    }

    const columnName = this.validateColumnName(String(field))
    const placeholders = values.map(v => this.addParam(v as SQLValue)).join(', ')

    this.pushCondition(`${columnName} NOT IN (${placeholders})`)

    return this
  }

  whereLike(field: StringLikeFieldKeys<T> | 'id', pattern: string): this {
    return this._where(String(field), 'LIKE', pattern)
  }

  whereILike(field: StringLikeFieldKeys<T> | 'id', pattern: string): this {
    return this._where(String(field), 'ILIKE', pattern)
  }

  whereNull(field: keyof T | 'id'): this {
    const columnName = this.validateColumnName(String(field))

    this.pushCondition(`${columnName} IS NULL`)

    return this
  }

  whereNotNull(field: keyof T | 'id'): this {
    const columnName = this.validateColumnName(String(field))

    this.pushCondition(`${columnName} IS NOT NULL`)

    return this
  }

  whereBetween<K extends keyof T | 'id'>(field: K, min: WhereValueForKey<T, K>, max: WhereValueForKey<T, K>): this {
    const columnName = this.validateColumnName(String(field))
    const minPlaceholder = this.addParam(min as SQLValue)
    const maxPlaceholder = this.addParam(max as SQLValue)

    this.pushCondition(`${columnName} BETWEEN ${minPlaceholder} AND ${maxPlaceholder}`)

    return this
  }

  whereJsonContains(field: JsonFieldKeys<T>, value: unknown): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(JSON.stringify(value))

    this.pushCondition(`${columnName} @> ${placeholder}::jsonb`)

    return this
  }

  whereJsonHasKey(field: JsonFieldKeys<T>, key: string): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(key)

    this.pushCondition(`${columnName} ? ${placeholder}`)

    return this
  }

  whereArrayContains<K extends ArrayFieldKeys<T>>(field: K, value: InferArrayElement<T[K]>): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam([value] as SQLValue)

    this.pushCondition(`${placeholder} = ANY(${columnName})`)

    return this
  }

  whereArrayOverlaps<K extends ArrayFieldKeys<T>>(field: K, values: InferArrayElement<T[K]>[]): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(values as SQLValue)

    this.pushCondition(`${columnName} && ${placeholder}`)

    return this
  }

  private _orderBy(field: string, direction: OrderDirection): this {
    const columnName = field.includes('.')
      ? field
      : this.validateColumnName(field)

    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new Error(`Invalid ORDER BY direction: ${direction}. Must be ASC or DESC.`)
    }

    this.orderByFields.push({ field: columnName, direction })

    return this
  }

  orderBy(field: keyof T | 'id', direction?: OrderDirection): this
  orderBy(field: `${string}.${string}`, direction?: OrderDirection): this
  orderBy(field: string, direction: OrderDirection = 'ASC'): this {
    return this._orderBy(String(field), direction)
  }

  orderByDesc(field: keyof T | 'id'): this
  orderByDesc(field: `${string}.${string}`): this
  orderByDesc(field: string): this {
    return this._orderBy(String(field), 'DESC')
  }

  /** Adds a GROUP BY clause. */
  groupBy<F extends (keyof T | 'id')[]>(...fields: F): QueryBuilder<T, SelectedFields, TScopes, TTraits, TAggregations, F> {
    this.groupByFields = fields.map(f => this.validateColumnName(String(f)))

    return this as any
  }

  /** Calculates the sum of a field. */
  sum(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, TTraits, TAggregations & { sum: number }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('sum', { func: 'SUM', field: columnName })

    return this as any
  }

  /** Calculates the average of a field. */
  avg(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, TTraits, TAggregations & { avg: number }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('avg', { func: 'AVG', field: columnName })

    return this as any
  }

  /** Finds the minimum value of a field. */
  min(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, TTraits, TAggregations & { min: number | null }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('min', { func: 'MIN', field: columnName })

    return this as any
  }

  /** Finds the maximum value of a field. */
  max(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, TTraits, TAggregations & { max: number | null }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('max', { func: 'MAX', field: columnName })

    return this as any
  }

  /** Counts the number of rows. */
  countAs<Alias extends string = 'count'>(alias: Alias = 'count' as Alias): QueryBuilder<T, SelectedFields, TScopes, TTraits, TAggregations & Record<Alias, number>, TGroupedFields> {
    this.aggregations.set(alias, { func: 'COUNT', field: '*' })

    return this as any
  }

  /** Execute aggregation query */
  async aggregate(): Promise<TAggregations> {
    const aggParts: string[] = []

    for (const [alias, { func, field }] of this.aggregations) {
      aggParts.push(`${func}(${field}) as ${alias}`)
    }

    const selectClause = aggParts.join(', ')
    const query = `SELECT ${selectClause} FROM ${this.tableName} ${this.buildWhereClause()}`
    const start = performance.now()
    let error: Error | undefined

    try {
      const [result] = await this.db.unsafe(query, this.whereParams)

      if (!result)
        return {} as TAggregations

      const converted: TAggregations = {} as TAggregations

      for (const [key, value] of Object.entries(result)) {
        (converted as any)[key] = value !== null ? Number(value) : undefined
      }

      return converted
    }
    catch (err) {
      error = mapDatabaseError(err, this.tableName)
      throw error
    }
    finally {
      const duration = performance.now() - start

      await queryLogger.log({
        query,
        params: this.whereParams,
        duration,
        timestamp: new Date(),
        operation: extractOperation(query),
        table: this.tableName,
        error,
      })
    }
  }

  join(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('INNER', table, leftColumn, operator, rightColumn)
  }

  innerJoin(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('INNER', table, leftColumn, operator, rightColumn)
  }

  leftJoin(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('LEFT', table, leftColumn, operator, rightColumn)
  }

  rightJoin(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('RIGHT', table, leftColumn, operator, rightColumn)
  }

  fullJoin(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('FULL', table, leftColumn, operator, rightColumn)
  }

  private addJoin(type: JoinType, table: string, leftColumn: string, operator: string, rightColumn: string): this {
    validateSQLIdentifier(table, 'table')

    const validOperators = ['=', '!=', '>', '>=', '<', '<=']

    if (!validOperators.includes(operator)) {
      throw new Error(`Invalid JOIN operator: ${operator}`)
    }

    this.joinClauses.push({
      type,
      table,
      leftColumn,
      operator,
      rightColumn,
    })

    return this
  }

  /** Applies a named scope to the query. */
  scope(name: TScopes): QueryBuilder<T, SelectedFields, TScopes, TTraits, TAggregations, TGroupedFields> {
    if (!this.scopes) {
      throw new Error('Scopes are not available on this QueryBuilder instance')
    }

    const scopeFn = this.scopes.get(name)

    if (!scopeFn) {
      throw new Error(`Scope "${name}" not found`)
    }

    return scopeFn(this as any) as any
  }

  limit(value: number): this {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid LIMIT value: ${value}. Must be a non-negative integer.`)
    }

    this.limitValue = value

    return this
  }

  offset(value: number): this {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid OFFSET value: ${value}. Must be a non-negative integer.`)
    }

    this.offsetValue = value

    return this
  }

  cache(ttlSeconds: number): this {
    if (!this.cacheAdapter) {
      throw new Error('Cache adapter not configured. Configure a cache adapter when creating ORM instance: new ORM({ cache: ... }).')
    }

    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`Invalid cache TTL: ${ttlSeconds}. Must be a positive integer (seconds).`)
    }

    this.cacheTtl = ttlSeconds

    return this
  }

  build(): { sql: string, params: SQLValue[] } {
    return {
      sql: this.buildQuery(),
      params: [...this.whereParams],
    }
  }

  async execute(): Promise<
    [keyof TAggregations] extends [never]
      ? [SelectedFields] extends [never]
        ? (QueryResult<T, TTraits>)[]
        : InferProjectionClean<T, SelectedFields>[]
      : (TAggregations & ([TGroupedFields] extends [never]
        ? ([SelectedFields] extends [never] ? {} : InferProjectionClean<T, SelectedFields>)
        : InferProjectionClean<T, TGroupedFields> & ([SelectedFields] extends [never] ? {} : InferProjectionClean<T, SelectedFields>))
      )[]
  > {
    const { sql, params } = this.build()

    if (this.cacheTtl && this.cacheAdapter) {
      const cacheKey = hashCacheKey(sql, params, this.schemaName)
      const cached = await this.cacheAdapter.get<any[]>(cacheKey)

      if (cached) {
        return cached
      }

      const start = performance.now()
      let error: Error | undefined

      try {
        const results = await this.db.unsafe(sql, params)
        const processedResults = this.processResults(results)

        await this.cacheAdapter.set(cacheKey, processedResults, this.cacheTtl)

        return processedResults
      }
      catch (err) {
        error = mapDatabaseError(err, this.tableName)
        throw error
      }
      finally {
        const duration = performance.now() - start

        await queryLogger.log({
          query: sql,
          params,
          duration,
          timestamp: new Date(),
          operation: extractOperation(sql),
          table: this.tableName,
          error,
        })
      }
    }

    const start = performance.now()
    let error: Error | undefined

    try {
      const results = await this.db.unsafe(sql, params)
      const entities = this.processResults(results)

      return entities
    }
    catch (err) {
      error = mapDatabaseError(err, this.tableName)
      throw error
    }
    finally {
      const duration = performance.now() - start

      await queryLogger.log({
        query: sql,
        params,
        duration,
        timestamp: new Date(),
        operation: extractOperation(sql),
        table: this.tableName,
        error,
      })
    }
  }

  private processResults(results: DatabaseRow[]): any[] {
    if (this.aggregations.size > 0) {
      return results.map((row: DatabaseRow) => {
        const converted: any = {}

        for (const [alias, { func: _func, field: _field }] of this.aggregations) {
          if (row[alias] !== null && row[alias] !== undefined) {
            converted[alias] = Number(row[alias])
          }
        }

        if (this.groupByFields.length > 0) {
          for (const field of this.groupByFields) {
            let fieldName = field

            for (const [key, _config] of Object.entries(this.schema)) {
              if (this.getColumnName(key) === field) {
                fieldName = key

                break
              }
            }
            converted[fieldName] = row[field]
          }
        }

        return converted as TAggregations
      })
    }

    if (this.joinClauses.length > 0 && this.hasCustomSelect) {
      return results as any
    }

    if (this.mapper) {
      return results.map((row: DatabaseRow) => this.mapper!(row))
    }

    return results as any
  }

  async findOne(): Promise<
    [SelectedFields] extends [never]
      ? QueryResult<T, TTraits> | null
      : InferProjectionClean<T, SelectedFields> | null
  > {
    this.limit(1)
    const results = await this.execute()

    return (results[0] || null) as any
  }

  async count(): Promise<number> {
    const query = `SELECT COUNT(id) as count FROM ${this.tableName} ${this.buildWhereClause()}`
    const start = performance.now()
    let error: Error | undefined

    try {
      const [result] = await this.db.unsafe(query, this.whereParams)

      return Number(result.count)
    }
    catch (err) {
      error = mapDatabaseError(err, this.tableName)
      throw error
    }
    finally {
      const duration = performance.now() - start

      await queryLogger.log({
        query,
        params: this.whereParams,
        duration,
        timestamp: new Date(),
        operation: 'SELECT',
        table: this.tableName,
        error,
      })
    }
  }

  async latest(field: keyof T | 'id' = 'id'): Promise<
    [SelectedFields] extends [never]
      ? QueryResult<T, TTraits> | null
      : InferProjectionClean<T, SelectedFields> | null
  > {
    return this.orderByDesc(field).findOne() as any
  }

  async oldest(field: keyof T | 'id' = 'id'): Promise<
    [SelectedFields] extends [never]
      ? QueryResult<T, TTraits> | null
      : InferProjectionClean<T, SelectedFields> | null
  > {
    return this.orderBy(field, 'ASC').findOne() as any
  }

  async random(limitValue = 1): Promise<[SelectedFields] extends [never] ? InferEntity<T>[] : InferProjectionClean<T, SelectedFields>[]> {
    if (!Number.isInteger(limitValue) || limitValue < 1) {
      throw new Error(`Invalid random limit: ${limitValue}. Must be a positive integer.`)
    }

    const selectClause = this.selectFields.join(', ')
    const limitPlaceholder = this.addParam(limitValue)
    const query = `SELECT ${selectClause} FROM ${this.tableName} ${this.buildWhereClause()} ORDER BY RANDOM() LIMIT ${limitPlaceholder}`
    const start = performance.now()
    let error: Error | undefined

    try {
      const results = await this.db.unsafe(query, this.whereParams)

      return results as any
    }
    catch (err) {
      error = mapDatabaseError(err, this.tableName)
      throw error
    }
    finally {
      const duration = performance.now() - start

      await queryLogger.log({
        query,
        params: this.whereParams,
        duration,
        timestamp: new Date(),
        operation: 'SELECT',
        table: this.tableName,
        error,
      })
    }
  }

  async update(data: InferUpdateData<T>): Promise<number> {
    if (Object.keys(data).length === 0) {
      throw new Error('Update data cannot be empty')
    }

    const setParts: string[] = []
    const updateParams: SQLValue[] = [...this.whereParams]

    for (const [key, value] of Object.entries(data)) {
      const columnName = this.validateColumnName(key)

      updateParams.push(value as SQLValue)
      setParts.push(`${columnName} = $${updateParams.length}`)
    }

    const query = `UPDATE ${this.tableName} SET ${setParts.join(', ')} ${this.buildWhereClause()} RETURNING id`
    const start = performance.now()
    let error: Error | undefined

    try {
      const result = await this.db.unsafe(query, updateParams)

      return result.length
    }
    catch (err) {
      error = mapDatabaseError(err, this.tableName)
      throw error
    }
    finally {
      const duration = performance.now() - start

      await queryLogger.log({
        query,
        params: updateParams,
        duration,
        timestamp: new Date(),
        operation: 'UPDATE',
        table: this.tableName,
        error,
      })
    }
  }

  async deleteMany(): Promise<number> {
    const whereClause = this.buildWhereClause()

    if (!whereClause) {
      throw new Error('DELETE without WHERE clause is not allowed. Use deleteMany([ids]) on repository for bulk deletes.')
    }

    const query = `DELETE FROM ${this.tableName} ${whereClause} RETURNING id`
    const start = performance.now()
    let error: Error | undefined

    try {
      const result = await this.db.unsafe(query, this.whereParams)

      return result.length
    }
    catch (err) {
      error = mapDatabaseError(err, this.tableName)
      throw error
    }
    finally {
      const duration = performance.now() - start

      await queryLogger.log({
        query,
        params: this.whereParams,
        duration,
        timestamp: new Date(),
        operation: 'DELETE',
        table: this.tableName,
        error,
      })
    }
  }

  async paginate(options: {
    page: number
    limit: number
  }): Promise<{
    data: [keyof TAggregations] extends [never]
      ? [SelectedFields] extends [never]
        ? (QueryResult<T, TTraits>)[]
        : InferProjectionClean<T, SelectedFields>[]
      : (TAggregations & ([TGroupedFields] extends [never]
        ? ([SelectedFields] extends [never] ? {} : InferProjectionClean<T, SelectedFields>)
        : InferProjectionClean<T, TGroupedFields> & ([SelectedFields] extends [never] ? {} : InferProjectionClean<T, SelectedFields>))
      )[]
    meta: {
      total: number
      page: number
      pageSize: number
      totalPages: number
    }
  }> {
    const { page, limit } = options

    if (!Number.isInteger(page) || page < 1) {
      throw new Error(`Invalid page number: ${page}. Must be a positive integer.`)
    }

    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Invalid page size: ${limit}. Must be a positive integer.`)
    }

    const total = await this.count()
    const totalPages = Math.ceil(total / limit)
    const offsetValue = (page - 1) * limit

    this.limitValue = limit
    this.offsetValue = offsetValue

    const data = await this.execute()

    return {
      data,
      meta: {
        total,
        page,
        pageSize: limit,
        totalPages,
      },
    }
  }

  private buildQuery(): string {
    let selectClause: string

    if (this.aggregations.size > 0) {
      const aggParts: string[] = []

      if (this.groupByFields.length > 0) {
        aggParts.push(...this.groupByFields)
      }

      for (const [alias, { func, field }] of this.aggregations) {
        aggParts.push(`${func}(${field}) as ${alias}`)
      }

      selectClause = aggParts.join(', ')
    }
    else {
      selectClause = this.selectFields.join(', ')
    }

    let query = `SELECT ${selectClause} FROM ${this.tableName}`

    if (this.joinClauses.length > 0) {
      for (const join of this.joinClauses) {
        query += ` ${join.type} JOIN ${join.table} ON ${join.leftColumn} ${join.operator} ${join.rightColumn}`
      }
    }

    const whereClause = this.buildWhereClause()

    if (whereClause) {
      query += ` ${whereClause}`
    }

    if (this.groupByFields.length > 0) {
      query += ` GROUP BY ${this.groupByFields.join(', ')}`
    }

    if (this.orderByFields.length > 0) {
      const orderClauses = this.orderByFields.map(o => `${o.field} ${o.direction}`).join(', ')

      query += ` ORDER BY ${orderClauses}`
    }

    if (this.limitValue !== undefined) {
      const limitParam = this.addParam(this.limitValue)

      query += ` LIMIT ${limitParam}`
    }

    if (this.offsetValue !== undefined) {
      const offsetParam = this.addParam(this.offsetValue)

      query += ` OFFSET ${offsetParam}`
    }

    return query
  }
}
