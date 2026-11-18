import type { IncludeEntry } from '../builder/query'
import type { ScopeFilter } from '../builder/state'
import type { Executable } from '../sql/executor'
import type { AnyRelationDef, AnyTableDef } from '../types/index'
import { PARTITION_RANK } from '../builder/assembler'
import { SelectBuilder } from '../builder/query'
import { selectedColumns } from '../builder/state'

import { dialectOf } from '../dialect'
import { ValidationError } from '../errors/index'
import { primaryKeys, singleKey } from '../schema/inspect'
import { chunks, collectParentIds, groupBy, indexBy, relationKey } from '../utils/collection'
import { quote } from '../utils/quote'
import { resolveRelationFilters, scopeResolver } from './relation-filter'
import { resolveScopes } from './table-behavior'

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
    // The include callback's builder, whose pick, omit and computed columns shape the mapper.
    opts?: { skipMapper?: boolean, builder?: SelectBuilder<any, any, any> },
  ) => Promise<Record<string, unknown>[]>
}

// A hasManyThrough target is joined to the pivot rows of a chunk of parents, so all of a parent's targets come from one ordered query.
interface Through {
  table: string
  from: string
  to: string
  // The pivot table's scopes, under the alias it is joined as: a row they leave out links nothing.
  scopes: ScopeFilter[]
}

interface ChildRows {
  rows: Record<string, unknown>[]
  nestedIncludes: IncludeEntry[]
  // With `through`, each pivot link in the callback's order, as [parent key, target key]: a target linked to several parents is one row of `rows`.
  links: [unknown, unknown][]
}

const THROUGH_ALIAS = '__pgorm_through'
const THROUGH_PARENT = '__pgorm_parent'

type Rows = Record<string, unknown>[]

// Through a pivot a target linked to several parents comes once per link: it is kept once, and each link is kept by key, so an afterSelect hook dropping or reordering rows cannot shift one onto another parent.
function dedupeThrough(matched: Rows[], column: string): { raw: Rows, links: [unknown, unknown][] } {
  const raw: Rows = []
  const seen = new Set<unknown>()
  const links: [unknown, unknown][] = []

  for (const row of matched.flat()) {
    const key = relationKey(row[column])

    links.push([relationKey(row[THROUGH_PARENT]), key])
    delete row[THROUGH_PARENT]

    if (!seen.has(key)) {
      seen.add(key)
      raw.push(row)
    }
  }

  return { raw, links }
}

