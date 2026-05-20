import type { IncludeCallback, IncludeEntry } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyRelationDef, AnyTableDef } from '../types/index'
import { SelectBuilder } from '../builder/query'
import { OrmError } from '../errors/index'
import { quote } from '../sql/utils'

// Chunk IDs to avoid exceeding PG parameter limits (65535 params)
const BATCH_CHUNK_SIZE = 5000

/**
 * Batched relation loading — single query per relation, all relations in parallel.
 * Nested includes are handled via callback composition: each load method extracts
 * nested includes from the callback's builder state and recursively loads them
 * through child loaders.
 */
export class RelationLoader {
  constructor(
    private table: AnyTableDef,
    private executor: Executable,
    private maxIncludeDepth: number,
    private tableRegistry?: ReadonlyMap<string, AnyTableDef>,
  ) {}

  async loadIncludes(
    parentRows: Record<string, unknown>[],
    includes: IncludeEntry[],
    depth = 0,
    visited?: Set<string>,
  ): Promise<any[]> {
    if (depth > this.maxIncludeDepth) {
      throw new OrmError(
        `Maximum include depth of ${this.maxIncludeDepth} exceeded. Check for circular includes or increase maxIncludeDepth.`,
      )
    }

    const relations = this.table.relations

    if (!relations)
      return parentRows

    const seen = visited ?? new Set<string>()

    for (const inc of includes) {
      const key = `${this.table.name}.${inc.relation}`

      if (seen.has(key)) {
        throw new OrmError(
          `Circular include detected: "${key}" was already loaded in this include chain. `
          + `Break the cycle by removing the redundant .include().`,
        )
      }
    }

    const tasks: Promise<void>[] = []

    for (const inc of includes) {
      const rel = relations[inc.relation] as AnyRelationDef | undefined

      if (!rel)
        continue

      const ctx = { depth, seen }

      tasks.push((async () => {
        if (rel.type === 'belongsTo')
          await this._loadBelongsTo(parentRows, rel, inc, ctx)
        else if (rel.type === 'hasOne' || rel.type === 'hasMany')
          await this._loadHasOneOrMany(parentRows, rel, inc, ctx)
        else if (rel.type === 'hasManyThrough' && rel.throughTable)
          await this._loadHasManyThrough(parentRows, rel, inc.relation)
      })())
    }

    await Promise.all(tasks)

    return parentRows
  }

  private _resolveTable(name: string): AnyTableDef | undefined {
    return this.tableRegistry?.get(name)
  }

  private _findPrimaryKey(table: AnyTableDef): string {
    return table.primaryKey ?? 'id'
  }

