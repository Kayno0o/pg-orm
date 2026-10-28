import type { AnyColumnDef, AnyColumns } from '../types/index'
import type { AggResult, ColumnRef, ExprTape, SubqueryRef, TsQueryRef, TypedExpr } from './_tape'
import { ValidationError } from '../errors/index'
import { validateIdentifier, validateTsLanguage } from '../schema/validate'
import { qualifyCol, quote } from '../sql/utils'
import { SINGLE_QUOTE_RE } from '../utils/regex'
import {
  columnRef,
  OP_AND,
  OP_ARRAY_CONTAINS,
  OP_ARRAY_OVERLAP,
  OP_BETWEEN,
  OP_CASE,
  OP_COALESCE,
  OP_DISTINCT_FROM,
  OP_EQ,
  OP_EXISTS,
  OP_GT,
  OP_GTE,
  OP_ILIKE,
  OP_IN,
  OP_IN_SUBQUERY,
  OP_IS_NOT_NULL,
  OP_IS_NULL,
  OP_JSONB_CONTAINS,
  OP_JSONB_PATH,
  OP_JSONB_SUBSCRIPT,
  OP_LIKE,
  OP_LT,
  OP_LTE,
  OP_NEQ,
  OP_NOT,
  OP_NOT_EXISTS,
  OP_NOT_IN,
  OP_OR,
  OP_RAW,
  OP_SCALAR,
  OP_TS_MATCH,
  OP_VEC_DISTANCE,
  sqlValue,
} from './_tape'

// Re-export public tape surface so external imports of `./expr` still resolve.
export {
  type AggResult,
  type AssembledExpr,
  assembleExpr,
  type ColumnRef,
  type ExprOp,
  type ExprTape,
  OP_AND,
  type SubqueryRef,
  type TsQueryRef,
  type TypedExpr,
} from './_tape'

type ColType<TColumns extends AnyColumns, K extends keyof TColumns & string>
  = TColumns[K] extends AnyColumnDef ? TColumns[K]['_type'] : unknown

// --- Expression Builder (lambda surface that compiles to ExprTape) ---

// A value, or an expression from the builder (`ref()`, `coalesce()`, `caseWhen()`) to compare against.
type ColVal<TColumns extends AnyColumns, K extends keyof TColumns & string> = TColumns[K]['_type'] | TypedExpr<unknown>

export interface ExprBuilder<TColumns extends AnyColumns> {
  // Logical combinators
  and: (...exprs: ExprTape[]) => ExprTape
  or: (...exprs: ExprTape[]) => ExprTape
  not: (expr: ExprTape) => ExprTape

