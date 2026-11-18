import type { ExprTape, SubqueryRef } from './_tape'
import type { SelectBuilder } from './select'
import type { VectorSearchOptions } from './vector-search'
import { ValidationError } from '../errors/index'
import { isJsonParam, jsonParam } from '../utils/json-param'
import { capitalize } from '../utils/string'
import { isSqlValue, vectorText } from './_tape'

export { PLACEHOLDER_RE } from './_placeholders'

// --- Operation tag ---
export type QueryOp = 'select' | 'insert' | 'insert_many' | 'update' | 'delete' | 'merge' | 'count' | 'raw'

// --- ORDER BY ---
export type OrderDir = 'asc' | 'desc'

/** A row lock: FOR UPDATE, FOR SHARE, FOR NO KEY UPDATE or FOR KEY SHARE. */
export type LockMode = 'update' | 'share' | 'no_key_update' | 'key_share'
// `expr`, when set, orders by that expression instead of `col`.
export interface OrderEntry { col: string, dir: OrderDir, nulls?: 'first' | 'last', expr?: ExprTape }

// --- JOIN ---
interface JoinEntry {
  type: 'inner' | 'left' | 'right' | 'full'
  table: string
  alias: string
  on: ExprTape | null
  relation?: string
  // The joined table's columns, when it was given as a table def: `alias.col` is then checked against them.
  columns?: readonly string[]
}

// --- CTE ---
interface CteEntry {
  name: string
  sql: string
  params: unknown[]
  materialized?: boolean
  recursive?: boolean
  // A builder rendered when the statement is, in its dialect, in place of `sql` and `params`.
  query?: SubqueryRef
}

// --- WINDOW ---

/** One end of a window frame: a fixed edge, or a number of rows (`rows`), peer groups (`groups`) or order-column units (`range`) away from the current row. */
export type FrameBound = 'unbounded preceding' | 'current row' | 'unbounded following' | { preceding: number } | { following: number }

/** The rows a window function sees around the current one. Without `to` the frame ends at the current row. */
export interface WindowFrame {
  mode?: 'rows' | 'range' | 'groups'
  from: FrameBound
  to?: FrameBound
}

interface WindowEntry {
  name: string
  partitionBy: string[]
  orderBy: OrderEntry[]
  frame?: WindowFrame
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
  // The table `include(relation, table, cb)` typed its callback from, checked against the relation's target.
  table?: { readonly name: string }
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
  // The table's column definitions, so the object WHERE form refuses an object naming no operator on a column no plain object is a value of.
  columnDefs?: object
  // The json and jsonb columns, whose compared values are bound as JSON.
  jsonColumns?: ReadonlySet<string>
  // An include's join column: limit and offset then apply per value of it, through ROW_NUMBER(), rather than to the whole batch.
  limitPer?: string
  computedColumns: ComputedColumn[]
  // `withCount` requests, turned into computed columns by the repository, which knows the related tables.
  relationAggregates: RelationAggregate[]
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
  lockMode: LockMode | null
  skipLocked: boolean
  noWait?: boolean
  lockOf?: string[]
  // pgvector search settings, set on the statement's transaction by the repository.
  vectorSearch?: VectorSearchOptions
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
  fromTables?: { table: string, alias: string, columns?: readonly string[] }[]
  // RETURNING
  returning: string[] | null // null = no RETURNING, [] = RETURNING *
  // An internal expression RETURNING adds after the columns, trusted SQL: the flag telling an upsert's inserted rows from its updated ones on Postgres.
  returningExtra?: string
  // UPSERT (ON CONFLICT)
  conflictTarget: string[] | null
  conflictAction: 'nothing' | 'update' | 'select' | null
  conflictUpdateCols: string[] | null
  // The lock DO SELECT takes on the conflicting row.
  conflictLock?: LockMode
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
  // The table's scopes, ANDed onto a SELECT's WHERE unless named in `withoutScopes`
  scopes: ScopeFilter[]
  withoutScopes: string[]
  // An UPDATE or DELETE without a WHERE is refused unless this says every row is meant.
  allRows: boolean
  // Per-builder override for stream() chunk size. Unset → caller default.
  streamChunkSize?: number
}

interface ComputedColumn {
  expr: string
  alias: string
  /** An expression tape printed in place of `expr`, its params bound: `computed()` given `coalesce()` or `caseWhen()`. */
  tape?: ExprTape
  /** The type its value reads back as, for the coercion a column of that type gets: a relation aggregate's. */
  pgType?: string
}