  private async _query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]> {
    return this.executor.query(sql, params)
  }

  // Batched query helper — SELECT * FROM "table" WHERE "col" IN ($1, $2, ...)
  private async _batchQuery(tableName: string, column: string, ids: unknown[]): Promise<Record<string, unknown>[]> {
    if (ids.length <= BATCH_CHUNK_SIZE) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')

      return this._query(
        `SELECT * FROM ${quote(tableName)} WHERE ${quote(column)} IN (${placeholders})`,
        ids,
      )
    }

    const results: Record<string, unknown>[] = []

    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE)
      const placeholders = chunk.map((_, j) => `$${j + 1}`).join(', ')
      const rows = await this._query(
        `SELECT * FROM ${quote(tableName)} WHERE ${quote(column)} IN (${placeholders})`,
        chunk,
      )

      results.push(...rows)
    }

    return results
  }

  private async _batchThroughQuery(rel: AnyRelationDef, targetPk: string, ids: unknown[]): Promise<Record<string, unknown>[]> {
    const buildSql = (chunk: unknown[]) => {
      const placeholders = chunk.map((_, i) => `$${i + 1}`).join(', ')

      return `SELECT t.*, j.${quote(rel.throughFrom!)} AS "__pgorm_pivot_fk__"
       FROM ${quote(rel.throughTable!)} j
       JOIN ${quote(rel.targetTable)} t ON t.${quote(targetPk)} = j.${quote(rel.throughTo!)}
       WHERE j.${quote(rel.throughFrom!)} IN (${placeholders})`
    }

    if (ids.length <= BATCH_CHUNK_SIZE) {
      return this._query(buildSql(ids), ids)
    }

    const results: Record<string, unknown>[] = []

    for (let i = 0; i < ids.length; i += BATCH_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + BATCH_CHUNK_SIZE)

      results.push(...await this._query(buildSql(chunk), chunk))
    }

    return results
  }

  // Build a filtered query for a relation using callback, or fall back to batch query.
  // Extracts nested includes from the callback's builder state (they don't affect SQL).
  private async _filteredBatchQuery(
    tableName: string,
    column: string,
    ids: unknown[],
    callback?: IncludeCallback,
  ): Promise<{ rows: Record<string, unknown>[], nestedIncludes: IncludeEntry[] }> {
    if (!callback) {
      return { rows: await this._batchQuery(tableName, column, ids), nestedIncludes: [] }
    }

    const builder = new SelectBuilder<any, any>(tableName)
    const filtered = callback(builder)
    const state = filtered.getState()
    const nestedIncludes = [...state.includes]

    state.includes = []

    filtered.andWhere(e => e.in(column, ids))
    const { sql, params } = filtered.toSQL()

    return { rows: await this._query(sql, params), nestedIncludes }
  }

  private async _loadBelongsTo(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    ctx: { depth: number, seen: Set<string> },
  ): Promise<void> {
    const fk = rel.foreignKey
    const parentIds = [...new Set(parentRows.map(r => r[fk]).filter(v => v != null))]

    if (parentIds.length === 0) {
      for (const row of parentRows) row[inc.relation] = null

      return
    }

    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    const { rows: childRows, nestedIncludes } = await this._filteredBatchQuery(rel.targetTable, targetPk, parentIds, inc.callback)

    const indexed = new Map<unknown, Record<string, unknown>>()

    for (const child of childRows) indexed.set(child[targetPk], child)

    for (const parent of parentRows) {
      parent[inc.relation] = indexed.get(parent[fk]) ?? null
    }

    if (nestedIncludes.length > 0 && targetTable) {
      const childVisited = new Set(ctx.seen)

      childVisited.add(`${this.table.name}.${inc.relation}`)
      const childLoader = new RelationLoader(targetTable, this.executor, this.maxIncludeDepth, this.tableRegistry)

      await childLoader.loadIncludes(childRows, nestedIncludes, ctx.depth + 1, childVisited)
    }
  }

  private async _loadHasOneOrMany(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    ctx: { depth: number, seen: Set<string> },
  ): Promise<void> {
    const sourcePk = this._findPrimaryKey(this.table)
    const targetFk = rel.foreignKey
    const parentIds = [...new Set(parentRows.map(r => r[sourcePk]).filter(v => v != null))]
    const isMany = rel.type === 'hasMany'

    if (parentIds.length === 0) {
      for (const row of parentRows) {
        row[inc.relation] = isMany ? [] : null
      }

      return
    }

    const { rows: childRows, nestedIncludes } = await this._filteredBatchQuery(rel.targetTable, targetFk, parentIds, inc.callback)

    if (isMany) {
      const grouped = new Map<unknown, Record<string, unknown>[]>()

      for (const child of childRows) {
        const fk = child[targetFk]

        if (!grouped.has(fk))
          grouped.set(fk, [])

        grouped.get(fk)!.push(child)
      }

      for (const parent of parentRows) {
        parent[inc.relation] = grouped.get(parent[sourcePk]) ?? []
      }
    }
    else {
      const indexed = new Map<unknown, Record<string, unknown>>()

      for (const child of childRows) indexed.set(child[targetFk], child)

      for (const parent of parentRows) {
        parent[inc.relation] = indexed.get(parent[sourcePk]) ?? null
      }
    }

    if (nestedIncludes.length > 0) {
      const targetTableDef = this._resolveTable(rel.targetTable)

      if (targetTableDef) {
        const childVisited = new Set(ctx.seen)

        childVisited.add(`${this.table.name}.${inc.relation}`)
        const childLoader = new RelationLoader(targetTableDef, this.executor, this.maxIncludeDepth, this.tableRegistry)

        await childLoader.loadIncludes(childRows, nestedIncludes, ctx.depth + 1, childVisited)
      }
    }
  }

  private async _loadHasManyThrough(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    relationName: string,
  ): Promise<void> {
    const sourcePk = this._findPrimaryKey(this.table)
    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    const parentIds = [...new Set(parentRows.map(r => r[sourcePk]).filter(v => v != null))]

    if (parentIds.length === 0) {
      for (const row of parentRows) row[relationName] = []

      return
    }

    const rows = await this._batchThroughQuery(rel, targetPk, parentIds)

    const grouped = new Map<unknown, Record<string, unknown>[]>()

    for (const row of rows) {
      const fk = row.__pgorm_pivot_fk__

      if (!grouped.has(fk))
        grouped.set(fk, [])

      grouped.get(fk)!.push(row)
      delete row.__pgorm_pivot_fk__
    }

    for (const parent of parentRows) {
      parent[relationName] = grouped.get(parent[sourcePk]) ?? []
    }
  }
}
