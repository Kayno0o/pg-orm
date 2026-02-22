import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { Database, Executable, SavepointClient, TransactionClient } from '../sql/executor'
import type { AnyColumns, AnyRelationDef, AnyRelations, AnyTableDef, AnyVirtuals, HookEvent, InferInsert, InferSelect, InferUpdate } from '../types/index'
import { DeleteBuilder, InsertBuilder, MergeBuilder, SelectBuilder, UpdateBuilder, UpsertBuilder } from '../builder/query'
import { hasHooks, runHooksAsync } from '../hooks/index'
import { getOrCompileMapper, mapChunk } from '../mapper/index'
import { quote } from '../sql/utils'

// Cache virtual entries per table to avoid Object.entries on every call
const _virtualEntriesCache = new WeakMap<AnyTableDef, [string, { compute: (r: unknown) => unknown }][]>()

function getVirtualEntries(table: AnyTableDef): [string, { compute: (r: unknown) => unknown }][] {
  let entries = _virtualEntriesCache.get(table)

  if (!entries) {
    const virtuals = table.virtuals

    entries = virtuals ? Object.entries(virtuals) as [string, { compute: (r: unknown) => unknown }][] : []
    _virtualEntriesCache.set(table, entries)
  }

  return entries
}

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

  // --- Hook helpers ---

  private async _runBefore<T>(event: HookEvent, value: T): Promise<T> {
    if (hasHooks(this._table, event)) {
      return await runHooksAsync(this._table, event, value)
    }

    return value
  }

  private async _runAfter(event: HookEvent, rows?: unknown[]): Promise<void> {
    if (hasHooks(this._table, event)) {
      await runHooksAsync(this._table, event, rows)
    }
  }

  // --- Soft-delete helpers ---

  private _getSoftDeleteColumn(): string | null {
    const sd = this._table.meta?.softDelete as { column: string } | undefined

    return sd?.column ?? null
  }

  private _applySoftDeleteFilter(builder: SelectBuilder<TColumns, TRelations, any>): void {
    const col = this._getSoftDeleteColumn()

    if (col && !builder._state.withTrashed) {
      builder.andWhere(e => e.isNull(col as any))
    }
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

    // Auto-filter soft-deleted rows
    this._applySoftDeleteFilter(finalBuilder)

    const { sql, params } = finalBuilder.toSQL()
    const rows = await this._query(sql, params)

    const mapper = this._getMapper(finalBuilder)
    let mapped = mapChunk(mapper, rows)

    if (hasHooks(this._table, 'afterSelect')) {
      mapped = await runHooksAsync(this._table, 'afterSelect', mapped)
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
    const v = await this._runBefore('beforeInsert', values)

    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    return rows[0] as InferSelect<TColumns>
  }

  async insertMany(values: InferInsert<TColumns>[]): Promise<InferSelect<TColumns>[]> {
    if (values.length === 0)
      return []

    let v = values

    if (hasHooks(this._table, 'beforeInsert')) {
      v = await Promise.all(v.map(row => runHooksAsync(this._table, 'beforeInsert', row)))
    }

    const b = new InsertBuilder<TColumns>(this._table.name)
      .many(v)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    return rows as InferSelect<TColumns>[]
  }

  async updateMany(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    const s = await this._runBefore('beforeUpdate', set)

    const b = new UpdateBuilder<TColumns>(this._table.name)
      .set(s)
      .where(where)
      .returning() as UpdateBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterUpdate', rows)

    return rows as InferSelect<TColumns>[]
  }

  async deleteMany(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    // Soft-delete: convert DELETE to UPDATE but fire delete hooks
    const sdCol = this._getSoftDeleteColumn()

    if (sdCol) {
      await this._runBefore('beforeDelete', undefined)

      const b = new UpdateBuilder<TColumns>(this._table.name)
        .set({ [sdCol]: new Date() } as InferUpdate<TColumns>)
        .where(where)
        .returning() as UpdateBuilder<TColumns, InferSelect<TColumns>>
      const { sql, params } = b.toSQL()
      const rows = await this._query(sql, params)

      await this._runAfter('afterDelete', rows)

      return rows as InferSelect<TColumns>[]
    }

    await this._runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning() as DeleteBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterDelete', rows)

    return rows as InferSelect<TColumns>[]
  }

  // --- Convenience methods ---

  async findById(id: unknown): Promise<InferSelect<TColumns> | null> {
    const pk = this._table.primaryKey ?? 'id'

    return this.findOne(q => q.where(e => e.eq(pk as any, id as any)) as any)
  }

  async count(where?: (e: ExprBuilder<TColumns>) => ExprTape): Promise<number> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name).count()

    if (where) {
      builder.where(where as any)
    }

    this._applySoftDeleteFilter(builder as any)

    const { sql, params } = builder.toSQL()
    const rows = await this._query(sql, params)

    return Number((rows[0] as any)?.count ?? 0)
  }

  async exists(where: (e: ExprBuilder<TColumns>) => ExprTape): Promise<boolean> {
    const builder = new SelectBuilder<TColumns, TRelations>(this._table.name)
      .where(where as any)
      .limit(1)

    this._applySoftDeleteFilter(builder as any)

    builder._state.columns = []
    builder._state.computedColumns = [{ expr: '1', alias: '_exists' }]
    const { sql, params } = builder.toSQL()
    const rows = await this._query(sql, params)

    return rows.length > 0
  }

  async updateOne(
    set: InferUpdate<TColumns>,
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns> | null> {
    const rows = await this.updateMany(set, where)

    return rows[0] ?? null
  }

  async deleteOne(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns> | null> {
    const rows = await this.deleteMany(where)

    return rows[0] ?? null
  }

  async findOrCreate(
    values: InferInsert<TColumns>,
    conflictTarget: (keyof TColumns & string)[],
  ): Promise<InferSelect<TColumns>> {
    const v = await this._runBefore('beforeInsert', values)

    // Use ON CONFLICT DO UPDATE with a no-op SET so RETURNING always returns the row
    const pk = this._table.primaryKey ?? 'id'
    const b = new InsertBuilder<TColumns>(this._table.name)
      .values(v)
      .onConflict(conflictTarget)
      .doUpdate(pk as keyof TColumns & string)
      .returning() as InsertBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterInsert', rows)

    return rows[0] as InferSelect<TColumns>
  }

  async paginate(opts: {
    page: number
    perPage: number
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  }): Promise<{ data: InferSelect<TColumns>[], total: number, page: number, perPage: number, totalPages: number }> {
    const { page, perPage, where: whereFn } = opts

    const [data, total] = await Promise.all([
      this.findMany((q) => {
        let b = q.limit(perPage).offset((page - 1) * perPage)

        if (whereFn)
          b = b.where(whereFn as any) as any

        return b as any
      }) as Promise<InferSelect<TColumns>[]>,
      this.count(whereFn),
    ])

    return {
      data,
      total,
      page,
      perPage,
      totalPages: Math.ceil(total / perPage),
    }
  }

  // Force-delete: bypass soft-delete and run a real DELETE
  async forceDelete(
    where: (e: ExprBuilder<TColumns>) => ExprTape,
  ): Promise<InferSelect<TColumns>[]> {
    await this._runBefore('beforeDelete', undefined)

    const b = new DeleteBuilder<TColumns>(this._table.name)
      .where(where)
      .returning() as DeleteBuilder<TColumns, InferSelect<TColumns>>
    const { sql, params } = b.toSQL()
    const rows = await this._query(sql, params)

    await this._runAfter('afterDelete', rows)

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

    this._applySoftDeleteFilter(finalBuilder)

    while (true) {
      const chunkBuilder = finalBuilder.clone()

      chunkBuilder._state.limit = chunkSize
      chunkBuilder._state.offset = offset
      const { sql, params } = chunkBuilder.toSQL()
      const rows = await this._query(sql, params)

      if (rows.length === 0)
        break

      let mapped = mapChunk(mapper, rows) as InferSelect<TColumns>[]

      if (hasHooks(this._table, 'afterSelect')) {
        mapped = await runHooksAsync(this._table, 'afterSelect', mapped) as InferSelect<TColumns>[]
      }

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
    const entries = getVirtualEntries(this._table)

    if (entries.length === 0)
      return rows

    for (const row of rows) {
      for (const [key, virt] of entries) {
        ;(row as Record<string, unknown>)[key] = virt.compute(row)
      }
    }

    return rows
  }

  // Resolve a target table by name from the registry
  private _resolveTable(name: string): AnyTableDef | undefined {
    return this._tableRegistry?.get(name)
  }

  // Find primary key column name for a table — uses cached value
  private _findPrimaryKey(table: AnyTableDef): string {
    return table.primaryKey ?? 'id'
  }

  // Batched query helper — SELECT * FROM "table" WHERE "col" IN ($1, $2, ...)
  private async _batchQuery(tableName: string, column: string, ids: unknown[]): Promise<Record<string, unknown>[]> {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')

    return this._query(
      `SELECT * FROM ${quote(tableName)} WHERE ${quote(column)} IN (${placeholders})`,
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
    const parentIds = [...new Set(parentRows.map(r => r[fk]).filter(v => v != null))]

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
    const parentIds = [...new Set(parentRows.map(r => r[sourcePk]).filter(v => v != null))]
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
    const parentIds = [...new Set(parentRows.map(r => r[sourcePk]).filter(v => v != null))]

    if (parentIds.length === 0) {
      for (const row of parentRows) row[relationName] = []

      return
    }

    const placeholders = parentIds.map((_, i) => `$${i + 1}`).join(', ')
    const rows = await this._query(
      `SELECT t.*, j.${quote(rel.throughFrom!)} AS "__pivot_fk"
       FROM ${quote(rel.throughTable!)} j
       JOIN ${quote(rel.targetTable)} t ON t.${quote(targetPk)} = j.${quote(rel.throughTo!)}
       WHERE j.${quote(rel.throughFrom!)} IN (${placeholders})`,
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
    includes: { relation: string, strategy: 'batch' }[],
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
