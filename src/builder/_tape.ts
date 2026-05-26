// --- Expression Tape (flat instruction array, no heap-allocated tree) ---
// Internal IR for boolean/scalar expressions and the assembler that prints it.
// Public DSL lives in `./expr.ts`; this file is the implementation detail.

import { ValidationError } from '../errors/index'
import { validateTsLanguage } from '../schema/validate'
import { quote, quotePath } from '../sql/utils'

const PARAM_RE = /\?/g

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
export const OP_REF = 23 as const // correlated column reference
export const OP_SCALAR = 24 as const // scalar subquery
export const OP_ARRAY_CONTAINS = 25 as const
export const OP_ARRAY_OVERLAP = 26 as const
export const OP_JSONB_SUBSCRIPT = 27 as const

export type ExprOp
  = | { op: typeof OP_AND, count: number }
    | { op: typeof OP_OR, count: number }
    | { op: typeof OP_NOT }
    | { op: typeof OP_EQ, col: string | ExprTape, val: unknown }
    | { op: typeof OP_NEQ, col: string | ExprTape, val: unknown }
    | { op: typeof OP_GT, col: string | ExprTape, val: unknown }
    | { op: typeof OP_GTE, col: string | ExprTape, val: unknown }
    | { op: typeof OP_LT, col: string | ExprTape, val: unknown }
    | { op: typeof OP_LTE, col: string | ExprTape, val: unknown }
    | { op: typeof OP_IN, col: string | ExprTape, vals: unknown[] }
    | { op: typeof OP_NOT_IN, col: string | ExprTape, vals: unknown[] }
    | { op: typeof OP_IS_NULL, col: string | ExprTape }
    | { op: typeof OP_IS_NOT_NULL, col: string | ExprTape }
    | { op: typeof OP_LIKE, col: string | ExprTape, pattern: string }
    | { op: typeof OP_ILIKE, col: string | ExprTape, pattern: string }
    | { op: typeof OP_BETWEEN, col: string | ExprTape, lo: unknown, hi: unknown }
    | { op: typeof OP_EXISTS, subquery: SubqueryRef }
    | { op: typeof OP_NOT_EXISTS, subquery: SubqueryRef }
    | { op: typeof OP_RAW, sql: string, params: unknown[] }
    | { op: typeof OP_JSONB_PATH, col: string | ExprTape, path: string }
    | { op: typeof OP_TS_MATCH, col: string | ExprTape, query: TsQueryRef }
    | { op: typeof OP_VEC_DISTANCE, col: string | ExprTape, vec: number[] | Float32Array, metric: 'cosine' | 'l2' | 'inner' }
    | { op: typeof OP_REF, path: string }
    | { op: typeof OP_SCALAR, subquery: SubqueryRef }
    | { op: typeof OP_ARRAY_CONTAINS, col: string | ExprTape, val: unknown }
    | { op: typeof OP_ARRAY_OVERLAP, col: string | ExprTape, vals: unknown[] }
    | { op: typeof OP_JSONB_SUBSCRIPT, col: string | ExprTape, path: (string | number)[] }

export type ExprTape = ExprOp[]

export interface SubqueryRef {
  toSQL: (paramOffset: number) => { sql: string, params: unknown[] }
}

export interface TsQueryRef {
  language: string
  query: string
}

