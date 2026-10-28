// --- Expression Tape (flat instruction array, no heap-allocated tree) ---
// Internal IR for boolean/scalar expressions and the assembler that prints it.
// Public DSL lives in `./expr.ts`; this file is the implementation detail.

import type { Dialect } from '../dialect'
import { DialectError, ValidationError } from '../errors/index'
import { validateTsLanguage } from '../schema/validate'
import { qualifyCol } from '../sql/utils'
import { bindRawParams } from './_placeholders'

// What a LIKE pattern character becomes in a GLOB pattern, where `*`, `?` and `[` are the wildcards.
const GLOB_WILDCARDS: Record<string, string> = { '%': '*', '_': '?' }
const GLOB_LITERALS: Record<string, string> = { '*': '[*]', '?': '[?]', '[': '[[]' }

// SQLite's LIKE ignores ASCII case, so a case-sensitive `like` is a GLOB, its pattern translated: `%` and `_` become `*` and `?`, and a backslash keeps the character after it literal, as in Postgres.
function likeToGlob(pattern: string): string {
  let glob = ''

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!

    if (ch === '\\' && i + 1 < pattern.length) {
      const next = pattern[++i]!

      glob += GLOB_LITERALS[next] ?? next

      continue
    }

    glob += GLOB_WILDCARDS[ch] ?? GLOB_LITERALS[ch] ?? ch
  }

  return glob
}

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
export const OP_IN_SUBQUERY = 28 as const // (a, b) IN (SELECT a, b ...)
export const OP_DISTINCT_FROM = 29 as const // a IS [NOT] DISTINCT FROM b
export const OP_JSONB_CONTAINS = 30 as const // a @> b::text::jsonb
export const OP_COALESCE = 31 as const
export const OP_CASE = 32 as const

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
    | { op: typeof OP_IN_SUBQUERY, cols: string[], subquery: SubqueryRef, negate?: boolean }
    | { op: typeof OP_DISTINCT_FROM, col: string | ExprTape, val: unknown, negate: boolean }
    | { op: typeof OP_JSONB_CONTAINS, col: string | ExprTape, val: unknown }
    | { op: typeof OP_COALESCE, col: string | ExprTape, fallback: unknown }
    | { op: typeof OP_CASE, whens: [ExprTape, unknown][], otherwise?: unknown }

export type ExprTape = ExprOp[]

// The position after the AND at `pos` when it holds for every row, an AND of nothing or only of such ANDs, else -1.
function vacuousEnd(tape: ExprTape, pos: number): number {
  const op = tape[pos]

  if (op?.op !== OP_AND)
    return -1

  let cursor = pos + 1

  for (let i = 0; i < op.count && cursor >= 0; i++)
    cursor = vacuousEnd(tape, cursor)

  return cursor
}

/** Whether `tape` prints as a WHERE every row passes: no condition, or ANDs of nothing such as a filter list that came out empty. */
export function holdsForEveryRow(tape: ExprTape): boolean {
  return tape.length === 0 || vacuousEnd(tape, 0) >= 0
}

export interface SubqueryRef {
  /** Placeholders numbered from `paramOffset + 1`, in the dialect of the query embedding it. */
  toSQL: (paramOffset: number, dialect?: Dialect) => { sql: string, params: unknown[] }
}

export interface TsQueryRef {
  language: string
  query: string
}

const SQL_VALUE: unique symbol = Symbol('pg-orm.SqlValue')

/** An expression standing where a value goes (a comparison's right side, a CASE branch), printed as SQL rather than bound. Only the expression builder makes one. */
export type TypedExpr<T> = ExprTape & { readonly [SQL_VALUE]: true, readonly __type?: T }

/** A column standing where a value goes, so two columns compare without a bound parameter. Only `ref()` makes one. */
export type ColumnRef = TypedExpr<unknown>

export function sqlValue<T>(tape: ExprTape): TypedExpr<T> {
  Object.defineProperty(tape, SQL_VALUE, { value: true })

  return tape as TypedExpr<T>
}

export function columnRef(path: string): ColumnRef {
  return sqlValue([{ op: OP_REF, path }])
}

// A value the Postgres array literal writes as it binds alone; an object (a json value, an expression) or an array keeps its own placeholder.
function isArrayElement(val: unknown): boolean {
  return val === null || typeof val !== 'object' || val instanceof Date
}