/**
 * Batched relation loading — single query per relation, all relations in parallel.
 * Nested includes are handled via callback composition: each load method extracts
 * nested includes from the callback's builder state and recursively loads them
 * through child resolvers.
 *
 * Chunking lives inside this class via `_runChunked` — IDs are split into chunks
 * sized by `batchChunkSize`, bounding one statement's size. The same loop serves every relation strategy.
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
      throw new ValidationError(`Maximum include depth of ${this.maxIncludeDepth} exceeded. Increase maxIncludeDepth to nest includes deeper.`, 'include')
    }

    const relations = this.table.relations ?? {}
    const tasks: Promise<void>[] = []

    for (const inc of includes) {
      const rel = relations[inc.relation] as AnyRelationDef | undefined

      if (!rel)
        throw new ValidationError(`include(): "${this.table.name}" has no relation "${inc.relation}"`, 'include', { value: inc.relation })

      if (inc.table && inc.table.name !== rel.targetTable)
        throw new ValidationError(`include("${inc.relation}"): the relation reaches "${rel.targetTable}", not the "${inc.table.name}" table given to type its callback.`, 'include', { field: inc.relation })

      const target = this._table(rel.targetTable, inc.relation)
      const pivot = rel.type === 'hasManyThrough' && rel.throughTable ? this._table(rel.throughTable, inc.relation) : undefined

      tasks.push((async () => {
        if (rel.type === 'belongsTo')
          await this._loadBelongsTo(parentRows, rel, target, inc, depth, processor)
        else if (rel.type === 'hasOne' || rel.type === 'hasMany')
          await this._loadHasOneOrMany(parentRows, rel, target, inc, depth, processor)
        else if (pivot)
          await this._loadHasManyThrough(parentRows, rel, target, pivot, inc, depth, processor)
      })())
    }

    await Promise.all(tasks)

    return parentRows
  }

  // Runs `buildSql` once per chunk of `batchChunkSize` ids and returns each chunk's rows, none for no ids; the caller shapes the SQL so every relation strategy shares this loop.
  private async _runChunked(
    ids: unknown[],
    buildSql: (chunk: unknown[]) => { sql: string, params: unknown[] },
  ): Promise<Record<string, unknown>[][]> {
    const results: Record<string, unknown>[][] = []

    for (const chunk of chunks(ids, this.batchChunkSize)) {
      const { sql, params } = buildSql(chunk)

      results.push(await this.executor.query(sql, params))
    }

    return results
  }

  // A table outside the registry has no known soft delete, hooks or column types, so its rows would come back trashed, uncoerced and through the parent's hooks.
  private _table(name: string, relation: string): AnyTableDef {
    const table = this.tableRegistry?.get(name)

    if (!table)
      throw new ValidationError(`include("${relation}"): "${name}" is not in the database's tables: list it in config.tables.`, 'include', { field: relation })

    return table
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

  // One query per chunk of ids, shaped by the include's callback. Trashed rows of a soft-delete target stay out unless the callback calls withTrashed(); nested includes are read off the callback's builder state, as they don't affect the SQL. A callback limit is cut per parent in the query, partitioned by `column`, or with `through` by the pivot's parent key. With `through`, `ids` are parent ids and `column` the target's primary key, a row matched by several chunks processed once.
  private async _childQuery(
    table: AnyTableDef,
    column: string,
    ids: unknown[],
    inc: IncludeEntry,
    processor?: RelationProcessor,
    through?: Through,
  ): Promise<ChildRows> {
    const tableName = table.name
    const base = new SelectBuilder<any, any>(tableName)
    const filtered = inc.callback ? inc.callback(base) : base
    const state = filtered.getState()
    const nestedIncludes = [...state.includes]

    state.includes = []
    state.scopes = resolveScopes(table, undefined, scopeResolver(table, this.tableRegistry))
    state.tableColumns = Object.keys(table.columns)

    state.whereTape &&= resolveRelationFilters(state.whereTape, table, state.alias ?? tableName, this.tableRegistry)

    if (selectedColumns(state)?.includes(column) === false) {
      throw new ValidationError(
        `include("${inc.relation}"): the callback's pick() or omit() leaves out "${tableName}"."${column}", which the related rows are matched on.`,
        'include',
        { field: column },
      )
    }

    if (state.limit != null || state.offset != null)
      state.limitPer = through ? `${THROUGH_ALIAS}.${through.from}` : column

    const matched = await this._runChunked(ids, (chunk) => {
      const query = filtered.branch()

      if (!through)
        return query.andWhere(e => e.in(column, chunk)).toSQL(dialectOf(this.executor))

      // Joined, the pivot gives a target row once per parent it links, carrying that parent's key.
      query
        .join(through.table, THROUGH_ALIAS, e => e.eq(column, e.ref(`${THROUGH_ALIAS}.${through.to}`)))
        .andWhere(e => e.in(`${THROUGH_ALIAS}.${through.from}`, chunk))

      query.getState().scopes.push(...through.scopes)
      query.getState().computedColumns.push({ expr: `${quote(THROUGH_ALIAS)}.${quote(through.from)}`, alias: THROUGH_PARENT })

      return query.toSQL(dialectOf(this.executor))
    })
    const { raw, links } = through ? dedupeThrough(matched, column) : { raw: matched.length === 1 ? matched[0]! : matched.flat(), links: [] }

    if (state.limitPer) {
      for (const row of raw)
        delete row[PARTITION_RANK]
    }

    const rows = processor && raw.length > 0 ? await processor.processRows(raw, tableName, { builder: filtered }) : raw

    return { rows, nestedIncludes, links }
  }

  private async _loadBelongsTo(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    targetTable: AnyTableDef,
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

    const targetPk = singleKey(targetTable, 'include', inc.relation)
    const { rows, nestedIncludes } = await this._childQuery(targetTable, targetPk, parentIds, inc, processor)
    const indexed = indexBy(rows, targetPk)

    for (const parent of parentRows) {
      parent[inc.relation] = indexed.get(relationKey(parent[fk])) ?? null
    }

    await this._loadNested(targetTable, rows, nestedIncludes, depth, processor)
  }

  private async _loadHasOneOrMany(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    target: AnyTableDef,
    inc: IncludeEntry,
    depth: number,
    processor?: RelationProcessor,
  ): Promise<void> {
    const sourcePk = singleKey(this.table, 'include', inc.relation)
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

    // A parent matching several rows gets the first in the include's order, else the one with the lowest primary key.
    const ordered: IncludeEntry = isMany
      ? inc
      : {
        ...inc,
        callback: (q) => {
          const b = inc.callback ? inc.callback(q) : q

          if (b.getState().orderBy.length === 0) {
            for (const col of primaryKeys(target))
              b.orderBy(col)
          }

          return b
        },
      }
    const { rows, nestedIncludes } = await this._childQuery(target, targetFk, parentIds, ordered, processor)

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

    await this._loadNested(target, rows, nestedIncludes, depth, processor)
  }

  // The targets joined to their pivot rows in one query through the include's callback, chunked by parent so a parent's targets keep the callback's order; a target linked to several parents is one row shared by them, and a callback limit applies per parent in the query.
  private async _loadHasManyThrough(
    parentRows: Record<string, unknown>[],
    rel: AnyRelationDef,
    targetTable: AnyTableDef,
    pivot: AnyTableDef,
    inc: IncludeEntry,
    depth: number,
    processor?: RelationProcessor,
  ): Promise<void> {
    const relationName = inc.relation
    const sourcePk = singleKey(this.table, 'include', relationName)
    const targetPk = singleKey(targetTable, 'include', relationName)
    const from = rel.throughFrom!
    const to = rel.throughTo!

    this._requireParentKey(parentRows, sourcePk, relationName)

    const parentIds = collectParentIds(parentRows, sourcePk)
    const { rows, links, nestedIncludes } = parentIds.length > 0
      ? await this._childQuery(targetTable, targetPk, parentIds, inc, processor, { table: pivot.name, from, to, scopes: resolveScopes(pivot, THROUGH_ALIAS, scopeResolver(pivot, this.tableRegistry)) })
      : { rows: [], links: [], nestedIncludes: [] }
    const byKey = indexBy(rows, targetPk)
    const grouped = new Map<unknown, Record<string, unknown>[]>()

    for (const [parent, key] of links) {
      const row = byKey.get(key)

      if (!row)
        continue

      const group = grouped.get(parent)

      if (group)
        group.push(row)
      else
        grouped.set(parent, [row])
    }

    for (const parent of parentRows) {
      parent[relationName] = grouped.get(relationKey(parent[sourcePk])) ?? []
    }

    await this._loadNested(targetTable, rows, nestedIncludes, depth, processor)
  }

  private async _loadNested(
    targetTable: AnyTableDef,
    childRows: Record<string, unknown>[],
    nestedIncludes: IncludeEntry[],
    depth: number,
    processor?: RelationProcessor,
  ): Promise<void> {
    if (nestedIncludes.length === 0 || childRows.length === 0)
      return

    const childResolver = new RelationResolver(targetTable, this.executor, this.maxIncludeDepth, this.batchChunkSize, this.tableRegistry)

    await childResolver.loadIncludes(childRows, nestedIncludes, processor, depth + 1)
  }
}
