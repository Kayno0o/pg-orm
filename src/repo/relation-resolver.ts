import type { IncludeCallback, IncludeEntry } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyRelationDef, AnyTableDef } from '../types/index'
import { SelectBuilder } from '../builder/query'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { dialectOf } from '../dialect'
import { OrmError } from '../errors/index'
import { tableMeta } from '../schema/inspect'
import { buildPlaceholders, quote } from '../sql/utils'
import { collectParentIds, groupBy, indexBy } from '../utils/collection'

/**
 * Callback interface supplied by the read pipeline so eager-loaded child rows
 * receive the same post-processing (mapper coercion, afterSelect hooks,
 * virtuals, nested includes) as top-level rows. Keeping this as an interface
 * avoids a module cycle between RelationResolver and the pipeline.
 */
export interface RelationProcessor {
  processRows: (
    rows: Record<string, unknown>[],
    tableName: string,
    source: 'select',
    opts?: { skipMapper?: boolean },
  ) => Promise<Record<string, unknown>[]>
}

/**
 * Batched relation loading — single query per relation, all relations in parallel.
 * Nested includes are handled via callback composition: each load method extracts
 * nested includes from the callback's builder state and recursively loads them
 * through child resolvers.
 *
 * Chunking lives inside this class via `#runChunked` — IDs are split into chunks
 * sized by `batchChunkSize` so the IN list never overflows the bind-parameter
 * limit. The same loop serves every relation strategy.
 */
export class RelationResolver {
  constructor(
    private table: AnyTableDef,
    private executor: Executable,
    private maxIncludeDepth: number,
    private batchChunkSize: number,
    private tableRegistry?: ReadonlyMap<string, AnyTableDef>,
  ) {}

  async loadIncludes(
    parentRows: Record<string, unknown>[],
    includes: IncludeEntry[],
    processor?: RelationProcessor,
    depth = 0,
    visited?: Set<string>,
  ): Promise<any[]> {
    const seen = visited ?? new Set<string>()

    // Check cycles before depth: a true cycle is a hard error regardless of how
    // deep we are, and it's the more informative diagnostic. Depth is a fallback
    // for accidental fan-out that doesn't manifest as a labeled cycle.
    for (const inc of includes) {
      const key = `${this.table.name}.${inc.relation}`

      if (seen.has(key)) {
        throw new OrmError(
          `Circular include detected: "${key}" was already loaded in this include chain. `
          + `Break the cycle by removing the redundant .include().`,
        )
      }
    }

    if (depth > this.maxIncludeDepth) {
      throw new OrmError(
        `Maximum include depth of ${this.maxIncludeDepth} exceeded. Check for circular includes or increase maxIncludeDepth.`,
      )
    }

    const relations = this.table.relations

    if (!relations)
      return parentRows

    const tasks: Promise<void>[] = []

    for (const inc of includes) {
      const rel = relations[inc.relation] as AnyRelationDef | undefined

      if (!rel)
        continue

      const ctx = { depth, seen }

      tasks.push((async () => {
        if (rel.type === 'belongsTo')
          await this._loadBelongsTo(parentRows, rel, inc, ctx, processor)
        else if (rel.type === 'hasOne' || rel.type === 'hasMany')
          await this._loadHasOneOrMany(parentRows, rel, inc, ctx, processor)
        else if (rel.type === 'hasManyThrough' && rel.throughTable)
          await this._loadHasManyThrough(parentRows, rel, inc, processor)
      })())
    }

    await Promise.all(tasks)

    return parentRows
  }

  /**
   * Split `ids` into chunks of `batchChunkSize` and run `buildSql(chunk)` for
   * each, concatenating rows. Empty input short-circuits without touching the
   * executor — the caller decides the SQL shape (IN-clause, JOIN-through-pivot,
   * etc.) so the same chunk loop serves every relation strategy.
   */
  private async _runChunked(
    ids: unknown[],
    buildSql: (chunk: unknown[]) => { sql: string, params: unknown[] },
  ): Promise<Record<string, unknown>[]> {
    if (ids.length === 0)
      return []

    if (ids.length <= this.batchChunkSize) {
      const { sql, params } = buildSql(ids)

      return this.executor.query(sql, params)
    }

    const results: Record<string, unknown>[] = []

    for (let i = 0; i < ids.length; i += this.batchChunkSize) {
      const chunk = ids.slice(i, i + this.batchChunkSize)
      const { sql, params } = buildSql(chunk)

      results.push(...await this.executor.query(sql, params))
    }

    return results
  }

  private _resolveTable(name: string): AnyTableDef | undefined {
    return this.tableRegistry?.get(name)
  }

  private _findPrimaryKey(table: AnyTableDef): string {
    return table.primaryKey ?? DEFAULT_PRIMARY_KEY
  }

  private _batchThroughQuery(rel: AnyRelationDef, targetPk: string, ids: unknown[], withTrashed: boolean): Promise<Record<string, unknown>[]> {
    const trashCol = withTrashed ? null : this._softDeleteColumn(rel.targetTable)
    const live = trashCol ? ` AND t.${quote(trashCol)} IS NULL` : ''

    return this._runChunked(ids, chunk => ({
      sql: `SELECT t.*, j.${quote(rel.throughFrom!)} AS "__pgorm_pivot_fk__"
       FROM ${quote(rel.throughTable!)} j
       JOIN ${quote(rel.targetTable)} t ON t.${quote(targetPk)} = j.${quote(rel.throughTo!)}
       WHERE j.${quote(rel.throughFrom!)} IN (${buildPlaceholders(chunk.length)})${live}`,
      params: chunk,
    }))
  }

