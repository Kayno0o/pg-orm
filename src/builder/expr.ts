import type { AnyColumns } from '../types/index'
import { validateTsLanguage } from '../schema/validate'

// --- Expression Tape (flat instruction array, no heap-allocated tree) ---

// Opcode tags
export const OP_AND = 0 as const
export const OP_OR = 1 as const
export const OP_NOT = 2 as const
export const OP_EQ = 3 as const
export const OP_NEQ = 4 as const
export const OP_GT = 5 as const
export const OP_GTE = 6 as const
export const OP_LT = 7 as const
export const OP_LTE = 8 as const
export const OP_IN = 9 as const
export const OP_NOT_IN = 10 as const
export const OP_IS_NULL = 11 as const
export const OP_IS_NOT_NULL = 12 as const
export const OP_LIKE = 13 as const
export const OP_ILIKE = 14 as const
export const OP_BETWEEN = 15 as const
export const OP_EXISTS = 16 as const
export const OP_NOT_EXISTS = 17 as const
export const OP_RAW = 18 as const
export const OP_JSONB_PATH = 19 as const
export const OP_TS_MATCH = 20 as const
export const OP_VEC_DISTANCE = 21 as const
export const OP_PARAM = 22 as const
export const OP_REF = 23 as const // correlated column reference
export const OP_SCALAR = 24 as const // scalar subquery
export const OP_ARRAY_CONTAINS = 25 as const
export const OP_ARRAY_OVERLAP = 26 as const

export type ExprOp
  = | { op: typeof OP_AND, count: number }
    | { op: typeof OP_OR, count: number }
    | { op: typeof OP_NOT }
    | { op: typeof OP_EQ, col: string, val: unknown }
    | { op: typeof OP_NEQ, col: string, val: unknown }
    | { op: typeof OP_GT, col: string, val: unknown }
    | { op: typeof OP_GTE, col: string, val: unknown }
    | { op: typeof OP_LT, col: string, val: unknown }
    | { op: typeof OP_LTE, col: string, val: unknown }
    | { op: typeof OP_IN, col: string, vals: unknown[] }
    | { op: typeof OP_NOT_IN, col: string, vals: unknown[] }
    | { op: typeof OP_IS_NULL, col: string }
    | { op: typeof OP_IS_NOT_NULL, col: string }
    | { op: typeof OP_LIKE, col: string, pattern: string }
    | { op: typeof OP_ILIKE, col: string, pattern: string }
    | { op: typeof OP_BETWEEN, col: string, lo: unknown, hi: unknown }
    | { op: typeof OP_EXISTS, subquery: SubqueryRef }
    | { op: typeof OP_NOT_EXISTS, subquery: SubqueryRef }
    | { op: typeof OP_RAW, sql: string, params: unknown[] }
    | { op: typeof OP_JSONB_PATH, col: string, path: string, innerTape: ExprTape }
    | { op: typeof OP_TS_MATCH, col: string, query: TsQueryRef }
    | { op: typeof OP_VEC_DISTANCE, col: string, vec: number[] | Float32Array, metric: 'cosine' | 'l2' | 'inner' }
    | { op: typeof OP_PARAM, name: string }
    | { op: typeof OP_REF, path: string }
    | { op: typeof OP_SCALAR, subquery: SubqueryRef }
    | { op: typeof OP_ARRAY_CONTAINS, col: string, val: unknown }
    | { op: typeof OP_ARRAY_OVERLAP, col: string, vals: unknown[] }

export type ExprTape = ExprOp[]

export interface SubqueryRef {
  toSQL: (paramOffset: number) => { sql: string, params: unknown[] }
}

export interface TsQueryRef {
  language: string
  query: string
}

// --- Expression Builder (lambda surface that compiles to ExprTape) ---

// Type-safe column value extraction
type ColVal<TColumns extends AnyColumns, K extends keyof TColumns & string> = TColumns[K]['_type']

