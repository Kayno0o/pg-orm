import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { Database, Executable, SavepointClient, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelationDef, AnyRelations, AnyTableDef, AnyVirtuals, InferInsert, InferSelect, InferUpdate } from '../types/index'
import { DeleteBuilder, InsertBuilder, MergeBuilder, SelectBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { hasHooks, runHooks } from '../hooks/index'
import { getOrCompileMapper, mapChunk } from '../mapper/index'

// --- Repository ---

export class Repository<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  private _table: AnyTableDef
  private _executor: Executable
  private _tableRegistry?: ReadonlyMap<string, AnyTableDef>

  constructor(
    table: AnyTableDef,
    executor: Executable,
    tableRegistry?: ReadonlyMap<string, AnyTableDef>,
  ) {
    this._table = table
    this._executor = executor
    this._tableRegistry = tableRegistry
  }

  using(tx: TransactionClient | SavepointClient | Database): Repository<TColumns, TRelations, TVirtuals> {
    return new Repository<TColumns, TRelations, TVirtuals>(this._table, tx as Executable, this._tableRegistry)
  }

  // --- Query methods (callback-style) ---

  async findMany(): Promise<InferSelect<TColumns>[]>
  async findMany<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<TResult[]>
  async findMany(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<any[]> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
    const finalBuilder = cb ? cb(builder) : builder
    const { sql, params } = finalBuilder.toSQL()
    const rows = await this._query(sql, params)

    const mapper = this._getMapper(finalBuilder)
    let mapped = mapChunk(mapper, rows)

    if (hasHooks(this._table, 'afterSelect')) {
      mapped = runHooks(this._table, 'afterSelect', mapped)
    }

    // Apply virtuals
    mapped = this._applyVirtuals(mapped)

    // Handle .include() — batched relation loading (no N+1)
    if (finalBuilder._state.includes.length > 0) {
      mapped = await this._loadIncludes(mapped, finalBuilder._state.includes)
    }

    return mapped
  }

  async findOne(): Promise<InferSelect<TColumns> | null>
  async findOne<TResult>(
    cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>,
  ): Promise<TResult | null>
  async findOne(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
  ): Promise<any | null> {
    const wrappedCb = cb
      ? (q: SelectBuilder<TColumns, TRelations>) => cb(q).limit(1) as SelectBuilder<TColumns, TRelations, any>
      : (q: SelectBuilder<TColumns, TRelations>) => q.limit(1) as SelectBuilder<TColumns, TRelations, any>
    const rows = await this.findMany(wrappedCb)

    return rows[0] ?? null
  }

  async insertOne(values: InferInsert<TColumns>): Promise<InferSelect<TColumns>> {
    let v = values

    if (hasHooks(this._table, 'beforeInsert')) {
      v = runHooks(this._table, 'beforeInsert', v)
    }

    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    if (hasHooks(this._table, 'afterInsert')) {
      runHooks(this._table, 'afterInsert', undefined)
    }

    return rows[0] as InferSelect<TColumns>
  }

  async insertMany(values: InferInsert<TColumns>[]): Promise<InferSelect<TColumns>[]> {
    let v = values

    if (hasHooks(this._table, 'beforeInsert')) {
      v = v.map(row => runHooks(this._table, 'beforeInsert', row))
    }

    const b = new InsertBuilder<TColumns>(this._table.name)
      .many(v)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    if (hasHooks(this._table, 'afterInsert')) {
      runHooks(this._table, 'afterInsert', undefined)
    }

    return rows as InferSelect<TColumns>[]
  }

  async updateMany(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    let s = set

    if (hasHooks(this._table, 'beforeUpdate')) {
      s = runHooks(this._table, 'beforeUpdate', s)
    }

    const b = new UpdateBuilder<TColumns>(this._table.name)
      .set(s)
      .where(where)
      .returning() as UpdateBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    if (hasHooks(this._table, 'afterUpdate')) {
      runHooks(this._table, 'afterUpdate', undefined)
    }

    return rows as InferSelect<TColumns>[]
  }

  async deleteMany(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    if (hasHooks(this._table, 'beforeDelete')) {
      runHooks(this._table, 'beforeDelete', undefined)
    }

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning() as DeleteBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    if (hasHooks(this._table, 'afterDelete')) {
      runHooks(this._table, 'afterDelete', undefined)
    }

    return rows as InferSelect<TColumns>[]
  }

  // Streaming via async iterator — JIT mapper applied per chunk, not per row.
  async* stream(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
    opts: { chunkSize?: number } = {},
  ): AsyncGenerator<InferSelect<TColumns>, void, undefined> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
    const finalBuilder = cb ? cb(builder) : builder
    const chunkSize = opts.chunkSize ?? 500
    let offset = 0
    const mapper = this._getMapper(finalBuilder)

    while (true) {
      finalBuilder._state.limit = chunkSize
      finalBuilder._state.offset = offset
      const { sql, params } = finalBuilder.toSQL()
      const rows = await this._query(sql, params)

      if (rows.length === 0)
        break

      let mapped = mapChunk(mapper, rows) as InferSelect<TColumns>[]

      mapped = this._applyVirtuals(mapped) as InferSelect<TColumns>[]

      for (const row of mapped) {
        yield row
      }

      if (rows.length < chunkSize)
        break

      offset += chunkSize
    }
  }

  // Builder accessors for advanced usage
  select(): SelectBuilder<TColumns, TRelations> {
    return new SelectBuilder<TColumns, TRelations>(this._table.name)
  }

  insert(): InsertBuilder<TColumns> {
    return new InsertBuilder<TColumns>(this._table.name)
  }

  update(): UpdateBuilder<TColumns> {
    return new UpdateBuilder<TColumns>(this._table.name)
  }

  delete(): DeleteBuilder<TColumns> {
    return new DeleteBuilder<TColumns>(this._table.name)
  }

  merge(): MergeBuilder<TColumns> {
    return new MergeBuilder<TColumns>(this._table.name)
  }

  upsert(): UpsertBuilder<TColumns> {
    return new UpsertBuilder<TColumns>(this._table.name)
  }

  // --- Private helpers ---

  private async _query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return await this._executor.query(sql, params)
  }

  // Get or compile mapper from a select builder's state
  private _getMapper(builder: SelectBuilder<TColumns, TRelations, any>) {
    return getOrCompileMapper(
      this._table.name,
      this._table.columns,
      builder._state.columns ?? undefined,
      builder._state.omitColumns.length ? builder._state.omitColumns : undefined,
    )
  }

  // Apply virtual fields to mapped rows
  private _applyVirtuals<T extends Record<string, unknown>>(rows: T[]): T[] {
    const virtuals = this._table.virtuals

    if (!virtuals || Object.keys(virtuals).length === 0)
      return rows

    for (const row of rows) {
      for (const [key, virt] of Object.entries(virtuals)) {
        ;(row as Record<string, unknown>)[key] = (virt as { compute: (r: unknown) => unknown }).compute(row)
      }
    }

    return rows
  }

  // Resolve a target table by name from the registry
  private _resolveTable(name: string): AnyTableDef | undefined {
    return this._tableRegistry?.get(name)
  }

  // Find primary key column name for a table
  private _findPrimaryKey(table: AnyTableDef): string {
    for (const [name, col] of Object.entries(table.columns)) {
      if ((col as any).constraints.some((c: any) => c.type === 'primary_key'))
        return name
    }

    return 'id'
  }

  // Batched query helper — SELECT * FROM "table" WHERE "col" IN ($1, $2, ...)
  private async _batchQuery(tableName: string, column: string, ids: unknown[]): Promise<Record<string, unknown>[]> {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')

    return this._query(
      `SELECT * FROM "${tableName}" WHERE "${column}" IN (${placeholders})`,
      ids,
    )
  }

  // --- Relation loading strategies ---

  private async _loadBelongsTo(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    relationName: string,
  ): Promise<void> {
    const fk = rel.foreignKey
    const parentIds = parentRows.map(r => r[fk]).filter(v => v != null)

    if (parentIds.length === 0) {
      for (const row of parentRows) row[relationName] = null

      return
    }

    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    const childRows = await this._batchQuery(rel.targetTable, targetPk, parentIds)

    const indexed = new Map<unknown, Record<string, unknown>>()

    for (const child of childRows) indexed.set(child[targetPk], child)

    for (const parent of parentRows) {
      parent[relationName] = indexed.get(parent[fk]) ?? null
    }
  }

  private async _loadHasOneOrMany(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    relationName: string,
  ): Promise<void> {
    const sourcePk = this._findPrimaryKey(this._table)
    const targetFk = rel.foreignKey
    const parentIds = parentRows.map(r => r[sourcePk]).filter(v => v != null)
    const isMany = rel.type === 'hasMany'

    if (parentIds.length === 0) {
      for (const row of parentRows) {
        row[relationName] = isMany ? [] : null
      }

      return
    }

    const childRows = await this._batchQuery(rel.targetTable, targetFk, parentIds)

    if (isMany) {
      const grouped = new Map<unknown, Record<string, unknown>[]>()

      for (const child of childRows) {
        const fk = child[targetFk]

        if (!grouped.has(fk))
          grouped.set(fk, [])

        grouped.get(fk)!.push(child)
      }

      for (const parent of parentRows) {
        parent[relationName] = grouped.get(parent[sourcePk]) ?? []
      }
    }
    else {
      const indexed = new Map<unknown, Record<string, unknown>>()

      for (const child of childRows) indexed.set(child[targetFk], child)

      for (const parent of parentRows) {
        parent[relationName] = indexed.get(parent[sourcePk]) ?? null
      }
    }
  }

  private async _loadHasManyThrough(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    relationName: string,
  ): Promise<void> {
    const sourcePk = this._findPrimaryKey(this._table)
    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    const parentIds = parentRows.map(r => r[sourcePk]).filter(v => v != null)

    if (parentIds.length === 0) {
      for (const row of parentRows) row[relationName] = []

      return
    }

    const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(', ')
    const rows = await this._query(
      `SELECT t.*, j."${rel.throughFrom!}" AS "__pivot_fk"
       FROM "${rel.throughTable}" j
       JOIN "${rel.targetTable}" t ON t."${targetPk}" = j."${rel.throughTo!}"
       WHERE j."${rel.throughFrom!}" IN (${placeholders})`,
      parentIds,
    )

    const grouped = new Map<unknown, Record<string, unknown>[]>()

    for (const row of rows) {
      const fk = row.__pivot_fk

      if (!grouped.has(fk))
        grouped.set(fk, [])

      grouped.get(fk)!.push(row)
      delete row.__pivot_fk
    }

    for (const parent of parentRows) {
      parent[relationName] = grouped.get(parent[sourcePk]) ?? []
    }
  }

  // Batched relation loading — single query per relation.
  private async _loadIncludes(
    parentRows: Record<string, unknown>[],
    includes: { relation: string, strategy: 'batch' | 'lateral' }[],
  ): Promise<any[]> {
    const relations = this._table.relations

    if (!relations)
      return parentRows

    for (const inc of includes) {
      const rel = relations[inc.relation] as AnyRelationDef | undefined

      if (!rel)
        continue

      if (rel.type === 'belongsTo') {
        await this._loadBelongsTo(parentRows, rel, inc.relation)
      }
      else if (rel.type === 'hasOne' || rel.type === 'hasMany') {
        await this._loadHasOneOrMany(parentRows, rel, inc.relation)
      }
      else if (rel.type === 'hasManyThrough' && rel.throughTable) {
        await this._loadHasManyThrough(parentRows, rel, inc.relation)
      }
    }

    return parentRows
  }
}
