import type { ExprTape, SubqueryRef } from './_tape'
import type { SelectBuilder } from './select'
import { ValidationError } from '../errors/index'
import { qualifyCol } from '../sql/utils'

export { PLACEHOLDER_RE } from './_placeholders'

// --- Operation tag ---
export type QueryOp = 'select' | 'insert' | 'insert_many' | 'update' | 'delete' | 'merge' | 'upsert' | 'count' | 'raw'

// --- ORDER BY ---
export type OrderDir = 'asc' | 'desc'
// `expr`, when set, orders by that expression instead of `col`.
export interface OrderEntry { col: string, dir: OrderDir, nulls?: 'first' | 'last', expr?: ExprTape }

// --- JOIN ---
export interface JoinEntry {
  type: 'inner' | 'left' | 'right' | 'full'
  table: string
  alias: string
  on: ExprTape | null
  relation?: string
}

// --- CTE ---
export interface CteEntry {
  name: string
  sql: string
  params: unknown[]
  materialized?: boolean
  recursive?: boolean
  // A builder rendered when the statement is, in its dialect, in place of `sql` and `params`.
  query?: SubqueryRef
}

// --- WINDOW ---
export interface WindowEntry {
  name: string
  partitionBy: string[]
  orderBy: OrderEntry[]
}

// --- MERGE WHEN ---
export interface MergeWhen {
  type: 'matched' | 'not_matched' | 'not_matched_by_source'
  condition?: ExprTape
  action: 'update' | 'insert' | 'delete' | 'nothing'
  values?: Record<string, unknown>
}

// --- INCLUDE (eager relation loading) ---
export type IncludeCallback = (q: SelectBuilder<any, any, any>) => SelectBuilder<any, any, any, any, any>

export interface IncludeEntry {
  relation: string
  strategy: 'batch'
  callback?: IncludeCallback
}

// --- Mutable Query State ---
// Single flat object reused per builder chain. No cloning, no immutable snapshots.
export interface BuilderState {
  op: QueryOp
  table: string
  alias?: string
  // SELECT
  columns: string[] | null // null = *, explicit list = pick
  omitColumns: string[]
  // The table's column names, set by the repository, so omit() can list the rest instead of fetching *.
  tableColumns?: readonly string[]
  // An include's join column: limit and offset then apply per value of it, through ROW_NUMBER(), rather than to the whole batch.
  limitPer?: string
  computedColumns: ComputedColumn[]
  // `withCount` requests, turned into computed columns by the repository, which knows the related tables.
  relationCounts: RelationCount[]
  distinct: boolean
  distinctOn: string[]
  // WHERE
  whereTape: ExprTape | null
  // JOIN
  joins: JoinEntry[]
  // ORDER, LIMIT, OFFSET
  orderBy: OrderEntry[]
  limit: number | null
  offset: number | null
  // GROUP BY, HAVING
  groupBy: string[]
  groupByExprs?: ExprTape[]
  havingTape: ExprTape | null
  // FOR UPDATE / SKIP LOCKED
  lockMode: 'update' | 'share' | 'no_key_update' | 'key_share' | null
  skipLocked: boolean
  noWait?: boolean
  lockOf?: string[]
  // INSERT values
  insertValues: Record<string, unknown> | null
  insertManyValues: Record<string, unknown>[] | null
  // INSERT ... SELECT: the columns written and the query giving their rows.
  insertSelect?: { columns: string[], query: SubqueryRef }
  // The SQL each column's default stands for, which a SQLite multi-row insert writes for a column a row leaves out.
  defaultSql?: Record<string, string>
  // UPDATE set
  setValues: Record<string, unknown> | null
  // UPDATE ... FROM and DELETE ... USING: the other tables the statement reads.
  fromTables?: { table: string, alias: string }[]
  // RETURNING
  returning: string[] | null // null = no RETURNING, [] = RETURNING *
  // An internal expression RETURNING adds after the columns, trusted SQL: the flag telling an upsert's inserted rows from its updated ones on Postgres.
  returningExtra?: string
  // UPSERT (ON CONFLICT)
  conflictTarget: string[] | null
  conflictAction: 'nothing' | 'update' | null
  conflictUpdateCols: string[] | null
  // Conflict-update values beyond plain EXCLUDED copies: per column a value or a ConflictValue, and the guard on the update.
  conflictSet: Record<string, unknown> | null
  conflictWhere: ExprTape | null
  // MERGE
  mergeOn: ExprTape | null
  mergeWhen: MergeWhen[]
  // CTE
  ctes: CteEntry[]
  // WINDOW
  windows: WindowEntry[]
  // Raw
  rawSql: string | null
  rawParams: unknown[]
  // Includes (eager relation loading)
  includes: IncludeEntry[]
  // Soft-delete: the trait's column, whose trashed rows a SELECT leaves out unless `withTrashed`
  softDeleteColumn: string | null
  withTrashed: boolean
  // An UPDATE or DELETE without a WHERE is refused unless this says every row is meant.
  allRows: boolean
  // Per-builder override for stream() chunk size. Unset → caller default.
  streamChunkSize?: number
}