export interface ExprBuilder<TColumns extends AnyColumns> {
  // Logical combinators
  and: (...exprs: ExprTape[]) => ExprTape
  or: (...exprs: ExprTape[]) => ExprTape
  not: (expr: ExprTape) => ExprTape

  // Comparison operators — column name is type-constrained
  eq: <K extends keyof TColumns & string>(col: K, val: ColVal<TColumns, K>) => ExprTape
  neq: <K extends keyof TColumns & string>(col: K, val: ColVal<TColumns, K>) => ExprTape
  gt: <K extends keyof TColumns & string>(col: K, val: ColVal<TColumns, K>) => ExprTape
  gte: <K extends keyof TColumns & string>(col: K, val: ColVal<TColumns, K>) => ExprTape
  lt: <K extends keyof TColumns & string>(col: K, val: ColVal<TColumns, K>) => ExprTape
  lte: <K extends keyof TColumns & string>(col: K, val: ColVal<TColumns, K>) => ExprTape
  in: <K extends keyof TColumns & string>(col: K, vals: ColVal<TColumns, K>[]) => ExprTape
  notIn: <K extends keyof TColumns & string>(col: K, vals: ColVal<TColumns, K>[]) => ExprTape

  // Null checks
  isNull: <K extends keyof TColumns & string>(col: K) => ExprTape
  isNotNull: <K extends keyof TColumns & string>(col: K) => ExprTape

  // Pattern matching
  like: <K extends keyof TColumns & string>(col: K, pattern: string) => ExprTape
  ilike: <K extends keyof TColumns & string>(col: K, pattern: string) => ExprTape

  // Range
  between: <K extends keyof TColumns & string>(col: K, lo: ColVal<TColumns, K>, hi: ColVal<TColumns, K>) => ExprTape

  // Subquery
  exists: (subquery: SubqueryRef) => ExprTape
  notExists: (subquery: SubqueryRef) => ExprTape
  scalar: (subquery: SubqueryRef) => ExprTape

  // Raw SQL fragment
  raw: (sql: string, ...params: unknown[]) => ExprTape

  // JSONB path
  jsonbPath: (col: string, path: string, inner: (e: ExprBuilder<AnyColumns>) => ExprTape) => ExprTape

  // Full-text search
  tsMatch: (col: string, query: TsQueryRef) => ExprTape
  tsQuery: (language: string, query: string) => TsQueryRef

  // Vector distance (pgvector)
  vectorCosineDistance: (col: string, vec: number[] | Float32Array) => ExprTape
  vectorL2Distance: (col: string, vec: number[] | Float32Array) => ExprTape
  vectorInnerProduct: (col: string, vec: number[] | Float32Array) => ExprTape

  // Parameterized values
  param: <T = unknown>(name: string) => T
  ref: (path: string) => ExprTape

  // Array operators
  arrayContains: <K extends keyof TColumns & string>(col: K, val: unknown) => ExprTape
  arrayOverlap: <K extends keyof TColumns & string>(col: K, vals: unknown[]) => ExprTape
}