export function isSqlValue(val: unknown): val is TypedExpr<unknown> {
  return Array.isArray(val) && (val as unknown as Record<symbol, unknown>)[SQL_VALUE] === true
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

  // `qualifier` prefixes every bare column with a table name, for a clause where an unqualified column is ambiguous (ON CONFLICT DO UPDATE sees both the existing row and EXCLUDED).
  // `columns` are the table's own, when known: a bare name outside them is refused.
  constructor(tape: ExprTape, paramOffset: number, private readonly qualifier?: string, private readonly dialect: Dialect = 'postgres', private readonly columns?: ReadonlySet<string>) {
    this.tape = tape
    this.pidx = paramOffset + 1
  }

  private postgresOnly(feature: string): void {
    if (this.dialect !== 'postgres')
      throw new DialectError(feature, this.dialect)
  }

  private walkSubquery(subquery: SubqueryRef): string {
    const sub = subquery.toSQL(this.pidx - 1, this.dialect)

    this.params.push(...sub.params)
    this.pidx += sub.params.length

    return sub.sql
  }

  assemble(): AssembledExpr {
    const result = this.walk(0)

    return { sql: result.sql, params: this.params }
  }

  private nextParam(val: unknown): string {
    this.params.push(val)

    return `$${this.pidx++}`
  }

  // A value position: an expression from the builder (`ref()`, `coalesce()`, `caseWhen()`) printed as SQL, else a bound value.
  private operand(val: unknown): string {
    return isSqlValue(val) ? this.walkSubTape(val) : this.nextParam(val)
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
      return this.column(col)

    return this.walkSubTape(col)
  }

  private column(name: string): string {
    assertColumn(name, this.columns)

    return qualifyCol(name, this.qualifier)
  }

  private walkSubTape(tape: ExprTape): string {
    const oldTape = this.tape

    this.tape = tape
    const result = this.walk(0)

    this.tape = oldTape

    return result.sql
  }

  private walkLogical(op: ExprOp, pos: number): WalkResult {
    // An empty AND holds, an empty OR does not; `()` is no SQL.
    if ((op.op === OP_AND || op.op === OP_OR) && op.count === 0)
      return { sql: op.op === OP_AND ? 'TRUE' : 'FALSE', next: pos + 1 }

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
        : { sql: `${colSql} = ${this.operand(op.val)}`, next: pos + 1 }
      case OP_NEQ: return op.val === null
        ? { sql: `${colSql} IS NOT NULL`, next: pos + 1 }
        : { sql: `${colSql} <> ${this.operand(op.val)}`, next: pos + 1 }
      case OP_GT: return { sql: `${colSql} > ${this.operand(op.val)}`, next: pos + 1 }
      case OP_GTE: return { sql: `${colSql} >= ${this.operand(op.val)}`, next: pos + 1 }
      case OP_LT: return { sql: `${colSql} < ${this.operand(op.val)}`, next: pos + 1 }
      case OP_LTE: return { sql: `${colSql} <= ${this.operand(op.val)}`, next: pos + 1 }
      case OP_IN:
      case OP_NOT_IN: {
        const negate = op.op === OP_NOT_IN

        if (op.vals.length === 0)
          return { sql: negate ? 'TRUE' : 'FALSE', next: pos + 1 }

        // On Postgres a list of plain values binds as one array, so the statement reads the same whatever its length and never nears the bind-parameter limit.
        if (this.dialect === 'postgres' && op.vals.every(isArrayElement))
          return { sql: `${colSql} ${negate ? '<> ALL' : '= ANY'}(${this.nextParam(op.vals)})`, next: pos + 1 }

        const list = op.vals.map(v => this.operand(v))

        return { sql: `${colSql} ${negate ? 'NOT IN' : 'IN'} (${list.join(', ')})`, next: pos + 1 }
      }
      case OP_IS_NULL: return { sql: `${colSql} IS NULL`, next: pos + 1 }
      case OP_IS_NOT_NULL: return { sql: `${colSql} IS NOT NULL`, next: pos + 1 }
      case OP_LIKE: return this.dialect === 'sqlite'
        ? { sql: `${colSql} GLOB ${this.nextParam(likeToGlob(op.pattern))}`, next: pos + 1 }
        : { sql: `${colSql} LIKE ${this.nextParam(op.pattern)}`, next: pos + 1 }
      // SQLite's LIKE ignores ASCII case only, and escapes nothing unless told.
      case OP_ILIKE: return this.dialect === 'sqlite'
        ? { sql: `${colSql} LIKE ${this.nextParam(op.pattern)} ESCAPE '\\'`, next: pos + 1 }
        : { sql: `${colSql} ILIKE ${this.nextParam(op.pattern)}`, next: pos + 1 }
      case OP_BETWEEN: {
        const plo = this.operand(op.lo)
        const phi = this.operand(op.hi)

        return { sql: `${colSql} BETWEEN ${plo} AND ${phi}`, next: pos + 1 }
      }
      default:
        return { sql: 'TRUE', next: pos + 1 }
    }
  }

  private walkAdvanced(op: ExprOp, pos: number): WalkResult {
    switch (op.op) {
      case OP_EXISTS:
        return { sql: `EXISTS (${this.walkSubquery(op.subquery)})`, next: pos + 1 }
      case OP_NOT_EXISTS:
        return { sql: `NOT EXISTS (${this.walkSubquery(op.subquery)})`, next: pos + 1 }
      case OP_RAW: {
        return { sql: bindRawParams(op.sql, op.params, 'e.raw()', value => this.nextParam(value)), next: pos + 1 }
      }
      case OP_JSONB_PATH:
        this.postgresOnly('jsonbPath()')

        return { sql: `jsonb_path_exists(${this.walkCol(op.col)}, ${this.nextParam(op.path)})`, next: pos + 1 }
      case OP_JSONB_SUBSCRIPT: {
        let colSql = this.walkCol(op.col)

        // Postgres cannot tell a bound key from an index, so each step says which it is.
        for (const segment of op.path) {
          const cast = this.dialect === 'postgres' ? typeof segment === 'number' ? '::int' : '::text' : ''

          colSql = `(${colSql} -> ${this.nextParam(segment)}${cast})`
        }

        return { sql: colSql, next: pos + 1 }
      }
      case OP_TS_MATCH: {
        this.postgresOnly('tsMatch()')
        validateTsLanguage(op.query.language)
        const lang = this.nextParam(op.query.language)
        const p = this.nextParam(op.query.query)

        return { sql: `${this.walkCol(op.col)} @@ plainto_tsquery(${lang}, ${p})`, next: pos + 1 }
      }
      case OP_VEC_DISTANCE: {
        this.postgresOnly('Vector distances')

        // pgvector reads `[1,2]`, where a bound array would arrive as the Postgres array literal `{1,2}`.
        const p = this.nextParam(`[${Array.from(op.vec).join(',')}]`)
        const opSymbol = op.metric === 'cosine' ? '<=>' : op.metric === 'l2' ? '<->' : '<#>'

        return { sql: `${this.walkCol(op.col)} ${opSymbol} ${p}::vector`, next: pos + 1 }
      }
      case OP_REF:
        return { sql: this.column(op.path), next: pos + 1 }
      case OP_SCALAR:
        return { sql: `(${this.walkSubquery(op.subquery)})`, next: pos + 1 }
      case OP_IN_SUBQUERY: {
        const cols = op.cols.map(col => this.walkCol(col))

        return { sql: `${cols.length === 1 ? cols[0] : `(${cols.join(', ')})`} ${op.negate ? 'NOT IN' : 'IN'} (${this.walkSubquery(op.subquery)})`, next: pos + 1 }
      }
      case OP_DISTINCT_FROM:
        return { sql: `${this.walkCol(op.col)} IS ${op.negate ? 'NOT ' : ''}DISTINCT FROM ${this.operand(op.val)}`, next: pos + 1 }
      case OP_JSONB_CONTAINS:
        this.postgresOnly('jsonbContains()')

        return { sql: `${this.walkCol(op.col)} @> ${this.nextParam(JSON.stringify(op.val))}::text::jsonb`, next: pos + 1 }
      case OP_COALESCE:
        return { sql: `COALESCE(${this.walkCol(op.col)}, ${this.operand(op.fallback)})`, next: pos + 1 }
      case OP_CASE: {
        const branches = op.whens.map(([cond, then]) => `WHEN ${this.walkSubTape(cond)} THEN ${this.operand(then)}`)
        const otherwise = op.otherwise === undefined ? '' : ` ELSE ${this.operand(op.otherwise)}`

        return { sql: `(CASE ${branches.join(' ')}${otherwise} END)`, next: pos + 1 }
      }
      // On SQLite an array column holds JSON text, its elements read through json_each.
      case OP_ARRAY_CONTAINS:
        return this.dialect === 'sqlite'
          ? { sql: `EXISTS (SELECT 1 FROM json_each(${this.walkCol(op.col)}) WHERE "value" = ${this.nextParam(op.val)})`, next: pos + 1 }
          : { sql: `${this.nextParam(op.val)} = ANY(${this.walkCol(op.col)})`, next: pos + 1 }
      case OP_ARRAY_OVERLAP: {
        if (this.dialect === 'sqlite') {
          if (op.vals.length === 0)
            return { sql: 'FALSE', next: pos + 1 }

          const col = this.walkCol(op.col)

          return { sql: `EXISTS (SELECT 1 FROM json_each(${col}) WHERE "value" IN (${op.vals.map(v => this.nextParam(v)).join(', ')}))`, next: pos + 1 }
        }

        // An empty ARRAY[] has no type Postgres can infer, and overlaps nothing anyway.
        if (op.vals.length === 0)
          return { sql: 'FALSE', next: pos + 1 }

        const placeholders = op.vals.map(v => this.nextParam(v))

        return { sql: `${this.walkCol(op.col)} && ARRAY[${placeholders.join(', ')}]`, next: pos + 1 }
      }
      default:
        return { sql: 'TRUE', next: pos + 1 }
    }
  }
}

export function assembleExpr(tape: ExprTape, paramOffset = 0, qualifier?: string, dialect: Dialect = 'postgres', columns?: ReadonlySet<string>): AssembledExpr {
  return new ExprAssembler(tape, paramOffset, qualifier, dialect, columns).assemble()
}

/**
 * Refuse a bare column name the table does not have, when its columns are known; an `alias.col` names another table and is left alone.
 * SQLite reads a double-quoted unknown name as a string literal, so `WHERE "nme" = 'nme'` would match every row instead of failing.
 */
export function assertColumn(name: string, columns: ReadonlySet<string> | undefined): void {
  if (columns && !columns.has(name) && !name.includes('.'))
    throw new ValidationError(`Unknown column "${name}"`, 'column', { field: name })
}