  private _softDeleteColumn(tableName: string): string | null {
    const table = this._resolveTable(tableName)

    return table ? tableMeta(table).softDelete?.column ?? null : null
  }

  // One query per chunk of ids, shaped by the include's callback. Trashed rows of a soft-delete target stay out unless the callback calls withTrashed(); nested includes are read off the callback's builder state, as they don't affect the SQL.
  private async _filteredBatchQuery(
    tableName: string,
    column: string,
    ids: unknown[],
    callback?: IncludeCallback,
  ): Promise<{ rows: Record<string, unknown>[], nestedIncludes: IncludeEntry[] }> {
    const base = new SelectBuilder<any, any>(tableName)
    const filtered = callback ? callback(base) : base
    const state = filtered.getState()
    const nestedIncludes = [...state.includes]

    state.includes = []
    state.softDeleteColumn = this._softDeleteColumn(tableName)
    state.tableColumns = Object.keys(this._resolveTable(tableName)?.columns ?? {})

    const rows = await this._runChunked(ids, chunk => filtered.branch().andWhere(e => e.in(column, chunk)).toSQL(dialectOf(this.executor)))

    return { rows, nestedIncludes }
  }

  private async _loadBelongsTo(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    ctx: { depth: number, seen: Set<string> },
    processor?: RelationProcessor,
  ): Promise<void> {
    const fk = rel.foreignKey
    const parentIds = collectParentIds(parentRows, fk)

    if (parentIds.length === 0) {
      for (const row of parentRows) row[inc.relation] = null

      return
    }

    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    let { rows: childRows, nestedIncludes } = await this._filteredBatchQuery(rel.targetTable, targetPk, parentIds, inc.callback)

    if (processor && childRows.length > 0)
      childRows = await processor.processRows(childRows, rel.targetTable, 'select')

    const indexed = indexBy(childRows, targetPk)

    for (const parent of parentRows) {
      parent[inc.relation] = indexed.get(parent[fk]) ?? null
    }

    await this._loadNested(targetTable, childRows, nestedIncludes, inc.relation, ctx, processor)
  }

  private async _loadHasOneOrMany(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    ctx: { depth: number, seen: Set<string> },
    processor?: RelationProcessor,
  ): Promise<void> {
    const sourcePk = this._findPrimaryKey(this.table)
    const targetFk = rel.foreignKey
    const parentIds = collectParentIds(parentRows, sourcePk)
    const isMany = rel.type === 'hasMany'

    if (parentIds.length === 0) {
      for (const row of parentRows) {
        row[inc.relation] = isMany ? [] : null
      }

      return
    }

    let { rows: childRows, nestedIncludes } = await this._filteredBatchQuery(rel.targetTable, targetFk, parentIds, inc.callback)

    if (processor && childRows.length > 0)
      childRows = await processor.processRows(childRows, rel.targetTable, 'select')

    if (isMany) {
      const grouped = groupBy(childRows, targetFk)

      for (const parent of parentRows) {
        parent[inc.relation] = grouped.get(parent[sourcePk]) ?? []
      }
    }
    else {
      const indexed = indexBy(childRows, targetFk)

      for (const parent of parentRows) {
        parent[inc.relation] = indexed.get(parent[sourcePk]) ?? null
      }
    }

    await this._loadNested(this._resolveTable(rel.targetTable), childRows, nestedIncludes, inc.relation, ctx, processor)
  }

  // The pivot join takes no callback filter; a callback is read only for withTrashed().
  private async _loadHasManyThrough(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    processor?: RelationProcessor,
  ): Promise<void> {
    const relationName = inc.relation
    const sourcePk = this._findPrimaryKey(this.table)
    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._findPrimaryKey(targetTable) : 'id'
    const parentIds = collectParentIds(parentRows, sourcePk)

    if (parentIds.length === 0) {
      for (const row of parentRows) row[relationName] = []

      return
    }

    const withTrashed = inc.callback?.(new SelectBuilder<any, any>(rel.targetTable)).getState().withTrashed ?? false
    let rows = await this._batchThroughQuery(rel, targetPk, parentIds, withTrashed)

    // The pivot key is read off before the row is mapped: a compiled mapper keeps only the target's own columns and would drop it. Mapping keeps row order, so the index still pairs each row with its key.
    const pivotKeys = rows.map((row) => {
      const key = row.__pgorm_pivot_fk__

      delete row.__pgorm_pivot_fk__

      return key
    })

    if (processor && rows.length > 0)
      rows = await processor.processRows(rows, rel.targetTable, 'select')

    const grouped = new Map<unknown, Record<string, unknown>[]>()

    for (const [i, row] of rows.entries()) {
      const key = pivotKeys[i]
      const group = grouped.get(key)

      if (group)
        group.push(row)
      else
        grouped.set(key, [row])
    }

    for (const parent of parentRows) {
      parent[relationName] = grouped.get(parent[sourcePk]) ?? []
    }
  }

  /**
   * Recursively load nested includes against a child row set, propagating the
   * visited-relation set so cycle detection sees the parent edge.
   */
  private async _loadNested(
    targetTable: AnyTableDef | undefined,
    childRows: Record<string, unknown>[],
    nestedIncludes: IncludeEntry[],
    relationName: string,
    ctx: { depth: number, seen: Set<string> },
    processor?: RelationProcessor,
  ): Promise<void> {
    if (nestedIncludes.length === 0 || !targetTable)
      return

    const childVisited = new Set(ctx.seen)

    childVisited.add(`${this.table.name}.${relationName}`)
    const childResolver = new RelationResolver(targetTable, this.executor, this.maxIncludeDepth, this.batchChunkSize, this.tableRegistry)

    await childResolver.loadIncludes(childRows, nestedIncludes, processor, ctx.depth + 1, childVisited)
  }
}