// Runtime expression builder implementation
export function createExprBuilder<TColumns extends AnyColumns>(): ExprBuilder<TColumns> {
  return {
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

    eq: (col, val) => [{ op: OP_EQ, col: col as string, val }],
    neq: (col, val) => [{ op: OP_NEQ, col: col as string, val }],
    gt: (col, val) => [{ op: OP_GT, col: col as string, val }],
    gte: (col, val) => [{ op: OP_GTE, col: col as string, val }],
    lt: (col, val) => [{ op: OP_LT, col: col as string, val }],
    lte: (col, val) => [{ op: OP_LTE, col: col as string, val }],
    in: (col, vals) => [{ op: OP_IN, col: col as string, vals: vals as unknown[] }],
    notIn: (col, vals) => [{ op: OP_NOT_IN, col: col as string, vals: vals as unknown[] }],

    isNull: col => [{ op: OP_IS_NULL, col: col as string }],
    isNotNull: col => [{ op: OP_IS_NOT_NULL, col: col as string }],

    like: (col, pattern) => [{ op: OP_LIKE, col: col as string, pattern }],
    ilike: (col, pattern) => [{ op: OP_ILIKE, col: col as string, pattern }],

    between: (col, lo, hi) => [{ op: OP_BETWEEN, col: col as string, lo, hi }],

    exists: subquery => [{ op: OP_EXISTS, subquery }],
    notExists: subquery => [{ op: OP_NOT_EXISTS, subquery }],
    scalar: subquery => [{ op: OP_SCALAR, subquery }],

    raw: (sql, ...params) => [{ op: OP_RAW, sql, params }],

    jsonbPath(col, path, inner) {
      const innerBuilder = createExprBuilder<AnyColumns>()
      const innerTape = inner(innerBuilder)

      return [{ op: OP_JSONB_PATH, col, path, innerTape }]
    },

    tsMatch: (col, query) => [{ op: OP_TS_MATCH, col, query }],
    tsQuery: (language, query) => {
      validateTsLanguage(language)

      return { language, query }
    },

    vectorCosineDistance: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'cosine' }],
    vectorL2Distance: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'l2' }],
    vectorInnerProduct: (col, vec) => [{ op: OP_VEC_DISTANCE, col, vec, metric: 'inner' }],

    param: name => ({ __param: true, name }) as never,
    ref: path => [{ op: OP_REF, path }],

    arrayContains: (col, val) => [{ op: OP_ARRAY_CONTAINS, col: col as string, val }],
    arrayOverlap: (col, vals) => [{ op: OP_ARRAY_OVERLAP, col: col as string, vals }],
  }
}

// --- SQL Assembly from ExprTape ---
// Uses ExprAssembler class to keep each method under the line limit.

export interface AssembledExpr {
  sql: string
  params: unknown[]
}

interface WalkResult {
  sql: string
  next: number
}

class ExprAssembler {
  private tape: ExprTape
  private params: unknown[] = []
  private pidx: number

  constructor(tape: ExprTape, paramOffset: number) {
    this.tape = tape
    this.pidx = paramOffset + 1
  }

  assemble(): AssembledExpr {
    const result = this.walk(0)

    return { sql: result.sql, params: this.params }
  }

  private nextParam(val: unknown): string {
    this.params.push(val)

    return `$${this.pidx++}`
  }

  private walk(pos: number): WalkResult {
    const op = this.tape[pos]

    if (!op)
      return { sql: 'TRUE', next: pos + 1 }

    if (op.op <= OP_NOT)
      return this.walkLogical(op, pos)

    if (op.op <= OP_BETWEEN)
      return this.walkFilter(op, pos)

    return this.walkAdvanced(op, pos)
  }

  private walkLogical(op: ExprOp, pos: number): WalkResult {
    if (op.op === OP_AND || op.op === OP_OR) {
      const connector = op.op === OP_AND ? ' AND ' : ' OR '
      const parts: string[] = []
      let cursor = pos + 1

      for (let i = 0; i < op.count; i++) {
        const r = this.walk(cursor)

        parts.push(r.sql)
        cursor = r.next
      }

      return { sql: `(${parts.join(connector)})`, next: cursor }
    }

    if (op.op === OP_NOT) {
      const r = this.walk(pos + 1)

      return { sql: `NOT (${r.sql})`, next: r.next }
    }

    return { sql: 'TRUE', next: pos + 1 }
  }

