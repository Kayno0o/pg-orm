import type { ExprTape } from './expr'
import type { SelectBuilder } from './select'
import { ValidationError } from '../errors/index'
import { quote } from '../sql/utils'

// --- Placeholder pattern (used by assembler + set-op for renumbering) ---
export const PLACEHOLDER_RE = /\$(\d+)/g

// --- Operation tag ---
export type QueryOp = 'select' | 'insert' | 'insert_many' | 'update' | 'delete' | 'merge' | 'upsert' | 'count' | 'raw'

// --- ORDER BY ---
export type OrderDir = 'asc' | 'desc'
export interface OrderEntry { col: string, dir: OrderDir, nulls?: 'first' | 'last' }

// --- JOIN ---
export interface JoinEntry {
  type: 'inner' | 'left' | 'right' | 'full' | 'lateral'
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
export type IncludeCallback = (q: SelectBuilder<any, any, any>) => SelectBuilder<any, any, any>

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
  havingTape: ExprTape | null
  // FOR UPDATE / SKIP LOCKED
  lockMode: 'update' | 'share' | 'no_key_update' | 'key_share' | null
  skipLocked: boolean
  // INSERT values
  insertValues: Record<string, unknown> | null
  insertManyValues: Record<string, unknown>[] | null
  // UPDATE set
  setValues: Record<string, unknown> | null
  // RETURNING
  returning: string[] | null // null = no RETURNING, [] = RETURNING *
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
  // Soft-delete bypass
  withTrashed: boolean
  // Per-builder override for stream() chunk size. Unset → caller default.
  streamChunkSize?: number
}

export interface ComputedColumn {
  expr: string
  alias: string
  /** A WHERE ANDed onto `expr` and the whole wrapped in parentheses, with bare columns qualified: how a filtered relation count carries its params. */
  filter?: { tape: ExprTape, qualifier: string }
}

export interface RelationCount {
  relation: string
  alias: string
  where: ExprTape | null
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
    withTrashed: false,
  }
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
    orderBy: s.orderBy.map(o => ({ ...o })),
    groupBy: [...s.groupBy],
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

export function quoteCols(cols: string[]): string {
  return cols.map(quote).join(', ')
}

export function formatOrderBy(entries: OrderEntry[]): string {
  return entries.map(o => `${quote(o.col)} ${o.dir.toUpperCase()}${o.nulls ? ` NULLS ${o.nulls.toUpperCase()}` : ''}`).join(', ')
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