  // Comparison operators — column name is type-constrained
  eq: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K>) => ExprTape
  neq: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K>) => ExprTape
  gt: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K>) => ExprTape
  gte: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K>) => ExprTape
  lt: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K>) => ExprTape
  lte: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K>) => ExprTape
  in: <K extends keyof TColumns & string>(col: K | ExprTape, vals: ColVal<TColumns, K>[]) => ExprTape
  notIn: <K extends keyof TColumns & string>(col: K | ExprTape, vals: ColVal<TColumns, K>[]) => ExprTape

  // Null checks
  isNull: <K extends keyof TColumns & string>(col: K | ExprTape) => ExprTape
  isNotNull: <K extends keyof TColumns & string>(col: K | ExprTape) => ExprTape

  /** `IS DISTINCT FROM`: `<>` that treats NULL as a value, so a NULL and a value differ and two NULLs do not. */
  isDistinctFrom: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K> | null) => ExprTape
  isNotDistinctFrom: <K extends keyof TColumns & string>(col: K | ExprTape, val: ColVal<TColumns, K> | null) => ExprTape

  // Pattern matching
  like: <K extends keyof TColumns & string>(col: K | ExprTape, pattern: string) => ExprTape
  ilike: <K extends keyof TColumns & string>(col: K | ExprTape, pattern: string) => ExprTape
  notLike: <K extends keyof TColumns & string>(col: K | ExprTape, pattern: string) => ExprTape
  notIlike: <K extends keyof TColumns & string>(col: K | ExprTape, pattern: string) => ExprTape

  // Range
  between: <K extends keyof TColumns & string>(col: K | ExprTape, lo: ColVal<TColumns, K>, hi: ColVal<TColumns, K>) => ExprTape

  // Subquery
  exists: (subquery: SubqueryRef) => ExprTape
  notExists: (subquery: SubqueryRef) => ExprTape
  scalar: (subquery: SubqueryRef) => ExprTape
  /** `col IN (SELECT ...)`, or a row of columns against a subquery selecting as many. */
  inSubquery: <K extends keyof TColumns & string>(cols: K | K[], subquery: SubqueryRef) => ExprTape
  notInSubquery: <K extends keyof TColumns & string>(cols: K | K[], subquery: SubqueryRef) => ExprTape

  /** `COALESCE(col, fallback)`: the column, or `fallback` where it is NULL. Usable in a where, an order and `computed()`. */
  coalesce: <K extends keyof TColumns & string>(col: K | ExprTape, fallback: ColVal<TColumns, K>) => TypedExpr<NonNullable<ColType<TColumns, K>>>
  /** `CASE WHEN cond THEN value ... ELSE otherwise END`, the values bound or builder expressions. */
  caseWhen: <T>(whens: [ExprTape, T | TypedExpr<T>][], otherwise?: T | TypedExpr<T>) => TypedExpr<T>

  /**
   * Raw SQL fragment with positional `?` placeholders for parameter binding.
   *
   * @trusted The SQL string is interpolated unparameterized (only `?` markers
   * are replaced with bound params). Pass only developer-authored SQL — never
   * user input. See README "Security model".
   */
  raw: (sql: string, ...params: unknown[]) => ExprTape

  // JSONB
  jsonbPath: (col: string | ExprTape, path: string) => ExprTape
  /** `col @> value`: the jsonb column holds `value` (Postgres). */
  jsonbContains: <K extends keyof TColumns & string>(col: K | ExprTape, value: unknown) => ExprTape
  jsonbSubscript: (col: string | ExprTape, ...path: (string | number)[]) => ExprTape

  // Full-text search
  tsMatch: (col: string | ExprTape, query: TsQueryRef) => ExprTape
  tsQuery: (language: string, query: string) => TsQueryRef

  // Vector distance (pgvector)
  vectorCosineDistance: (col: string | ExprTape, vec: number[] | Float32Array) => ExprTape
  vectorL2Distance: (col: string | ExprTape, vec: number[] | Float32Array) => ExprTape
  vectorInnerProduct: (col: string | ExprTape, vec: number[] | Float32Array) => ExprTape

  /** A column by name (`col`, or `alias.col` of a joined or outer table), comparable as a value: `e.eq('authorId', e.ref('u.id'))`. */
  ref: (path: string) => ColumnRef

  // Pattern convenience, % and _ in the input escaped: case-sensitive (LIKE), the i- forms ignoring case (ILIKE)
  startsWith: <K extends keyof TColumns & string>(col: K | ExprTape, prefix: string) => ExprTape
  endsWith: <K extends keyof TColumns & string>(col: K | ExprTape, suffix: string) => ExprTape
  contains: <K extends keyof TColumns & string>(col: K | ExprTape, substr: string) => ExprTape
  iStartsWith: <K extends keyof TColumns & string>(col: K | ExprTape, prefix: string) => ExprTape
  iEndsWith: <K extends keyof TColumns & string>(col: K | ExprTape, suffix: string) => ExprTape
  iContains: <K extends keyof TColumns & string>(col: K | ExprTape, substr: string) => ExprTape

  // Array operators
  arrayContains: <K extends keyof TColumns & string>(col: K | ExprTape, val: unknown) => ExprTape
  arrayOverlap: <K extends keyof TColumns & string>(col: K | ExprTape, vals: unknown[]) => ExprTape

  // Aggregate expressions, branded strings carrying the result type. sum, avg and countCol are cast to double precision so both dialects hand back a number, exact up to 2^53; sum and avg are null when no row has a value.
  sum: <K extends keyof TColumns & string>(col: K) => AggResult<number | null>
  avg: <K extends keyof TColumns & string>(col: K) => AggResult<number | null>
  min: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>>
  max: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>>
  countCol: <K extends keyof TColumns & string>(col?: K) => AggResult<number>
  countDistinct: <K extends keyof TColumns & string>(col: K) => AggResult<number>

  // Window functions, run over a window the select declares with `window(name, ...)`: `computed(e => e.over(e.rowNumber(), 'w'), 'rank')`
  rowNumber: () => AggResult<number>
  rank: () => AggResult<number>
  denseRank: () => AggResult<number>
  over: <T>(fn: AggResult<T>, window: string) => AggResult<T>

  // JSON/Array aggregate expressions
  jsonAgg: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>[]>
  jsonbAgg: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>[]>
  arrayAgg: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>[]>
  stringAgg: <K extends keyof TColumns & string>(col: K, delimiter: string) => AggResult<string>
}