// Branded aggregate result — carries the resolved type at the type level
export type AggResult<T> = string & { readonly __aggType: T }

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

  private walkCol(col: string | ExprTape): string {
    if (typeof col === 'string')
      return quote(col)

    return this.walkSubTape(col)
  }

  private walkSubTape(tape: ExprTape): string {
    const oldTape = this.tape

    this.tape = tape
    const result = this.walk(0)

    this.tape = oldTape

    return result.sql
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
    if (!('col' in op))
      return { sql: 'TRUE', next: pos + 1 }

    const colSql = this.walkCol(op.col)

    switch (op.op) {
      case OP_EQ: return op.val === null
        ? { sql: `${colSql} IS NULL`, next: pos + 1 }
        : { sql: `${colSql} = ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_NEQ: return op.val === null
        ? { sql: `${colSql} IS NOT NULL`, next: pos + 1 }
        : { sql: `${colSql} <> ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_GT: return { sql: `${colSql} > ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_GTE: return { sql: `${colSql} >= ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_LT: return { sql: `${colSql} < ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_LTE: return { sql: `${colSql} <= ${this.nextParam(op.val)}`, next: pos + 1 }
      case OP_IN: {
        if (op.vals.length === 0)
          return { sql: 'FALSE', next: pos + 1 }

        const placeholders = op.vals.map(v => this.nextParam(v))

        return { sql: `${colSql} IN (${placeholders.join(', ')})`, next: pos + 1 }
      }
      case OP_NOT_IN: {
        if (op.vals.length === 0)
          return { sql: 'TRUE', next: pos + 1 }

        const placeholders = op.vals.map(v => this.nextParam(v))

        return { sql: `${colSql} NOT IN (${placeholders.join(', ')})`, next: pos + 1 }
      }
      case OP_IS_NULL: return { sql: `${colSql} IS NULL`, next: pos + 1 }
      case OP_IS_NOT_NULL: return { sql: `${colSql} IS NOT NULL`, next: pos + 1 }
      case OP_LIKE: return { sql: `${colSql} LIKE ${this.nextParam(op.pattern)}`, next: pos + 1 }
      case OP_ILIKE: return { sql: `${colSql} ILIKE ${this.nextParam(op.pattern)}`, next: pos + 1 }
      case OP_BETWEEN: {
        const plo = this.nextParam(op.lo)
        const phi = this.nextParam(op.hi)

        return { sql: `${colSql} BETWEEN ${plo} AND ${phi}`, next: pos + 1 }
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
        let paramIdx = 0
        const params = op.params

        rawSql = rawSql.replace(PARAM_RE, () => {
          if (paramIdx >= params.length) {
            throw new ValidationError(
              `e.raw() SQL has more "?" placeholders than parameters (${params.length} provided)`,
              'e.raw',
            )
          }

          return this.nextParam(params[paramIdx++])
        })

        return { sql: rawSql, next: pos + 1 }
      }
      case OP_JSONB_PATH:
        return { sql: `jsonb_path_exists(${this.walkCol(op.col)}, ${this.nextParam(op.path)})`, next: pos + 1 }
      case OP_JSONB_SUBSCRIPT: {
        let colSql = this.walkCol(op.col)

        for (const segment of op.path) {
          colSql = `(${colSql} -> ${this.nextParam(segment)})`
        }

        return { sql: colSql, next: pos + 1 }
      }
      case OP_TS_MATCH: {
        validateTsLanguage(op.query.language)
        const lang = this.nextParam(op.query.language)
        const p = this.nextParam(op.query.query)

        return { sql: `${this.walkCol(op.col)} @@ plainto_tsquery(${lang}, ${p})`, next: pos + 1 }
      }
      case OP_VEC_DISTANCE: {
        const p = this.nextParam(op.vec)
        const opSymbol = op.metric === 'cosine' ? '<=>' : op.metric === 'l2' ? '<->' : '<#>'

        return { sql: `${this.walkCol(op.col)} ${opSymbol} ${p}::vector`, next: pos + 1 }
      }
      case OP_REF:
        return { sql: quotePath(op.path), next: pos + 1 }
      case OP_SCALAR: {
        const sub = op.subquery.toSQL(this.pidx - 1)

        this.params.push(...sub.params)
        this.pidx += sub.params.length

        return { sql: `(${sub.sql})`, next: pos + 1 }
      }
      case OP_ARRAY_CONTAINS:
        return { sql: `${this.nextParam(op.val)} = ANY(${this.walkCol(op.col)})`, next: pos + 1 }
      case OP_ARRAY_OVERLAP: {
        const placeholders = op.vals.map(v => this.nextParam(v))

        return { sql: `${this.walkCol(op.col)} && ARRAY[${placeholders.join(', ')}]`, next: pos + 1 }
      }
      default:
        return { sql: 'TRUE', next: pos + 1 }
    }
  }
}

export function assembleExpr(tape: ExprTape, paramOffset = 0): AssembledExpr {
  return new ExprAssembler(tape, paramOffset).assemble()
}
