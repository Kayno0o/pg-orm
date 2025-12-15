import type { SQL } from 'bun'
import type { CacheAdapter } from './cache'
import type { BelongsToConfig, HasOneConfig, RelationConfig, RelationSchema } from './relations/types'
import type { DatabaseRow, EntityDefinition, EntitySchema, InferEntity, InferProjectionClean, InferUpdateData, OrderDirection, QueryResult, ScopeDefinition, SQLValue } from './types'
import { toSnake } from '@kaynooo/utils'
import { hashCacheKey } from './cache'
import { InvalidColumnError } from './errors'
import { extractOperation, queryLogger } from './logger'
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

interface JoinedRelationMetadata {
  relationName: string
  config: BelongsToConfig | HasOneConfig
  tableName: string
  alias: string
  schema: EntitySchema
  columnNameMap: Map<string, string>
}

/**
 * Builder for constructing and executing type-safe SQL queries.
 */
export class QueryBuilder<
  T extends EntitySchema,
  SelectedFields extends readonly (keyof T | 'id' | string)[] = never,
  TScopes extends string = never,
  LoadedRelations extends Record<string, any> = {},
  TTraits extends readonly any[] = readonly [],
  TRelations extends RelationSchema = RelationSchema,
  TAggregations extends Record<string, any> = {},
  TGroupedFields extends readonly (keyof T | 'id')[] = never,
