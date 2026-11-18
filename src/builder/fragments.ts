import type { BuilderState, FrameBound, OrderEntry, WindowFrame } from './state'
import { ValidationError } from '../errors/index'
import { qualifyCol } from '../utils/quote'

export function quoteCols(cols: string[], qualifier?: string): string {
  return cols.map(col => qualifyCol(col, qualifier)).join(', ')
}

const ORDER_DIRS = new Map([['asc', 'ASC'], ['desc', 'DESC']])
const NULLS_POSITIONS = new Map([['first', 'FIRST'], ['last', 'LAST']])
const JOIN_TYPES = new Map([['inner', 'INNER'], ['left', 'LEFT'], ['right', 'RIGHT'], ['full', 'FULL']])
const LOCK_MODES = new Map([['update', 'UPDATE'], ['share', 'SHARE'], ['no_key_update', 'NO KEY UPDATE'], ['key_share', 'KEY SHARE']])
const FRAME_MODES = new Map([['rows', 'ROWS'], ['range', 'RANGE'], ['groups', 'GROUPS']])
const FRAME_EDGES = new Map([['unbounded preceding', 'UNBOUNDED PRECEDING'], ['current row', 'CURRENT ROW'], ['unbounded following', 'UNBOUNDED FOLLOWING']])
const FRAME_SIDES = new Map([['preceding', 'PRECEDING'], ['following', 'FOLLOWING']])

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

/** A window frame as SQL, every keyword read off a fixed table and every offset checked to be a whole number. */
export function frameClause(frame: WindowFrame): string {
  const mode = keyword(FRAME_MODES, frame.mode ?? 'rows', 'window frame mode')
  const from = frameBound(frame.from)

  return frame.to === undefined ? `${mode} ${from}` : `${mode} BETWEEN ${from} AND ${frameBound(frame.to)}`
}

function frameBound(bound: FrameBound): string {
  if (typeof bound === 'string')
    return keyword(FRAME_EDGES, bound, 'window frame bound')

  const entries = bound !== null && typeof bound === 'object' ? Object.entries(bound) : []
  const [side, offset] = entries.length === 1 ? entries[0]! : []

  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
    throw new ValidationError('A window frame bound is a keyword or one { preceding } or { following } offset, a whole number of 0 or more.', 'window frame bound', { value: bound })

  return `${offset} ${keyword(FRAME_SIDES, side, 'window frame bound')}`
}

export function formatOrderBy(entries: OrderEntry[], qualifier?: string): string {
  return entries.map(o => `${qualifyCol(o.col, qualifier)} ${orderSuffix(o)}`).join(', ')
}

/** What a SELECT's bare columns are prefixed with: its own table once it joins another, where a bare name could be ambiguous. */
export function joinQualifier(state: BuilderState): string | undefined {
  return state.joins.length > 0 ? state.alias ?? state.table : undefined
}