const STRING_AGG_RE = /^[\w\s.,;:|\-/]+$/
const LIKE_RE = /[%_\\]/g
// A cast aggregate (`CAST(SUM("x") AS double precision)`) and the bigint ranking functions, which over() keeps reading back as numbers.
const CAST_DOUBLE_RE = /^CAST\((.*) AS double precision\)$/
const RANKING_FNS = new Set(['ROW_NUMBER()', 'RANK()', 'DENSE_RANK()'])

function describeCol(col: unknown): string {
  return typeof col === 'string' ? `"${col}"` : 'an expression'
}

// An undefined operand would bind as NULL and match nothing, so it is refused as the object form refuses it.
function operand<T>(op: string, col: unknown, val: T): T {
  if (val === undefined)
    throw new ValidationError(`${op}(): the value compared with ${describeCol(col)} is undefined. Use isNull() to match NULL.`, op, { field: typeof col === 'string' ? col : undefined })

  return val
}

function pattern(op: string, col: unknown, val: unknown): string {
  if (typeof val !== 'string')
    throw new ValidationError(`${op}(): the pattern matched against ${describeCol(col)} must be a string, got ${val === null ? 'null' : typeof val}.`, op, { field: typeof col === 'string' ? col : undefined, value: val })

  return val
}

// Escape LIKE/ILIKE special characters in user input
function escapeLikePattern(op: string, col: unknown, input: string): string {
  return pattern(op, col, input).replace(LIKE_RE, '\\$&')
}