/** A scope's WHERE, evaluated for one statement; `qualifier` prefixes its bare columns when it filters a joined table. */
export interface ScopeFilter {
  name: string
  tape: ExprTape
  qualifier?: string
}

export type RelationAggregateFn = 'count' | 'exists' | 'sum' | 'avg' | 'min' | 'max'

/** The builder method adding an aggregate, for error messages: `withCount`, `withSum`... */
export function aggregateMethod(fn: RelationAggregateFn): string {
  return `with${capitalize(fn)}`
}

interface RelationAggregate {
  fn: RelationAggregateFn
  relation: string
  column?: string
  alias: string
  where: ExprTape | null
  withoutScopes: string[]
}

function createState(op: QueryOp, table: string): BuilderState {
  return {
    op,
    table,
    columns: null,
    omitColumns: [],
    computedColumns: [],
    relationAggregates: [],
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
    scopes: [],
    withoutScopes: [],
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

// The column types a plain object is a value of.
const OBJECT_TYPES = new Set(['json', 'jsonb', 'point', 'line', 'circle', 'polygon', 'box', 'path'])

/** Whether `name` is a column of `columns` whose type no plain object is a value of. */
export function isScalarColumn(columns: object, name: string): boolean {
  const pgType = Object.hasOwn(columns, name) ? (columns as Record<string, { pgType?: unknown }>)[name]!.pgType : undefined

  return typeof pgType === 'string' && !OBJECT_TYPES.has(pgType)
}

function jsonColumnsOf(columns: object): ReadonlySet<string> {
  return new Set(Object.entries(columns as Record<string, { pgType?: unknown }>).filter(([, col]) => col.pgType === 'json' || col.pgType === 'jsonb').map(([name]) => name))
}

// Keyed on the version too: a trait adds its columns to the same object.
const columnLists = new WeakMap<object, { version: number | undefined, columns: readonly string[], jsonColumns: ReadonlySet<string> }>()

/** The state for a builder on `table`, knowing its columns when given its definition. */
export function stateFor(op: QueryOp, table: TableTarget): BuilderState {
  if (typeof table === 'string')
    return createState(op, table)

  let cached = columnLists.get(table.columns)

  if (!cached || cached.version !== table._version) {
    cached = { version: table._version, columns: Object.keys(table.columns), jsonColumns: jsonColumnsOf(table.columns) }
    columnLists.set(table.columns, cached)
  }

  return { ...createState(op, table.name), tableColumns: cached.columns, columnDefs: table.columns, jsonColumns: cached.jsonColumns }
}

export function cloneState(s: BuilderState): BuilderState {
  return {
    ...s,
    omitColumns: [...s.omitColumns],
    computedColumns: s.computedColumns.map(c => ({ ...c })),
    relationAggregates: s.relationAggregates.map(c => ({ ...c })),
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
    scopes: [...s.scopes],
    withoutScopes: [...s.withoutScopes],
  }
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
/** A pgvector column type: `vector(3)`, `halfvec(3)`. */
export const VECTOR_TYPE_RE = /^(?:vector|halfvec)\(\d+\)$/

/**
 * A value as it is bound for a column of `pgType`. bun:sql's unsafe() path does not know column types and would bind a JS array as a Postgres array literal (`{"a","b"}`), which is not JSON:
 * a json/jsonb value is marked so the driver encodes it to JSON itself (stringifying here would store a JSON string scalar), and a vector goes in as pgvector's `[1,2]` text. Expressions, raw fragments and marked values pass as they are.
 */
export function columnValue(pgType: string | undefined, val: unknown): unknown {
  if (val === null || val === undefined || pgType === undefined || isSqlValue(val) || isRawSql(val) || isJsonParam(val))
    return val

  // A scalar too: SQLite stores the string "123" or `true` as its JSON text only when marked.
  if (pgType === 'json' || pgType === 'jsonb')
    return jsonParam(val)

  return VECTOR_TYPE_RE.test(pgType) && (Array.isArray(val) || val instanceof Float32Array) ? vectorText(val) : val
}

/** `values` with each one encoded for its column, when the builder knows the table's columns. */
export function columnValues(values: Record<string, unknown>, columnDefs: object | undefined): Record<string, unknown> {
  if (!columnDefs)
    return { ...values }

  const defs = columnDefs as Record<string, { pgType?: string }>
  const out: Record<string, unknown> = {}

  for (const [key, val] of Object.entries(values))
    out[key] = columnValue(Object.hasOwn(defs, key) ? defs[key]!.pgType : undefined, val)

  return out
}

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
