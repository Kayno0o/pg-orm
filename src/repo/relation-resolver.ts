import type { IncludeEntry } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyRelationDef, AnyTableDef } from '../types/index'
import { PARTITION_RANK } from '../builder/assembler'
import { SelectBuilder } from '../builder/query'
import { selectedColumns } from '../builder/state'
import { DEFAULT_PRIMARY_KEY } from '../constants'
import { dialectOf } from '../dialect'
import { OrmError, ValidationError } from '../errors/index'
import { tableMeta } from '../schema/inspect'
import { collectParentIds, groupBy, indexBy, relationKey } from '../utils/collection'

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
    // The include callback's builder, whose pick, omit and computed columns shape the mapper.
    opts?: { skipMapper?: boolean, builder?: SelectBuilder<any, any, any> },
  ) => Promise<Record<string, unknown>[]>
}

interface ChildRows {
  rows: Record<string, unknown>[]
  nestedIncludes: IncludeEntry[]
  // A callback's offset and limit, left to apply per parent in memory when the query cannot partition by parent.
  slice?: { offset: number, limit: number | null }
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

  // Includes are nested by hand through callbacks, so every chain is finite; the depth limit only bounds how deep one may go.
  async loadIncludes(
    parentRows: Record<string, unknown>[],
    includes: IncludeEntry[],
    processor?: RelationProcessor,
    depth = 0,
  ): Promise<any[]> {
    if (depth > this.maxIncludeDepth) {
      throw new OrmError(
        `Maximum include depth of ${this.maxIncludeDepth} exceeded. Increase maxIncludeDepth to nest includes deeper.`,
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

      tasks.push((async () => {
        if (rel.type === 'belongsTo')
          await this._loadBelongsTo(parentRows, rel, inc, depth, processor)
        else if (rel.type === 'hasOne' || rel.type === 'hasMany')
          await this._loadHasOneOrMany(parentRows, rel, inc, depth, processor)
        else if (rel.type === 'hasManyThrough' && rel.throughTable)
          await this._loadHasManyThrough(parentRows, rel, inc, depth, processor)
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

  private _primaryKey(table: AnyTableDef, relation: string): string {
    const pk = table.primaryKey ?? DEFAULT_PRIMARY_KEY

    if (pk.includes(',')) {
      throw new ValidationError(
        `include("${relation}"): "${table.name}" has a composite primary key (${pk}), which a relation cannot join on.`,
        'include',
        { field: relation },
      )
    }

    return pk
  }

  // A parent row without its join column would match nothing and silently give every parent an empty relation.
  private _requireParentKey(parentRows: Record<string, unknown>[], key: string, relation: string): void {
    if (parentRows.length > 0 && !(key in parentRows[0]!)) {
      throw new ValidationError(
        `include("${relation}") joins on "${this.table.name}"."${key}", which the query's pick() or omit() leaves out.`,
        'include',
        { field: key },
      )
    }
  }

  private _softDeleteColumn(tableName: string): string | null {
    const table = this._resolveTable(tableName)

    return table ? tableMeta(table).softDelete?.column ?? null : null
  }

  // One query per chunk of ids, shaped by the include's callback. Trashed rows of a soft-delete target stay out unless the callback calls withTrashed(); nested includes are read off the callback's builder state, as they don't affect the SQL. `perParent` partitions a callback limit by `column`, otherwise it comes back as `slice`.
  private async _childQuery(
    tableName: string,
    column: string,
    ids: unknown[],
    inc: IncludeEntry,
    perParent: boolean,
    processor?: RelationProcessor,
  ): Promise<ChildRows> {
    const base = new SelectBuilder<any, any>(tableName)
    const filtered = inc.callback ? inc.callback(base) : base
    const state = filtered.getState()
    const nestedIncludes = [...state.includes]
    let slice: ChildRows['slice']

    state.includes = []
    state.softDeleteColumn = this._softDeleteColumn(tableName)
    state.tableColumns = Object.keys(this._resolveTable(tableName)?.columns ?? {})

    if (selectedColumns(state)?.includes(column) === false) {
      throw new ValidationError(
        `include("${inc.relation}"): the callback's pick() or omit() leaves out "${tableName}"."${column}", which the related rows are matched on.`,
        'include',
        { field: column },
      )
    }

    const limited = state.limit != null || state.offset != null

    if (limited && perParent) {
      state.limitPer = column
    }
    else if (limited) {
      slice = { offset: state.offset ?? 0, limit: state.limit }
      state.limit = null
      state.offset = null
    }

    const raw = await this._runChunked(ids, chunk => filtered.branch().andWhere(e => e.in(column, chunk)).toSQL(dialectOf(this.executor)))

    if (state.limitPer) {
      for (const row of raw)
        delete row[PARTITION_RANK]
    }

    const rows = processor && raw.length > 0 ? await processor.processRows(raw, tableName, 'select', { builder: filtered }) : raw

    return { rows, nestedIncludes, slice }
  }

  private async _loadBelongsTo(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    depth: number,
    processor?: RelationProcessor,
  ): Promise<void> {
    const fk = rel.foreignKey

    this._requireParentKey(parentRows, fk, inc.relation)

    const parentIds = collectParentIds(parentRows, fk)

    if (parentIds.length === 0) {
      for (const row of parentRows) row[inc.relation] = null

      return
    }

    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._primaryKey(targetTable, inc.relation) : DEFAULT_PRIMARY_KEY
    const { rows, nestedIncludes } = await this._childQuery(rel.targetTable, targetPk, parentIds, inc, true, processor)
    const indexed = indexBy(rows, targetPk)

    for (const parent of parentRows) {
      parent[inc.relation] = indexed.get(relationKey(parent[fk])) ?? null
    }

    await this._loadNested(targetTable, rows, nestedIncludes, depth, processor)
  }

  private async _loadHasOneOrMany(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    depth: number,
    processor?: RelationProcessor,
  ): Promise<void> {
    const sourcePk = this._primaryKey(this.table, inc.relation)
    const targetFk = rel.foreignKey
    const isMany = rel.type === 'hasMany'

    this._requireParentKey(parentRows, sourcePk, inc.relation)

    const parentIds = collectParentIds(parentRows, sourcePk)

    if (parentIds.length === 0) {
      for (const row of parentRows) {
        row[inc.relation] = isMany ? [] : null
      }

      return
    }

    const { rows, nestedIncludes } = await this._childQuery(rel.targetTable, targetFk, parentIds, inc, true, processor)

    if (isMany) {
      const grouped = groupBy(rows, targetFk)

      for (const parent of parentRows) {
        parent[inc.relation] = grouped.get(relationKey(parent[sourcePk])) ?? []
      }
    }
    else {
      const indexed = indexBy(rows, targetFk)

      for (const parent of parentRows) {
        parent[inc.relation] = indexed.get(relationKey(parent[sourcePk])) ?? null
      }
    }

    await this._loadNested(this._resolveTable(rel.targetTable), rows, nestedIncludes, depth, processor)
  }

  // The pivot rows are read first, then the targets through the include's callback; a target linked to several parents is one row shared by them, and a callback limit applies per parent in memory.
  private async _loadHasManyThrough(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    inc: IncludeEntry,
    depth: number,
    processor?: RelationProcessor,
  ): Promise<void> {
    const relationName = inc.relation
    const sourcePk = this._primaryKey(this.table, relationName)
    const targetTable = this._resolveTable(rel.targetTable)
    const targetPk = targetTable ? this._primaryKey(targetTable, relationName) : DEFAULT_PRIMARY_KEY
    const from = rel.throughFrom!
    const to = rel.throughTo!

    this._requireParentKey(parentRows, sourcePk, relationName)

    const parentIds = collectParentIds(parentRows, sourcePk)
    const pivots = await this._runChunked(parentIds, chunk => new SelectBuilder<any>(rel.throughTable!).pick(from, to).where(e => e.in(from, chunk)).toSQL(dialectOf(this.executor)))
    const parentsByTarget = new Map<unknown, unknown[]>()
    const targetIds: unknown[] = []

    for (const pivot of pivots) {
      const key = relationKey(pivot[to])
      const linked = parentsByTarget.get(key)

      if (linked) {
        linked.push(relationKey(pivot[from]))
      }
      else {
        parentsByTarget.set(key, [relationKey(pivot[from])])
        targetIds.push(pivot[to])
      }
    }

    const { rows, nestedIncludes, slice } = targetIds.length > 0
      ? await this._childQuery(rel.targetTable, targetPk, targetIds, inc, false, processor)
      : { rows: [], nestedIncludes: [], slice: undefined }
    const grouped = new Map<unknown, Record<string, unknown>[]>()

    for (const row of rows) {
      for (const parent of parentsByTarget.get(relationKey(row[targetPk])) ?? []) {
        const group = grouped.get(parent)

        if (group)
          group.push(row)
        else
          grouped.set(parent, [row])
      }
    }

    for (const parent of parentRows) {
      const all = grouped.get(relationKey(parent[sourcePk])) ?? []

      parent[relationName] = slice ? all.slice(slice.offset, slice.limit == null ? undefined : slice.offset + slice.limit) : all
    }

    await this._loadNested(targetTable, rows, nestedIncludes, depth, processor)
  }

  private async _loadNested(
    targetTable: AnyTableDef | undefined,
    childRows: Record<string, unknown>[],
    nestedIncludes: IncludeEntry[],
    depth: number,
    processor?: RelationProcessor,
  ): Promise<void> {
    if (nestedIncludes.length === 0 || !targetTable || childRows.length === 0)
      return

    const childResolver = new RelationResolver(targetTable, this.executor, this.maxIncludeDepth, this.batchChunkSize, this.tableRegistry)

    await childResolver.loadIncludes(childRows, nestedIncludes, processor, depth + 1)
  }
}