  private walkFilter(op: ExprOp, pos: number): WalkResult {
    switch (op.op) {
      case OP_EQ: return { sql: `"${op.col}" = ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_NEQ: return { sql: `"${op.col}" <> ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_GT: return { sql: `"${op.col}" > ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_GTE: return { sql: `"${op.col}" >= ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_LT: return { sql: `"${op.col}" < ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_LTE: return { sql: `"${op.col}" <= ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_IN: {
        const placeholders = op.vals.map(v => this.nextParam(v))

        return { sql: `"${op.col}" IN (${placeholders.join(', ')})`, next: pos + 1 }
      }
      case OP_NOT_IN: {
        const placeholders = op.vals.map(v => this.nextParam(v))

        return { sql: `"${op.col}" NOT IN (${placeholders.join(', ')})`, next: pos + 1 }
      }
      case OP_IS_NULL: return { sql: `"${op.col}" IS NULL`, next: pos + 1 }
      case OP_IS_NOT_NULL: return { sql: `"${op.col}" IS NOT NULL`, next: pos + 1 }
      case OP_LIKE: return { sql: `"${op.col}" LIKE ${this.nextParam(op.pattern)}`, next: pos + 1 }
      case OP_ILIKE: return { sql: `"${op.col}" ILIKE ${this.nextParam(op.pattern)}`, next: pos + 1 }
      case OP_BETWEEN: {
        const plo = this.nextParam(op.lo)
        const phi = this.nextParam(op.hi)

        return { sql: `"${op.col}" BETWEEN ${plo} AND ${phi}`, next: pos + 1 }
      }
      default:
        return { sql: 'TRUE', next: pos + 1 }
    }
  }

  private walkAdvanced(op: ExprOp, pos: number): WalkResult {
    switch (op.op) {
      case OP_EXISTS: {
        const sub = op.subquery.toSQL(this.pidx - 1)

        this.params.push(...sub.params)
        this.pidx += sub.params.length

        return { sql: `EXISTS (${sub.sql})`, next: pos + 1 }
      }
      case OP_NOT_EXISTS: {
        const sub = op.subquery.toSQL(this.pidx - 1)

        this.params.push(...sub.params)
        this.pidx += sub.params.length

        return { sql: `NOT EXISTS (${sub.sql})`, next: pos + 1 }
      }
      case OP_RAW: {
        let rawSql = op.sql

        for (const p of op.params) {
          const placeholder = this.nextParam(p)

          rawSql = rawSql.replace('?', placeholder)
        }

        return { sql: rawSql, next: pos + 1 }
      }
      case OP_JSONB_PATH:
        return { sql: `jsonb_path_exists("${op.col}", ${this.nextParam(op.path)})`, next: pos + 1 }
      case OP_TS_MATCH: {
        // Language is validated against allowlist at tsQuery() call time,
        // so single-quoting is safe here. Values are always bound as $N.
        const p = this.nextParam(op.query.query)

        return { sql: `"${op.col}" @@ plainto_tsquery('${op.query.language}', ${p})`, next: pos + 1 }
      }
      case OP_VEC_DISTANCE: {
        const vecStr = `[${Array.from(op.vec).join(',')}]`
        const p = this.nextParam(vecStr)
        const opSymbol = op.metric === 'cosine' ? '<=>' : op.metric === 'l2' ? '<->' : '<#>'

        return { sql: `"${op.col}" ${opSymbol} ${p}`, next: pos + 1 }
      }
      case OP_PARAM:
        return { sql: `$${this.pidx++}`, next: pos + 1 }
      case OP_REF:
        return { sql: `"${op.path.replaceAll('.', '"."')}"`, next: pos + 1 }
      case OP_SCALAR: {
        const sub = op.subquery.toSQL(this.pidx - 1)

        this.params.push(...sub.params)
        this.pidx += sub.params.length

        return { sql: `(${sub.sql})`, next: pos + 1 }
      }
      case OP_ARRAY_CONTAINS:
        return { sql: `${this.nextParam(op.val)} = ANY("${op.col}")`, next: pos + 1 }
      case OP_ARRAY_OVERLAP: {
        const placeholders = op.vals.map(v => this.nextParam(v))

        return { sql: `"${op.col}" && ARRAY[${placeholders.join(', ')}]`, next: pos + 1 }
      }
      default:
        return { sql: 'TRUE', next: pos + 1 }
    }
  }
}

export function assembleExpr(tape: ExprTape, paramOffset = 0): AssembledExpr {
  return new ExprAssembler(tape, paramOffset).assemble()
}
