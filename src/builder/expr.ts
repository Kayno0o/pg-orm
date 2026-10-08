import type { AnyColumnDef, AnyColumns } from '../types/index'
import type { AggResult, ExprTape, SubqueryRef, TsQueryRef } from './_tape'
import { ValidationError } from '../errors/index'
import { validateTsLanguage } from '../schema/validate'
import { quote } from '../sql/utils'
import { SINGLE_QUOTE_RE } from '../utils/regex'
import {
  OP_AND,
  OP_ARRAY_CONTAINS,
  OP_ARRAY_OVERLAP,
  OP_BETWEEN,
  OP_EQ,
  OP_EXISTS,
  OP_GT,
  OP_GTE,
  OP_ILIKE,
  OP_IN,
  OP_IS_NOT_NULL,
  OP_IS_NULL,
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
  OP_REF,
  OP_SCALAR,
  OP_TS_MATCH,
  OP_VEC_DISTANCE,
} from './_tape'

// Re-export public tape surface so external imports of `./expr` still resolve.
export {
  type AggResult,
  type AssembledExpr,
  assembleExpr,
  type ExprOp,
  type ExprTape,
  OP_AND,
  type SubqueryRef,
  type TsQueryRef,
} from './_tape'

type ColType<TColumns extends AnyColumns, K extends keyof TColumns & string>
  = TColumns[K] extends AnyColumnDef ? TColumns[K]['_type'] : unknown

// --- Expression Builder (lambda surface that compiles to ExprTape) ---

type ColVal<TColumns extends AnyColumns, K extends keyof TColumns & string> = TColumns[K]['_type']

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

  // Pattern matching
  like: <K extends keyof TColumns & string>(col: K | ExprTape, pattern: string) => ExprTape
  ilike: <K extends keyof TColumns & string>(col: K | ExprTape, pattern: string) => ExprTape

  // Range
  between: <K extends keyof TColumns & string>(col: K | ExprTape, lo: ColVal<TColumns, K>, hi: ColVal<TColumns, K>) => ExprTape

  // Subquery
  exists: (subquery: SubqueryRef) => ExprTape
  notExists: (subquery: SubqueryRef) => ExprTape
  scalar: (subquery: SubqueryRef) => ExprTape

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
  jsonbSubscript: (col: string | ExprTape, ...path: (string | number)[]) => ExprTape

  // Full-text search
  tsMatch: (col: string | ExprTape, query: TsQueryRef) => ExprTape
  tsQuery: (language: string, query: string) => TsQueryRef

  // Vector distance (pgvector)
  vectorCosineDistance: (col: string | ExprTape, vec: number[] | Float32Array) => ExprTape
  vectorL2Distance: (col: string | ExprTape, vec: number[] | Float32Array) => ExprTape
  vectorInnerProduct: (col: string | ExprTape, vec: number[] | Float32Array) => ExprTape

  // Column reference
  ref: (path: string) => ExprTape

  // Pattern convenience — auto-escape % and _ in user input
  startsWith: <K extends keyof TColumns & string>(col: K | ExprTape, prefix: string) => ExprTape
  endsWith: <K extends keyof TColumns & string>(col: K | ExprTape, suffix: string) => ExprTape
  contains: <K extends keyof TColumns & string>(col: K | ExprTape, substr: string) => ExprTape

  // Array operators
  arrayContains: <K extends keyof TColumns & string>(col: K | ExprTape, val: unknown) => ExprTape
  arrayOverlap: <K extends keyof TColumns & string>(col: K | ExprTape, vals: unknown[]) => ExprTape

  // Aggregate expressions, branded strings carrying the result type. sum, avg and countCol are cast to double precision so both dialects hand back a number, exact up to 2^53; sum and avg are null when no row has a value.
  sum: <K extends keyof TColumns & string>(col: K) => AggResult<number | null>
  avg: <K extends keyof TColumns & string>(col: K) => AggResult<number | null>
  min: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>>
  max: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>>
  countCol: <K extends keyof TColumns & string>(col?: K) => AggResult<number>

  // JSON/Array aggregate expressions
  jsonAgg: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>[]>
  jsonbAgg: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>[]>
  arrayAgg: <K extends keyof TColumns & string>(col: K) => AggResult<ColType<TColumns, K>[]>
  stringAgg: <K extends keyof TColumns & string>(col: K, delimiter: string) => AggResult<string>
}

const STRING_AGG_RE = /^[\w\s.,;:|\-/]+$/
const LIKE_RE = /[%_\\]/g