export interface ComputedColumn {
  expr: string
  alias: string
  /** An expression tape printed in place of `expr`, its params bound: `computed()` given `coalesce()` or `caseWhen()`. */
  tape?: ExprTape
  /** A WHERE ANDed onto `expr` and the whole wrapped in parentheses, with bare columns qualified: how a filtered relation count carries its params. */
  filter?: { tape: ExprTape, qualifier: string }
}

export interface RelationCount {
  relation: string
  alias: string
  where: ExprTape | null
  withDeleted: boolean
}

export function createState(op: QueryOp, table: string): BuilderState {
  return {
    op,
    table,
    columns: null,
    omitColumns: [],
    computedColumns: [],
    relationCounts: [],
    distinct: false,
    distinctOn: [],
    whereTape: null,
    joins: [],
    orderBy: [],
    limit: null,
    offset: null,
    groupBy: [],
    havingTape: null,
    lockMode: null,
    skipLocked: false,
    insertValues: null,
    insertManyValues: null,
    setValues: null,
    returning: null,
    conflictTarget: null,
    conflictAction: null,
    conflictUpdateCols: null,
    conflictSet: null,
    conflictWhere: null,
    mergeOn: null,
    mergeWhen: [],
    ctes: [],
    windows: [],
    rawSql: null,
    rawParams: [],
    includes: [],
    softDeleteColumn: null,
    withTrashed: false,
    allRows: false,
  }
}

/** The table columns a SELECT lists, null for `*`: omitted ones left out, group columns always in. */
export function selectedColumns(s: BuilderState): string[] | null {
  const base = s.columns ?? (s.omitColumns.length > 0 ? s.tableColumns : null)

  if (!base)
    return null

  const kept = base.filter(c => !s.omitColumns.includes(c))

  for (const col of s.groupBy) {
    if (!kept.includes(col))
      kept.push(col)
  }

  return kept
}

/** What a builder is built on: a table name, or a table definition, every column name then checked against its columns. */
export type TableTarget = string | { readonly name: string, readonly columns: object, readonly _version?: number }

// Keyed on the version too: a trait adds its columns to the same object.
const columnLists = new WeakMap<object, { version: number | undefined, columns: readonly string[] }>()

/** The state for a builder on `table`, knowing its columns when given its definition. */
export function stateFor(op: QueryOp, table: TableTarget): BuilderState {
  if (typeof table === 'string')
    return createState(op, table)

  let cached = columnLists.get(table.columns)

  if (!cached || cached.version !== table._version) {
    cached = { version: table._version, columns: Object.keys(table.columns) }
    columnLists.set(table.columns, cached)
  }

  return { ...createState(op, table.name), tableColumns: cached.columns }
}

export function cloneState(s: BuilderState): BuilderState {
  return {
    ...s,
    omitColumns: [...s.omitColumns],
    computedColumns: s.computedColumns.map(c => ({ ...c })),
    relationCounts: s.relationCounts.map(c => ({ ...c })),
    distinctOn: [...s.distinctOn],
    whereTape: s.whereTape ? [...s.whereTape] : null,
    joins: s.joins.map(j => ({ ...j })),
    fromTables: s.fromTables?.map(t => ({ ...t })),
    lockOf: s.lockOf ? [...s.lockOf] : undefined,
    orderBy: s.orderBy.map(o => ({ ...o })),
    groupBy: [...s.groupBy],
    groupByExprs: s.groupByExprs ? [...s.groupByExprs] : undefined,
    havingTape: s.havingTape ? [...s.havingTape] : null,
    insertValues: s.insertValues ? { ...s.insertValues } : null,
    insertManyValues: s.insertManyValues ? s.insertManyValues.map(r => ({ ...r })) : null,
    setValues: s.setValues ? { ...s.setValues } : null,
    returning: s.returning ? [...s.returning] : null,
    conflictTarget: s.conflictTarget ? [...s.conflictTarget] : null,
    conflictUpdateCols: s.conflictUpdateCols ? [...s.conflictUpdateCols] : null,
    conflictSet: s.conflictSet ? { ...s.conflictSet } : null,
    conflictWhere: s.conflictWhere ? [...s.conflictWhere] : null,
    mergeOn: s.mergeOn ? [...s.mergeOn] : null,
    mergeWhen: s.mergeWhen.map(w => ({ ...w })),
    ctes: s.ctes.map(c => ({ ...c, params: [...c.params] })),
    windows: s.windows.map(w => ({ ...w, partitionBy: [...w.partitionBy], orderBy: w.orderBy.map(o => ({ ...o })) })),
    rawParams: [...s.rawParams],
    includes: s.includes.map(i => ({ ...i })),
  }
}

