import type { AnyColumnDef, AnyColumns, IsNullable } from '../types/index'
import type { ExprBuilder, ExprOp, ExprTape } from './expr'
import type { BuilderState } from './state'
import { ValidationError } from '../errors/index'
import { isPlainObject } from '../utils/collection'
import { createExprBuilder, OP_AND } from './expr'
import { scalarColumnsOf } from './state'

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
  /** Case-sensitive (LIKE); the i- forms ignore case (ILIKE). */
  contains?: string
  startsWith?: string
  endsWith?: string
  iContains?: string
  iStartsWith?: string
  iEndsWith?: string
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

/** {@link OptionalWhere} without the callback form, for an argument where a function means a select callback instead. */
export type OptionalWhereObject<TColumns extends AnyColumns> = Exclude<OptionalWhere<TColumns>, WhereFn<TColumns>>

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
  'iContains',
  'iStartsWith',
  'iEndsWith',
  'between',
  'isNull',
])

/** AND several tapes into one, returning the single tape unwrapped. */
// A tape whose root is an AND lends its operands rather than nesting, so chained andWhere() calls print one flat AND.
function andTapes(tapes: ExprTape[]): ExprTape {
  if (tapes.length === 1)
    return tapes[0]!

  const combined: ExprTape = [{ op: OP_AND, count: 0 } as ExprOp]
  let count = 0

  for (const tape of tapes) {
    const root = tape[0]

    if (root?.op === OP_AND) {
      count += root.count
      for (let i = 1; i < tape.length; i++) combined.push(tape[i]!)
    }
    else {
      count++
      for (const op of tape) combined.push(op)
    }
  }

  combined[0] = { op: OP_AND, count }

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
    case 'iContains': return e.iContains(col, value as string)
    case 'iStartsWith': return e.iStartsWith(col, value as string)
    case 'iEndsWith': return e.iEndsWith(col, value as string)
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

function entryToTape(e: ExprBuilder<any>, col: string, value: unknown, scalarColumns: ReadonlySet<string> | undefined): ExprTape {
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

  // A plain object is an operator map when every key is an operator, a value compared for equality on a json or geometric column, and refused on any other column of a known table.
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

    if (scalarColumns?.has(col)) {
      throw new ValidationError(
        `where: column "${col}" was given an object naming no operator (${keys.join(', ') || 'no keys'}). The operators are ${[...WHERE_OPS].join(', ')}.`,
        'where',
        { field: col, value },
      )
    }
  }

  return e.eq(col, value)
}

/**
 * Compile either WHERE form to a tape. Exported so callers can compose a caller-supplied clause with their own conditions.
 * Given the table's `columns`, an object naming no operator on a column that is not json or geometric throws instead of comparing as a literal.
 */
export function compileWhere<TColumns extends AnyColumns>(where: WhereInput<TColumns>, columns?: TColumns): ExprTape {
  return compileWith(where, columns && scalarColumnsOf(columns))
}

function compileWith<TColumns extends AnyColumns>(where: WhereInput<TColumns>, scalarColumns: ReadonlySet<string> | undefined): ExprTape {
  const e = createExprBuilder<TColumns>()

  if (typeof where === 'function')
    return where(e)

  const entries = Object.entries(where as Record<string, unknown>)

  if (entries.length === 0)
    throw new ValidationError('where: the object shorthand needs at least one column; an empty object would match every row.', 'where')

  return andTapes(entries.map(([col, value]) => entryToTape(e as ExprBuilder<any>, col, value, scalarColumns)))
}

/** Compile the truthy clauses in `conds` to tapes, dropping the falsy ones. */
function compile<TColumns extends AnyColumns>(conds: OptionalWhere<TColumns>[], scalarColumns: ReadonlySet<string> | undefined): ExprTape[] {
  const tapes: ExprTape[] = []

  for (const cond of conds) {
    if (cond)
      tapes.push(compileWith<TColumns>(cond, scalarColumns))
  }

  return tapes
}

/**
 * `{ [column]: condition }` for a column named at runtime (a query string, a route config), typed for the table without a cast.
 * `condition` is what the object form takes for a column: a value, an array, null or an operator map. A name the table does not have throws `ValidationError`.
 */
export function whereColumn<TColumns extends AnyColumns>(table: { readonly name: string, readonly columns: TColumns }, column: string, condition: unknown): WhereObject<TColumns> {
  if (!Object.hasOwn(table.columns, column))
    throw new ValidationError(`"${table.name}" has no column "${column}"`, 'whereColumn', { field: column })

  return { [column]: condition } as WhereObject<TColumns>
}

/** Replace `state.whereTape` with `where`'s tape. A falsy `where` leaves it untouched. */
export function replaceWhere<TColumns extends AnyColumns>(state: BuilderState, where: OptionalWhere<TColumns>): void {
  if (where)
    state.whereTape = compileWith<TColumns>(where, state.scalarColumns)
}

/** AND the truthy conditions onto `state.whereTape`, keeping any existing clause. */
export function appendWhere<TColumns extends AnyColumns>(state: BuilderState, conds: OptionalWhere<TColumns>[]): void {
  const tapes = compile(conds, state.scalarColumns)

  if (state.whereTape)
    tapes.unshift(state.whereTape)

  if (tapes.length === 0)
    return

  state.whereTape = andTapes(tapes)
}