// Escape LIKE/ILIKE special characters in user input
function escapeLikePattern(input: string): string {
  return input.replace(LIKE_RE, '\\$&')
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

  eq: (col, val) => [{ op: OP_EQ, col, val }],
  neq: (col, val) => [{ op: OP_NEQ, col, val }],
  gt: (col, val) => [{ op: OP_GT, col, val }],
  gte: (col, val) => [{ op: OP_GTE, col, val }],
  lt: (col, val) => [{ op: OP_LT, col, val }],
  lte: (col, val) => [{ op: OP_LTE, col, val }],
  in: (col, vals) => [{ op: OP_IN, col, vals }],
  notIn: (col, vals) => [{ op: OP_NOT_IN, col, vals }],

  isNull: col => [{ op: OP_IS_NULL, col }],
  isNotNull: col => [{ op: OP_IS_NOT_NULL, col }],

  like: (col, pattern) => [{ op: OP_LIKE, col, pattern }],
  ilike: (col, pattern) => [{ op: OP_ILIKE, col, pattern }],

  between: (col, lo, hi) => [{ op: OP_BETWEEN, col, lo, hi }],

  exists: subquery => [{ op: OP_EXISTS, subquery }],
  notExists: subquery => [{ op: OP_NOT_EXISTS, subquery }],
  scalar: subquery => [{ op: OP_SCALAR, subquery }],

  raw: (sql, ...params) => [{ op: OP_RAW, sql, params }],

  jsonbPath: (col, path) => [{ op: OP_JSONB_PATH, col, path }],
  jsonbSubscript: (col, ...path) => [{ op: OP_JSONB_SUBSCRIPT, col, path }],

  tsMatch: (col, query) => [{ op: OP_TS_MATCH, col, query }],
  tsQuery: (language, query) => {
    validateTsLanguage(language)

    return { language, query }
  },

  vectorCosineDistance: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'cosine' }],
  vectorL2Distance: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'l2' }],
  vectorInnerProduct: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'inner' }],

  ref: path => [{ op: OP_REF, path }],

  startsWith: (col, prefix) => [{ op: OP_ILIKE, col: col as string | ExprTape, pattern: `${escapeLikePattern(prefix)}%` }],
  endsWith: (col, suffix) => [{ op: OP_ILIKE, col: col as string | ExprTape, pattern: `%${escapeLikePattern(suffix)}` }],
  contains: (col, substr) => [{ op: OP_ILIKE, col: col as string | ExprTape, pattern: `%${escapeLikePattern(substr)}%` }],

  arrayContains: (col, val) => [{ op: OP_ARRAY_CONTAINS, col: col as string | ExprTape, val }],
  arrayOverlap: (col, vals) => [{ op: OP_ARRAY_OVERLAP, col: col as string | ExprTape, vals }],

  // Aggregate functions — return raw SQL strings (cast to AggResult for type-level branding)
  sum: col => `CAST(SUM(${quote(col as string)}) AS double precision)` as AggResult<number | null>,
  avg: col => `CAST(AVG(${quote(col as string)}) AS double precision)` as AggResult<number | null>,
  min: col => `MIN(${quote(col as string)})` as AggResult<unknown>,
  max: col => `MAX(${quote(col as string)})` as AggResult<unknown>,
  countCol: col => `CAST(COUNT(${col !== undefined ? quote(col as string) : '*'}) AS double precision)` as AggResult<number>,

  // JSON/Array aggregate functions
  jsonAgg: col => `json_agg(${quote(col as string)})` as AggResult<unknown[]>,
  jsonbAgg: col => `jsonb_agg(${quote(col as string)})` as AggResult<unknown[]>,
  arrayAgg: col => `array_agg(${quote(col as string)})` as AggResult<unknown[]>,
  stringAgg: (col, delimiter) => {
    if (!STRING_AGG_RE.test(delimiter))
      throw new ValidationError(`stringAgg: unsafe delimiter characters: "${delimiter}"`, 'stringAgg', { value: delimiter })

    return `string_agg(${quote(col as string)}, '${delimiter.replace(SINGLE_QUOTE_RE, '\'\'')}')` as AggResult<string>
  },
}

// Runtime expression builder — returns shared singleton (stateless)
export function createExprBuilder<TColumns extends AnyColumns>(): ExprBuilder<TColumns> {
  return _singletonExprBuilder as ExprBuilder<TColumns>
}