// Singleton expression builder — stateless, so one instance serves all callers
const _singletonExprBuilder: ExprBuilder<any> = {
  and(...exprs) {
    const tape: ExprTape = [{ op: OP_AND, count: exprs.length }]

    for (const e of exprs) tape.push(...e)

    return tape
  },
  or(...exprs) {
    const tape: ExprTape = [{ op: OP_OR, count: exprs.length }]

    for (const e of exprs) tape.push(...e)

    return tape
  },
  not(expr) {
    return [{ op: OP_NOT }, ...expr]
  },

  eq: (col, val) => [{ op: OP_EQ, col, val: operand('eq', col, val) }],
  neq: (col, val) => [{ op: OP_NEQ, col, val: operand('neq', col, val) }],
  gt: (col, val) => [{ op: OP_GT, col, val: operand('gt', col, val) }],
  gte: (col, val) => [{ op: OP_GTE, col, val: operand('gte', col, val) }],
  lt: (col, val) => [{ op: OP_LT, col, val: operand('lt', col, val) }],
  lte: (col, val) => [{ op: OP_LTE, col, val: operand('lte', col, val) }],
  in: (col, vals) => [{ op: OP_IN, col, vals: operand('in', col, vals) }],
  notIn: (col, vals) => [{ op: OP_NOT_IN, col, vals: operand('notIn', col, vals) }],

  isNull: col => [{ op: OP_IS_NULL, col }],
  isNotNull: col => [{ op: OP_IS_NOT_NULL, col }],

  isDistinctFrom: (col, val) => [{ op: OP_DISTINCT_FROM, col, val: operand('isDistinctFrom', col, val), negate: false }],
  isNotDistinctFrom: (col, val) => [{ op: OP_DISTINCT_FROM, col, val: operand('isNotDistinctFrom', col, val), negate: true }],

  like: (col, value) => [{ op: OP_LIKE, col, pattern: pattern('like', col, value) }],
  ilike: (col, value) => [{ op: OP_ILIKE, col, pattern: pattern('ilike', col, value) }],
  notLike: (col, value) => [{ op: OP_NOT }, { op: OP_LIKE, col, pattern: pattern('notLike', col, value) }],
  notIlike: (col, value) => [{ op: OP_NOT }, { op: OP_ILIKE, col, pattern: pattern('notIlike', col, value) }],

  between: (col, lo, hi) => [{ op: OP_BETWEEN, col, lo: operand('between', col, lo), hi: operand('between', col, hi) }],

  exists: subquery => [{ op: OP_EXISTS, subquery }],
  notExists: subquery => [{ op: OP_NOT_EXISTS, subquery }],
  scalar: subquery => [{ op: OP_SCALAR, subquery }],
  inSubquery: (cols, subquery) => [{ op: OP_IN_SUBQUERY, cols: Array.isArray(cols) ? cols : [cols], subquery }],
  notInSubquery: (cols, subquery) => [{ op: OP_IN_SUBQUERY, cols: Array.isArray(cols) ? cols : [cols], subquery, negate: true }],

  coalesce: (col, fallback) => sqlValue([{ op: OP_COALESCE, col, fallback }]),
  caseWhen: (whens, otherwise) => sqlValue([{ op: OP_CASE, whens, otherwise }]),

  raw: (sql, ...params) => [{ op: OP_RAW, sql, params }],

  jsonbPath: (col, path) => [{ op: OP_JSONB_PATH, col, path }],
  jsonbSubscript: (col, ...path) => [{ op: OP_JSONB_SUBSCRIPT, col, path }],
  jsonbContains: (col, value) => [{ op: OP_JSONB_CONTAINS, col, val: value }],

  tsMatch: (col, query) => [{ op: OP_TS_MATCH, col, query }],
  tsQuery: (language, query) => {
    validateTsLanguage(language)

    return { language, query }
  },

  vectorCosineDistance: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'cosine' }],
  vectorL2Distance: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'l2' }],
  vectorInnerProduct: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'inner' }],

  ref: path => columnRef(path),

  startsWith: (col, prefix) => [{ op: OP_LIKE, col, pattern: `${escapeLikePattern('startsWith', col, prefix)}%` }],
  endsWith: (col, suffix) => [{ op: OP_LIKE, col, pattern: `%${escapeLikePattern('endsWith', col, suffix)}` }],
  contains: (col, substr) => [{ op: OP_LIKE, col, pattern: `%${escapeLikePattern('contains', col, substr)}%` }],
  iStartsWith: (col, prefix) => [{ op: OP_ILIKE, col, pattern: `${escapeLikePattern('iStartsWith', col, prefix)}%` }],
  iEndsWith: (col, suffix) => [{ op: OP_ILIKE, col, pattern: `%${escapeLikePattern('iEndsWith', col, suffix)}` }],
  iContains: (col, substr) => [{ op: OP_ILIKE, col, pattern: `%${escapeLikePattern('iContains', col, substr)}%` }],

  arrayContains: (col, val) => [{ op: OP_ARRAY_CONTAINS, col: col as string | ExprTape, val }],
  arrayOverlap: (col, vals) => [{ op: OP_ARRAY_OVERLAP, col: col as string | ExprTape, vals }],

  // Aggregate functions — return raw SQL strings (cast to AggResult for type-level branding)
  sum: col => `CAST(SUM(${qualifyCol(col)}) AS double precision)` as AggResult<number | null>,
  avg: col => `CAST(AVG(${qualifyCol(col)}) AS double precision)` as AggResult<number | null>,
  min: col => `MIN(${qualifyCol(col)})` as AggResult<unknown>,
  max: col => `MAX(${qualifyCol(col)})` as AggResult<unknown>,
  countCol: col => `CAST(COUNT(${col !== undefined ? qualifyCol(col) : '*'}) AS double precision)` as AggResult<number>,
  countDistinct: col => `CAST(COUNT(DISTINCT ${qualifyCol(col)}) AS double precision)` as AggResult<number>,

  rowNumber: () => 'ROW_NUMBER()' as AggResult<number>,
  rank: () => 'RANK()' as AggResult<number>,
  denseRank: () => 'DENSE_RANK()' as AggResult<number>,
  over: (fn, window) => {
    validateIdentifier(window, 'over() window')

    // OVER must follow the call directly, so it goes inside the cast making a count or sum read back as a number; the ranking functions, bigint on Postgres, get the same cast.
    const cast = CAST_DOUBLE_RE.exec(fn)
    const call = cast ? cast[1]! : fn

    return (cast || RANKING_FNS.has(fn) ? `CAST(${call} OVER ${quote(window)} AS double precision)` : `${fn} OVER ${quote(window)}`) as typeof fn
  },

  // JSON/Array aggregate functions
  jsonAgg: col => `json_agg(${qualifyCol(col)})` as AggResult<unknown[]>,
  jsonbAgg: col => `jsonb_agg(${qualifyCol(col)})` as AggResult<unknown[]>,
  arrayAgg: col => `array_agg(${qualifyCol(col)})` as AggResult<unknown[]>,
  stringAgg: (col, delimiter) => {
    if (!STRING_AGG_RE.test(delimiter))
      throw new ValidationError(`stringAgg: unsafe delimiter characters: "${delimiter}"`, 'stringAgg', { value: delimiter })

    return `string_agg(${qualifyCol(col)}, '${delimiter.replace(SINGLE_QUOTE_RE, '\'\'')}')` as AggResult<string>
  },
}

// Runtime expression builder — returns shared singleton (stateless)
export function createExprBuilder<TColumns extends AnyColumns>(): ExprBuilder<TColumns> {
  return _singletonExprBuilder as ExprBuilder<TColumns>
}
