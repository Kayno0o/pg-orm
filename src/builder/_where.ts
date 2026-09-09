import type { AnyColumnDef, AnyColumns, IsNullable } from '../types/index'
import type { ExprBuilder, ExprOp, ExprTape } from './expr'
import type { BuilderState } from './state'
import { ValidationError } from '../errors/index'
import { createExprBuilder, OP_AND } from './expr'

/** A WHERE callback. */
export type WhereFn<TColumns extends AnyColumns> = (e: ExprBuilder<TColumns>) => ExprTape

/**
 * Comparison operators accepted as the value of a column in the object WHERE
 * shorthand. Several operators in one object are ANDed: `{ gte: lo, lte: hi }`.
 */
export interface WhereOps<T> {
  eq?: T | null
  neq?: T | null
  gt?: T
  gte?: T
  lt?: T
  lte?: T
  in?: T[]
  notIn?: T[]
  like?: string
  ilike?: string
  contains?: string
  startsWith?: string
  endsWith?: string
  between?: [T, T]
  isNull?: boolean
}

type ColSelect<C extends AnyColumnDef> = C['_nullable'] extends IsNullable ? C['_type'] | null : C['_type']

// An array-typed column takes no bare array — `IN` on it would be indistinguishable from equality — so it goes through `{ eq: [...] }`.
type WhereValue<C extends AnyColumnDef>
  = C['_type'] extends readonly unknown[]
    ? null | WhereOps<C['_type']>
    : ColSelect<C> | C['_type'][] | WhereOps<C['_type']>

/**
 * Object WHERE shorthand — every entry is ANDed. A scalar means `=`, `null`
 * means `IS NULL`, an array means `IN`, and a {@link WhereOps} object spells out
 * the operator.
 */
export type WhereObject<TColumns extends AnyColumns> = {
  [K in keyof TColumns & string]?: WhereValue<TColumns[K]>
}

/** Either form a WHERE clause can take: a callback or the object shorthand. */
export type WhereInput<TColumns extends AnyColumns> = WhereFn<TColumns> | WhereObject<TColumns>

/**
 * A WHERE clause, or any falsy value meaning "skip this condition". Lets
 * optional filters be written inline (`q.andWhere(status && { status })`)
 * instead of branching around the builder.
 */
export type OptionalWhere<TColumns extends AnyColumns> = WhereInput<TColumns> | null | undefined | false | '' | 0

const WHERE_OPS = new Set([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'notIn',
  'like',
  'ilike',
  'contains',
  'startsWith',
  'endsWith',
  'between',
  'isNull',
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false

  const proto = Object.getPrototypeOf(value) as unknown

  return proto === Object.prototype || proto === null
}

/** AND several tapes into one, returning the single tape unwrapped. */
function andTapes(tapes: ExprTape[]): ExprTape {
  if (tapes.length === 1)
    return tapes[0]!

  const combined: ExprTape = [{ op: OP_AND, count: tapes.length } as ExprOp]

  for (const tape of tapes) combined.push(...tape)

  return combined
}

function opToTape(e: ExprBuilder<any>, col: string, op: string, value: unknown): ExprTape {
  if (value === undefined)
    throw new ValidationError(`where: operator "${op}" on column "${col}" was given undefined.`, 'where', { field: col })

  switch (op) {
    case 'eq': return value === null ? e.isNull(col) : e.eq(col, value)
    case 'neq': return value === null ? e.isNotNull(col) : e.neq(col, value)
    case 'gt': return e.gt(col, value)
    case 'gte': return e.gte(col, value)
    case 'lt': return e.lt(col, value)
    case 'lte': return e.lte(col, value)
    case 'in': return e.in(col, expectArray(col, op, value))
    case 'notIn': return e.notIn(col, expectArray(col, op, value))
    case 'like': return e.like(col, value as string)
    case 'ilike': return e.ilike(col, value as string)
    case 'contains': return e.contains(col, value as string)
    case 'startsWith': return e.startsWith(col, value as string)
    case 'endsWith': return e.endsWith(col, value as string)
    case 'isNull': return value ? e.isNull(col) : e.isNotNull(col)
    case 'between': {
      const range = expectArray(col, op, value)

      if (range.length !== 2)
        throw new ValidationError(`where: operator "between" on column "${col}" expects a [low, high] tuple.`, 'where', { field: col })

      return e.between(col, range[0], range[1])
    }
    default: throw new ValidationError(`where: unknown operator "${op}" on column "${col}".`, 'where', { field: col })
  }
}

function expectArray(col: string, op: string, value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new ValidationError(`where: operator "${op}" on column "${col}" expects an array.`, 'where', { field: col })

  return value
}

function entryToTape(e: ExprBuilder<any>, col: string, value: unknown): ExprTape {
  if (value === undefined) {
    throw new ValidationError(
      `where: column "${col}" was given undefined. Pass null to match IS NULL, or omit the key.`,
      'where',
      { field: col },
    )
  }

  if (value === null)
    return e.isNull(col)

  if (Array.isArray(value))
    return e.in(col, value)

  // A plain object is an operator map only when every key is an operator; anything else is a json/jsonb value compared for equality.
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    const opKeys = keys.filter(k => WHERE_OPS.has(k))

    if (opKeys.length > 0) {
      if (opKeys.length !== keys.length) {
        throw new ValidationError(
          `where: column "${col}" mixes operators with plain keys. Wrap a literal object value in { eq: … }.`,
          'where',
          { field: col },
        )
      }

      return andTapes(opKeys.map(k => opToTape(e, col, k, value[k])))
    }
  }

  return e.eq(col, value)
}

/** Compile either WHERE form to a tape. Exported so callers can compose a caller-supplied clause with their own conditions. */
export function compileWhere<TColumns extends AnyColumns>(where: WhereInput<TColumns>): ExprTape {
  const e = createExprBuilder<TColumns>()

  if (typeof where === 'function')
    return where(e)

  const entries = Object.entries(where as Record<string, unknown>)

  if (entries.length === 0)
    throw new ValidationError('where: the object shorthand needs at least one column; an empty object would match every row.', 'where')

  return andTapes(entries.map(([col, value]) => entryToTape(e as ExprBuilder<any>, col, value)))
}

/** Compile the truthy clauses in `conds` to tapes, dropping the falsy ones. */
function compile<TColumns extends AnyColumns>(conds: OptionalWhere<TColumns>[]): ExprTape[] {
  const tapes: ExprTape[] = []

  for (const cond of conds) {
    if (cond)
      tapes.push(compileWhere<TColumns>(cond))
  }

  return tapes
}

/** Replace `state.whereTape` with `where`'s tape. A falsy `where` leaves it untouched. */
export function replaceWhere<TColumns extends AnyColumns>(state: BuilderState, where: OptionalWhere<TColumns>): void {
  if (where)
    state.whereTape = compileWhere<TColumns>(where)
}

/** AND the truthy conditions onto `state.whereTape`, keeping any existing clause. */
export function appendWhere<TColumns extends AnyColumns>(state: BuilderState, conds: OptionalWhere<TColumns>[]): void {
  const tapes = compile(conds)

  if (state.whereTape)
    tapes.unshift(state.whereTape)

  if (tapes.length === 0)
    return

  state.whereTape = andTapes(tapes)
}