// --- Helpers ---

export function quoteCols(cols: string[], qualifier?: string): string {
  return cols.map(col => qualifyCol(col, qualifier)).join(', ')
}

const ORDER_DIRS = new Map([['asc', 'ASC'], ['desc', 'DESC']])
const NULLS_POSITIONS = new Map([['first', 'FIRST'], ['last', 'LAST']])
const JOIN_TYPES = new Map([['inner', 'INNER'], ['left', 'LEFT'], ['right', 'RIGHT'], ['full', 'FULL']])
const LOCK_MODES = new Map([['update', 'UPDATE'], ['share', 'SHARE'], ['no_key_update', 'NO KEY UPDATE'], ['key_share', 'KEY SHARE']])

// The SQL keyword for `value` out of a fixed table, never the input itself: the types are the only other guard, and a direction read off a query string passes them.
function keyword(table: Map<string, string>, value: unknown, what: string): string {
  const found = typeof value === 'string' ? table.get(value.toLowerCase()) : undefined

  if (!found)
    throw new ValidationError(`${what} must be one of ${[...table.keys()].join(', ')}`, what, { value })

  return found
}

/** An ORDER BY entry's direction and nulls position as SQL, after its column or expression. */
export function orderSuffix(o: OrderEntry): string {
  const dir = keyword(ORDER_DIRS, o.dir, 'orderBy direction')

  return o.nulls ? `${dir} NULLS ${keyword(NULLS_POSITIONS, o.nulls, 'orderBy nulls')}` : dir
}

export function joinKeyword(type: string): string {
  return keyword(JOIN_TYPES, type, 'join type')
}

export function lockKeyword(mode: string): string {
  return keyword(LOCK_MODES, mode, 'lock mode')
}

export function formatOrderBy(entries: OrderEntry[], qualifier?: string): string {
  return entries.map(o => `${qualifyCol(o.col, qualifier)} ${orderSuffix(o)}`).join(', ')
}

/** What a SELECT's bare columns are prefixed with: its own table once it joins another, where a bare name could be ambiguous. */
export function joinQualifier(state: BuilderState): string | undefined {
  return state.joins.length > 0 ? state.alias ?? state.table : undefined
}

/**
 * Brand symbol for `RawSql` values. Module-private — only `rawSql()` can produce
 * a branded value. Plain `{ __raw: "..." }` objects fail the brand check at the
 * assembler and are rejected, so user-supplied payloads cannot smuggle raw SQL
 * through validation gaps.
 */
const RAW_SQL_BRAND: unique symbol = Symbol('pg-orm.RawSql')

export interface RawSql {
  readonly __raw: string
  readonly [RAW_SQL_BRAND]: true
}

/** Internal-only factory for `RawSql`. Used by the optimistic-lock builder. */
export function rawSql(sql: string): RawSql {
  return { __raw: sql, [RAW_SQL_BRAND]: true }
}

export function isRawSql(val: unknown): val is RawSql {
  return typeof val === 'object' && val !== null && (val as Record<symbol, unknown>)[RAW_SQL_BRAND] === true
}

// Validate values for INSERT/UPDATE — reject undefined, non-finite numbers, and __raw objects
export function validateValues(vals: Record<string, unknown>, context: string): void {
  for (const [key, val] of Object.entries(vals)) {
    if (val === undefined) {
      throw new ValidationError(
        `${context}: column "${key}" has value undefined. Use null for nullable columns.`,
        context,
        { field: key, value: val },
      )
    }

    if (typeof val === 'number' && !Number.isFinite(val)) {
      throw new ValidationError(
        `${context}: column "${key}" has non-finite value ${val}. NaN and Infinity are not valid SQL values.`,
        context,
        { field: key, value: val },
      )
    }

    if (val !== null && typeof val === 'object' && '__raw' in val) {
      throw new ValidationError(
        `${context}: column "${key}" contains a __raw object. Raw SQL expressions are not allowed in user-facing APIs.`,
        context,
        { field: key, value: val },
      )
    }
  }
}