> {
  private selectFields: string[]
  private whereConditions: string[] = []
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
  private joinedRelations = new Map<string, JoinedRelationMetadata>()
  private pendingEagerLoads = new Map<string, RelationConfig>()

  // eslint-disable-next-line max-params
  constructor(
    private tableName: string,
    private db: SQL,
    private schema: T,
    private mapper?: (row: DatabaseRow) => any,
    scopes?: Map<string, ScopeDefinition<T>>,
    cacheAdapter?: CacheAdapter,
    schemaName?: string,
    private entity?: EntityDefinition<T, any, any, any>,
    private orm?: any,
  ) {
    validateSQLIdentifier(tableName, 'table')
    this.selectFields = [`${tableName}.*`]
    this.validColumns = new Set(['id', ...Object.keys(schema).map(k => this.getColumnName(k))])
    this.scopes = scopes
    this.cacheAdapter = cacheAdapter
    this.schemaName = schemaName
  }

  private getColumnName(fieldName: string): string {
    if (fieldName === 'id')
      return 'id'

    const fieldConfig = this.schema[fieldName]

    if (fieldConfig && 'columnName' in fieldConfig && typeof fieldConfig.columnName === 'string') {
      return fieldConfig.columnName
    }

    return toSnake(fieldName)
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

  private resolveDotNotation(fieldPath: string): string {
    if (!fieldPath.includes('.')) {
      return this.validateColumnName(fieldPath)
    }

    const parts = fieldPath.split('.')

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid field path "${fieldPath}". `
        + 'Use format "relationName.fieldName" or just "fieldName"',
      )
    }

    const relationName = parts[0]
    const fieldName = parts[1]

    // Check if this relation is being eagerly loaded (hasMany/manyToMany)
    if (this.pendingEagerLoads.has(relationName)) {
      const relationConfig = this.pendingEagerLoads.get(relationName)!

      throw new Error(
        `Cannot filter or sort by "${fieldPath}". `
        + `Relation "${relationName}" is type "${relationConfig.type}" which doesn't support WHERE/ORDER BY clauses. `
        + `Only belongsTo and hasOne relations (using SQL JOINs) support filtering/sorting. `
        + `Use a subquery or filter in application code instead.`,
      )
    }

    const joinedRelation = this.joinedRelations.get(relationName)

    if (!joinedRelation) {
      throw new Error(
        `Cannot query field "${fieldPath}". `
        + `Relation "${relationName}" not joined. `
        + `Call .with('${relationName}') first.`,
      )
    }

    const columnName = joinedRelation.columnNameMap.get(fieldName)

    if (!columnName) {
      const available = Array.from(joinedRelation.columnNameMap.keys())

      throw new Error(
        `Field "${fieldName}" not found on relation "${relationName}". `
        + `Available fields: ${available.join(', ')}`,
      )
    }

    return `${joinedRelation.alias}.${columnName}`
  }

  private addParam(value: SQLValue): string {
    this.whereParams.push(value)

    return `$${this.whereParams.length}`
  }

  /**
   * Selects specific fields to return.
   * Supports dot notation for joined relations (e.g., 'author.name').
   * @param fields - The fields to select.
   * Note: Custom select disables relation type inference.
   */
  select<F extends readonly (keyof T | 'id' | string)[]>(
    ...fields: F

  ): QueryBuilder<T, F, TScopes, {}, TTraits, TRelations, TAggregations, TGroupedFields> {
    this.hasCustomSelect = true
    this.selectFields = fields.map((f) => {
      const fieldStr = String(f)

      if (fieldStr.includes('.')) {
        const parts = fieldStr.split('.')

        if (parts.length === 2 && parts[0] && parts[1]) {
          const relation = parts[0]
          const joinedRel = this.joinedRelations.get(relation)

          if (joinedRel) {
            const columnRef = this.resolveDotNotation(fieldStr)
            const field = parts[1]
            const columnName = joinedRel.columnNameMap.get(field)

            if (columnName) {
              return `${columnRef} AS ${relation}__${columnName}`
            }
          }
        }

        return fieldStr
      }

      return this.validateColumnName(fieldStr)
    })

    return this as any
  }

  /**
   * Adds a WHERE clause.
   * Supports dot notation for joined relations (e.g., 'author.role').
   * @param field - The field to check.
   * @param operator - The comparison operator.
   * @param value - The value to compare against.
   */
  where(field: keyof T | 'id' | string, operator: string, value: SQLValue): this {
    const fieldStr = String(field)
    const columnName = fieldStr.includes('.')
      ? this.resolveDotNotation(fieldStr)
      : this.validateColumnName(fieldStr)
    const placeholder = this.addParam(value)

    this.whereConditions.push(`${columnName} ${operator} ${placeholder}`)

    return this
  }

  /**
   * Adds a WHERE clause checking for equality.
   */
  whereEquals(field: keyof T | 'id', value: SQLValue): this {
    return this.where(field, '=', value)
  }

  /**
   * Adds a WHERE IN clause.
   */
  whereIn(field: keyof T | 'id', values: SQLValue[]): this {
    if (values.length === 0) {
      // Empty IN clause always returns false
      this.whereConditions.push('FALSE')

      return this
    }

    const columnName = this.validateColumnName(String(field))
    const placeholders = values.map(v => this.addParam(v)).join(', ')

    this.whereConditions.push(`${columnName} IN (${placeholders})`)

    return this
  }

  /**
   * Adds a WHERE NOT IN clause.
   */
  whereNotIn(field: keyof T | 'id', values: SQLValue[]): this {
    if (values.length === 0) {
      // Empty NOT IN clause always returns true
      return this
    }

    const columnName = this.validateColumnName(String(field))
    const placeholders = values.map(v => this.addParam(v)).join(', ')

    this.whereConditions.push(`${columnName} NOT IN (${placeholders})`)

    return this
  }

  /**
   * Adds a WHERE LIKE clause.
   */
  whereLike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'LIKE', pattern)
  }

  /**
   * Adds a WHERE ILIKE (case-insensitive) clause.
   */
  whereILike(field: keyof T | 'id', pattern: string): this {
    return this.where(field, 'ILIKE', pattern)
  }

  /**
   * Adds a WHERE IS NULL clause.
   */
  whereNull(field: keyof T | 'id'): this {
    const columnName = this.validateColumnName(String(field))

    this.whereConditions.push(`${columnName} IS NULL`)

    return this
  }

  /**
   * Adds a WHERE IS NOT NULL clause.
   */
  whereNotNull(field: keyof T | 'id'): this {
    const columnName = this.validateColumnName(String(field))

    this.whereConditions.push(`${columnName} IS NOT NULL`)

    return this
  }

  /**
   * Adds a WHERE BETWEEN clause.
   */
  whereBetween(field: keyof T | 'id', min: SQLValue, max: SQLValue): this {
    const columnName = this.validateColumnName(String(field))
    const minPlaceholder = this.addParam(min)
    const maxPlaceholder = this.addParam(max)

    this.whereConditions.push(`${columnName} BETWEEN ${minPlaceholder} AND ${maxPlaceholder}`)

    return this
  }

  // PostgreSQL-specific operators

  /**
   * Adds a JSON containment check (@>).
   */
  whereJsonContains(field: keyof T, value: unknown): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(JSON.stringify(value))

    this.whereConditions.push(`${columnName} @> ${placeholder}::jsonb`)

    return this
  }

  /**
   * Adds a JSON key existence check (?).
   */
  whereJsonHasKey(field: keyof T, key: string): this {
    const columnName = this.validateColumnName(String(field))
    const placeholder = this.addParam(key)

    this.whereConditions.push(`${columnName} ? ${placeholder}`)

    return this
  }

  /**
   * Adds an array containment check (= ANY).
   */
  whereArrayContains(field: keyof T, value: SQLValue): this {
    const columnName = this.validateColumnName(String(field))

    // For array operations, we need to pass the array value directly and let PostgreSQL handle it
    // This is secure because the value goes through parameterization
    const placeholder = this.addParam([value])

    // Use ANY for checking if array contains value (more secure than string formatting)
    this.whereConditions.push(`${placeholder} = ANY(${columnName})`)

    return this
  }

  /**
   * Adds an array overlap check (&&).
   */
  whereArrayOverlaps(field: keyof T, values: SQLValue[]): this {
    const columnName = this.validateColumnName(String(field))

    // For array overlap, pass array directly through parameterization
    const placeholder = this.addParam(values)

    this.whereConditions.push(`${columnName} && ${placeholder}`)

    return this
  }

  /**
   * Adds an ORDER BY clause.
   * Supports dot notation for joined relations (e.g., 'author.name').
   */
  orderBy(field: keyof T | 'id' | string, direction: OrderDirection = 'ASC'): this {
    const fieldStr = String(field)
    const columnName = fieldStr.includes('.')
      ? this.resolveDotNotation(fieldStr)
      : this.validateColumnName(fieldStr)

    // Validate direction to prevent SQL injection
    if (direction !== 'ASC' && direction !== 'DESC') {
      throw new Error(`Invalid ORDER BY direction: ${direction}. Must be ASC or DESC.`)
    }

    this.orderByFields.push({ field: columnName, direction })

    return this
  }

  /** Adds an ORDER BY DESC clause. */
  orderByDesc(field: keyof T | 'id' | string): this {
    return this.orderBy(field, 'DESC')
  }

  /** Adds a GROUP BY clause. */
  groupBy<F extends (keyof T | 'id')[]>(...fields: F): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations, TTraits, TRelations, TAggregations, F> {
    this.groupByFields = fields.map(f => this.validateColumnName(String(f)))

    return this as any
  }

  /** Calculates the sum of a field. */
  sum(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations, TTraits, TRelations, TAggregations & { sum: number }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('sum', { func: 'SUM', field: columnName })

    return this as any
  }

  /** Calculates the average of a field. */
  avg(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations, TTraits, TRelations, TAggregations & { avg: number }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('avg', { func: 'AVG', field: columnName })

    return this as any
  }

  /** Finds the minimum value of a field. */
  min(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations, TTraits, TRelations, TAggregations & { min: number | null }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('min', { func: 'MIN', field: columnName })

    return this as any
  }

  /** Finds the maximum value of a field. */
  max(field: keyof T): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations, TTraits, TRelations, TAggregations & { max: number | null }, TGroupedFields> {
    const columnName = this.validateColumnName(String(field))

    this.aggregations.set('max', { func: 'MAX', field: columnName })

    return this as any
  }

  /** Counts the number of rows. */
  countAs<Alias extends string = 'count'>(alias: Alias = 'count' as Alias): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations, TTraits, TRelations, TAggregations & Record<Alias, number>, TGroupedFields> {
    this.aggregations.set(alias, { func: 'COUNT', field: '*' })

    return this as any
  }

  /** Execute aggregation query */
  async aggregate(): Promise<TAggregations> {
    // Build aggregation SELECT
    const aggParts: string[] = []

    for (const [alias, { func, field }] of this.aggregations) {
      aggParts.push(`${func}(${field}) as ${alias}`)
    }

    const selectClause = aggParts.join(', ')
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

    // SECURITY AUDIT: Query is constructed from validated components:
    // - selectClause: aggParts built from validated aggregations (func/field validated in aggregate() method)
    // - tableName: validated in constructor via validateSQLIdentifier()
    // - whereConditions: built with parameterized placeholders ($N) in where() methods
    // - whereParams: actual values passed separately to prevent SQL injection
    const query = `SELECT ${selectClause} FROM ${this.tableName} ${whereClause}`
    const start = performance.now()
    let error: Error | undefined

    try {
      const [result] = await this.db.unsafe(query, this.whereParams)

      if (!result)
        return {} as TAggregations

      // Convert string numbers to actual numbers
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

  /** Adds a JOIN clause. */
  join(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('INNER', table, leftColumn, operator, rightColumn)
  }

  /** Adds an INNER JOIN clause. */
  innerJoin(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('INNER', table, leftColumn, operator, rightColumn)
  }

  /** Adds a LEFT JOIN clause. */
  leftJoin(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('LEFT', table, leftColumn, operator, rightColumn)
  }

  /** Adds a RIGHT JOIN clause. */
  rightJoin(table: string, leftColumn: string, operator: string, rightColumn: string): this {
    return this.addJoin('RIGHT', table, leftColumn, operator, rightColumn)
  }

  /** Adds a FULL JOIN clause. */
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

  /**
   * Loads a relation using intelligent strategy:
   * - belongsTo/hasOne: SQL JOIN (allows filtering/sorting)
   * - hasMany/manyToMany: Separate batched query
   * @param relationName - The name of the relation to load.
   * @example
   * // With explicit type
   * .with<Author>('author')
   *
   * // Without explicit type (defaults to any)
   * .with('author')
   */
  // eslint-disable-next-line max-lines-per-function
  with<RelationType = any, K extends string = string>(
    relationName: K,
  ): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations & Record<K, RelationType>, TTraits, TRelations, TAggregations, TGroupedFields> {
    if (!this.entity || !this.orm) {
      throw new Error(
        'with() requires entity metadata. '
        + 'Ensure QueryBuilder was created via repository.query()',
      )
    }

    if (this.joinedRelations.has(relationName) || this.pendingEagerLoads.has(relationName)) {
      throw new Error(
        `Relation "${relationName}" already loaded. `
        + 'Cannot load the same relation multiple times.',
      )
    }

    const relationConfig = this.entity.relations?.[relationName]

    if (!relationConfig) {
      const available = Object.keys(this.entity.relations || {})

      throw new Error(
        `Relation "${relationName}" not found on ${this.tableName}. ${
          available.length > 0
            ? `Available relations: ${available.join(', ')}`
            : 'No relations defined on this entity.'}`,
      )
    }

    if (relationConfig.type === 'hasMany' || relationConfig.type === 'manyToMany') {
      this.pendingEagerLoads.set(relationName, relationConfig)

      return this as any
    }

    const relatedEntity = this.orm.getEntityByTable(relationConfig.tableName)

    if (!relatedEntity) {
      throw new Error(
        `Related entity "${relationConfig.tableName}" not registered. `
        + 'Did you call .build() on it?',
      )
    }

    const columnNameMap = new Map<string, string>()

    columnNameMap.set('id', 'id')
    for (const fieldName of Object.keys(relatedEntity.schema)) {
      const fieldConfig = relatedEntity.schema[fieldName]
      const columnName = fieldConfig?.columnName || toSnake(fieldName)

      columnNameMap.set(fieldName, columnName)
    }

    const alias = relationName

    this.joinedRelations.set(relationName, {
      relationName,
      config: relationConfig,
      tableName: relationConfig.tableName,
      alias,
      schema: relatedEntity.schema,
      columnNameMap,
    })

    validateSQLIdentifier(relationConfig.tableName, 'table')
    validateSQLIdentifier(alias, 'table')

    if (relationConfig.type === 'belongsTo') {
      const foreignKeyColumn = this.getColumnName(relationConfig.foreignKey)
      const ownerKey = relationConfig.ownerKey || 'id'

      this.joinClauses.push({
        type: 'LEFT',
        table: `${relationConfig.tableName} AS ${alias}`,
        leftColumn: `${this.tableName}.${foreignKeyColumn}`,
        operator: '=',
        rightColumn: `${alias}.${ownerKey}`,
      })
    }
    else if (relationConfig.type === 'hasOne') {
      const foreignKeyColumn = toSnake(relationConfig.foreignKey)

      this.joinClauses.push({
        type: 'LEFT',
        table: `${relationConfig.tableName} AS ${alias}`,
        leftColumn: `${this.tableName}.id`,
        operator: '=',
        rightColumn: `${alias}.${foreignKeyColumn}`,
      })
    }

    if (!this.hasCustomSelect) {
      const relatedColumns = ['id', ...Object.keys(relatedEntity.schema)]
        .map((field) => {
          const columnName = columnNameMap.get(field)!

          return `${alias}.${columnName} AS ${alias}__${columnName}`
        })

      this.selectFields.push(...relatedColumns)
    }

    return this as any
  }

  /** Applies a named scope to the query. */
  scope(name: TScopes): QueryBuilder<T, SelectedFields, TScopes, LoadedRelations, TTraits, TRelations, TAggregations, TGroupedFields> {
    if (!this.scopes) {
      throw new Error('Scopes are not available on this QueryBuilder instance')
    }

    const scopeFn = this.scopes.get(name)

    if (!scopeFn) {
      throw new Error(`Scope "${name}" not found`)
    }

    return scopeFn(this as any) as any
  }

  /** Sets the limit for the query. */
  limit(value: number): this {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid LIMIT value: ${value}. Must be a non-negative integer.`)
    }

    this.limitValue = value

    return this
  }

  /** Sets the offset for the query. */
  offset(value: number): this {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`Invalid OFFSET value: ${value}. Must be a non-negative integer.`)
    }

    this.offsetValue = value

    return this
  }

  /** Sets the cache TTL for the query results. */
  cache(ttlSeconds: number): this {
    if (!this.cacheAdapter) {
      throw new Error('Cache adapter not configured. Configure a cache adapter in orm.connect({ cache: ... }).')
    }

    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`Invalid cache TTL: ${ttlSeconds}. Must be a positive integer (seconds).`)
    }

    this.cacheTtl = ttlSeconds

    return this
  }

  /** Builds the SQL query and parameters. */
  build(): { sql: string, params: SQLValue[] } {
    return {
      sql: this.buildQuery(),
      params: [...this.whereParams],
    }
  }

  /** Executes the query and returns the results. */
  async execute(): Promise<
    [keyof TAggregations] extends [never]
      ? [SelectedFields] extends [never]
        ? (QueryResult<T, TRelations, LoadedRelations, TTraits>)[]
        : InferProjectionClean<T, SelectedFields>[]
      : (TAggregations & ([TGroupedFields] extends [never]
        ? ([SelectedFields] extends [never] ? {} : InferProjectionClean<T, SelectedFields>)
        : InferProjectionClean<T, TGroupedFields> & ([SelectedFields] extends [never] ? {} : InferProjectionClean<T, SelectedFields>))
      )[]
  > {
    const { sql, params } = this.build()

    // Check cache if enabled
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

        // Load hasMany/manyToMany relations if any
        if (this.pendingEagerLoads.size > 0 && processedResults.length > 0) {
          await this.loadEagerRelations(processedResults)
        }

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
      // SECURITY AUDIT: SQL is built by build() method with:
      // - Validated column names (via validateColumnName())
      // - Parameterized WHERE values (params array passed separately)
      // - Validated ORDER BY fields (via validateColumnName())
      // - Parameterized LIMIT/OFFSET values
      const results = await this.db.unsafe(sql, params)
      const entities = this.processResults(results)

      // Load hasMany/manyToMany relations if any
      if (this.pendingEagerLoads.size > 0 && entities.length > 0) {
        await this.loadEagerRelations(entities)
      }

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

  private async loadEagerRelations(entities: any[]): Promise<void> {
    if (!this.entity || !this.orm)
      return

    const { RelationLoader } = await import('./relations/loader')
    const loader = new RelationLoader(
      this.db,
      this.orm,
      this.entity,
      (entityDef: any) => this.orm!.repo(entityDef),
    )

    const relationNames = Array.from(this.pendingEagerLoads.keys())

    await loader.loadRelations(entities, relationNames)
  }

  private transformJoinedRow(row: DatabaseRow): any {
    const baseFields: Record<string, unknown> = {}
    const relationFields = new Map<string, Record<string, unknown>>()

    for (const [key, value] of Object.entries(row)) {
      const [part1, part2] = key.split('__')

      if (part1 && part2) {
        const relationName = part1
        const columnName = part2

        if (!relationFields.has(relationName)) {
          relationFields.set(relationName, {})
        }

        relationFields.get(relationName)![columnName] = value
      }
      else {
        baseFields[key] = value
      }
    }

    const baseEntity = this.mapper ? this.mapper(baseFields) : baseFields

    for (const [relationName, fields] of relationFields) {
      const joinedRelation = this.joinedRelations.get(relationName)!

      const isNull = Object.values(fields).every(v => v === null)

      if (isNull) {
        baseEntity[relationName] = null

        continue
      }

      const relationEntity: Record<string, unknown> = {}

      for (const [columnName, value] of Object.entries(fields)) {
        let fieldName = columnName

        for (const [field, col] of joinedRelation.columnNameMap) {
          if (col !== columnName)
            continue

          fieldName = field

          break
        }

        relationEntity[fieldName] = value
      }

      baseEntity[relationName] = this.mapRelatedEntity(
        relationEntity,
        joinedRelation.schema,
      )
    }

    return baseEntity
  }

  private mapRelatedEntity(
    data: Record<string, unknown>,
    schema: EntitySchema,
  ): any {
    const mapped: Record<string, unknown> = { ...data }

    for (const [fieldName, value] of Object.entries(data)) {
      const fieldConfig = schema[fieldName]

      if (!fieldConfig)
        continue

      if (fieldConfig.type === 'array' && typeof value === 'string') {
        mapped[fieldName] = this.parsePostgresArray(value)
      }
      else if ((fieldConfig.type === 'timestamp' || fieldConfig.type === 'date') && value) {
        mapped[fieldName] = new Date(value as string)
      }
      else if ((fieldConfig.type === 'json' || fieldConfig.type === 'jsonb') && typeof value === 'string') {
        mapped[fieldName] = JSON.parse(value)
      }
    }

    return mapped
  }

  private parsePostgresArray(pgArray: string): any[] {
    if (!pgArray || pgArray === '{}')
      return []

    const inner = pgArray.slice(1, -1)

    if (!inner)
      return []

    return inner.split(',').map((s) => {
      const trimmed = s.trim()

      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\"/g, '"')
      }

      return trimmed
    })
  }

  private processResults(results: DatabaseRow[]): any[] {
    // If aggregations are present, don't use mapper (aggregation results are plain objects)
    if (this.aggregations.size > 0) {
      // Convert string numbers from aggregations to actual numbers
      return results.map((row: DatabaseRow) => {
        const converted: any = {}

        for (const [alias, { func: _func, field: _field }] of this.aggregations) {
          if (row[alias] !== null && row[alias] !== undefined) {
            converted[alias] = Number(row[alias])
          }
        }

        if (this.groupByFields.length > 0) {
          // For grouped fields, we need to map column names back to field names if possible
          // But since we don't have the reverse map here easily, and usually group by
          // uses the field name alias if provided in select, or just the column name.
          // However, QueryBuilder methods take field names and convert to column names.
          // The result row has column names.
          // We can iterate schema to find the field name for the column.

          for (const field of this.groupByFields) {
            // 'field' here is the column name (converted in groupBy method)
            // We try to find a field config that matches this column name
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

    // NEW: Transform joined results into nested objects
    if (this.joinedRelations.size > 0) {
      return results.map(row => this.transformJoinedRow(row))
    }

    // If JOINs are present AND user has explicitly selected cross-table fields, return raw results
    // Otherwise, if JOINs are present but user hasn't selected anything, we still use mapper
    // because we defaulted to selecting tableName.*, which matches the Entity schema
    if (this.joinClauses.length > 0 && this.hasCustomSelect) {
      return results as any
    }

    // Use mapper if provided to properly convert database rows to entities
    // This ensures arrays are parsed, dates are converted, and trait methods work
    if (this.mapper) {
      return results.map((row: DatabaseRow) => this.mapper!(row))
    }

    // Fallback to raw results (won't have trait methods or proper array/date handling)
    return results as any
  }

  /** Executes the query and returns the first result or null. */
  async findOne(): Promise<
    [SelectedFields] extends [never]
      ? QueryResult<T, TRelations, LoadedRelations, TTraits> | null
      : InferProjectionClean<T, SelectedFields> | null
  > {
    this.limit(1)
    const results = await this.execute()

    return (results[0] || null) as any
  }

  /** Counts the number of rows matching the query. */
  async count(): Promise<number> {
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

    // SECURITY AUDIT: Query uses validated table name and parameterized WHERE clause (see aggregate() audit)
    const query = `SELECT COUNT(id) as count FROM ${this.tableName} ${whereClause}`
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

  /** Finds the latest record based on a field. */
  async latest(field: keyof T | 'id' = 'id'): Promise<
    [SelectedFields] extends [never]
      ? QueryResult<T, TRelations, LoadedRelations, TTraits> | null
      : InferProjectionClean<T, SelectedFields> | null
  > {
    return this.orderByDesc(field).findOne() as any
  }

  /** Finds the oldest record based on a field. */
  async oldest(field: keyof T | 'id' = 'id'): Promise<
    [SelectedFields] extends [never]
      ? QueryResult<T, TRelations, LoadedRelations, TTraits> | null
      : InferProjectionClean<T, SelectedFields> | null
  > {
    return this.orderBy(field, 'ASC').findOne() as any
  }

  /** Finds random records. */
  async random(limitValue = 1): Promise<[SelectedFields] extends [never] ? InferEntity<T>[] : InferProjectionClean<T, SelectedFields>[]> {
    if (!Number.isInteger(limitValue) || limitValue < 1) {
      throw new Error(`Invalid random limit: ${limitValue}. Must be a positive integer.`)
    }

    const selectClause = this.selectFields.join(', ')
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

    const limitPlaceholder = this.addParam(limitValue)
    // SECURITY AUDIT: Query uses validated components with parameterized LIMIT (see aggregate() audit)
    const query = `SELECT ${selectClause} FROM ${this.tableName} ${whereClause} ORDER BY RANDOM() LIMIT ${limitPlaceholder}`
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

  /** Updates records matching the query. */
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

    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

    const query = `UPDATE ${this.tableName} SET ${setParts.join(', ')} ${whereClause} RETURNING id`
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

  /** Deletes records matching the query. */
  async deleteMany(): Promise<number> {
    const whereClause = this.whereConditions.length > 0
      ? `WHERE ${this.whereConditions.join(' AND ')}`
      : ''

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

  /** Paginates the query results. */
  async paginate(options: {
    page: number
    limit: number
  }): Promise<{
    data: [keyof TAggregations] extends [never]
      ? [SelectedFields] extends [never]
        ? (QueryResult<T, TRelations, LoadedRelations, TTraits>)[]
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

  /** Builds the SQL query string internally. */
  private buildQuery(): string {
    // Handle aggregation SELECT
    let selectClause: string

    if (this.aggregations.size > 0) {
      const aggParts: string[] = []

      // Add GROUP BY fields first
      if (this.groupByFields.length > 0) {
        aggParts.push(...this.groupByFields)
      }

      // Add aggregations
      for (const [alias, { func, field }] of this.aggregations) {
        aggParts.push(`${func}(${field}) as ${alias}`)
      }

      selectClause = aggParts.join(', ')
    }
    else {
      selectClause = this.selectFields.join(', ')
    }

    let query = `SELECT ${selectClause} FROM ${this.tableName}`

    // Add JOIN clauses
    if (this.joinClauses.length > 0) {
      for (const join of this.joinClauses) {
        query += ` ${join.type} JOIN ${join.table} ON ${join.leftColumn} ${join.operator} ${join.rightColumn}`
      }
    }

    if (this.whereConditions.length > 0) {
      query += ` WHERE ${this.whereConditions.join(' AND ')}`
    }

    if (this.groupByFields.length > 0) {
      query += ` GROUP BY ${this.groupByFields.join(', ')}`
    }

    if (this.orderByFields.length > 0) {
      const orderClauses = this.orderByFields.map(o => `${o.field} ${o.direction}`).join(', ')

      query += ` ORDER BY ${orderClauses}`
    }

    // LIMIT and OFFSET are now parameterized for security
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
