import type { OptionalWhere, SelectBuilder, WhereFn, WhereInput } from '../builder/query'
import type { AnyColumns, AnyRelations, ColumnConstraint, InferPrimaryKey, InferSelect, PrimaryKeyColumn, ScopeOptions } from '../types/index'
import type { TableRuntime } from './table-runtime'
import { SelectBuilder as SelectBuilderCtor } from '../builder/query'
import { selectedColumns } from '../builder/state'
import { messageValue, ValidationError } from '../errors/index'
import { columnBaseType } from '../schema/inspect'
import { isPlainObject } from '../utils/collection'
import { quote } from '../utils/quote'
import { liftedScopes } from './table-behavior'
import { isKeyValue } from './table-runtime'

const TIMESTAMP_TYPES = new Set(['timestamp', 'timestamptz'])

export type SelectCb<TC extends AnyColumns, TR extends AnyRelations, TResult = any> = (q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, TResult, any, any>

/** The page size a public paginate call may ask; a stream paging internally passes none. */
export interface PageLimits {
  maxPageSize?: number
}

export function checkPageSize(op: string, name: string, size: number, limits?: PageLimits): void {
  if (!Number.isInteger(size) || size < 1)
    throw new ValidationError(`${op}() requires ${name} >= 1, got ${messageValue(size)}`, op, { value: size })

  if (limits?.maxPageSize !== undefined && size > limits.maxPageSize)
    throw new ValidationError(`${op}() allows ${name} up to ${limits.maxPageSize} (DbConfig.maxPageSize), got ${messageValue(size)}`, op, { value: size })
}

/** Where a cursor page resumes: the primary key when ordering by it, else the column's value and the key that breaks its ties. */
export type CursorOf<TColumns extends AnyColumns, K extends keyof TColumns & string>
  = [K] extends [PrimaryKeyColumn<TColumns>]
    ? InferPrimaryKey<TColumns>
    : { value: InferSelect<TColumns>[K], key: InferPrimaryKey<TColumns> }

export interface PaginateCursorOptions<TColumns extends AnyColumns, K extends keyof TColumns & string> extends ScopeOptions {
  take: number
  /** The column to order by, the primary key by default. Ties are broken by the primary key; a nullable column is refused. */
  column?: K
  cursor?: CursorOf<TColumns, K> | null
  direction?: 'forward' | 'backward'
  where?: OptionalWhere<TColumns>
}

export interface PaginateCursorResult<TRow, TCursor> {
  data: TRow[]
  nextCursor: TCursor | null
}

/** What a cursor page needs of the pipeline reading it: the table's runtime, the read itself, and the scope and relation preparation every read gets. */
export interface CursorReader<TColumns extends AnyColumns, TRelations extends AnyRelations> {
  runtime: TableRuntime
  findMany: (cb: SelectCb<TColumns, TRelations>) => Promise<any[]>
  prepare: (builder: SelectBuilder<any, any, any>) => void
}

// Keyset paging on (column, primary key): a row-value comparison resumes after the cursor, so tied values are neither skipped nor repeated. A backward page is read descending, its cursor taken from the last row read, then reversed.
export async function paginateCursor<TColumns extends AnyColumns, TRelations extends AnyRelations>(
  reader: CursorReader<TColumns, TRelations>,
  opts: PaginateCursorOptions<TColumns, any>,
  cb?: SelectCb<TColumns, TRelations>,
  limits?: PageLimits,
): Promise<PaginateCursorResult<any, unknown>> {
  const { take, cursor, direction = 'forward', where } = opts
  const { keys, byKey } = cursorKeys(reader.runtime, opts.column)
  const isForward = direction === 'forward'

  checkPageSize('paginateCursor', 'take', take, limits)

  const data = await reader.findMany((q) => {
    const b = cb ? cb(q) : q
    const state = b.getState()

    if (state.orderBy.length > 0 || state.limit != null || state.offset != null)
      throw new ValidationError('paginateCursor(): the callback must not set orderBy, limit or offset, which the cursor owns.', 'paginateCursor')

    reader.prepare(b)

    const picked = selectedColumns(state)

    if (picked && keys.some(k => !picked.includes(k)))
      throw new ValidationError(`paginateCursor(): the callback's pick() or omit() leaves out a cursor column (${keys.join(', ')}).`, 'paginateCursor')

    b.andWhere(where).limit(take + 1).withoutScope(...liftedScopes(opts))

    for (const key of keys)
      b.orderBy(key, isForward ? 'asc' : 'desc')

    if (cursor != null)
      b.andWhere(afterCursor(reader, keys, cursorValues(reader.runtime, cursor, keys, byKey), isForward, state.withoutScopes))

    return b
  })

  const hasMore = data.length > take

  if (hasMore)
    data.pop()

  const boundary = data.at(-1) as Record<string, unknown> | undefined
  const nextCursor = hasMore && boundary ? cursorOf(reader.runtime, boundary, keys, byKey) : null

  if (!isForward)
    data.reverse()

  return { data, nextCursor }
}

// The ordering columns: the primary key (led by `column` when it is part of it), or `column` then the key.
function cursorKeys(runtime: TableRuntime, column: string | undefined): { keys: string[], byKey: boolean } {
  const { pkColumns, table } = runtime

  runtime.requireKey('paginateCursor()')

  const byKey = column === undefined || pkColumns.includes(column)
  const keys = byKey ? [...column ? [column] : [], ...pkColumns.filter(c => c !== column)] : [column, ...pkColumns]
  const nullable = keys.find(k => !table.columns[k]?.constraints.some((c: ColumnConstraint) => c.type === 'not_null' || c.type === 'primary_key'))

  if (nullable !== undefined)
    throw new ValidationError(`paginateCursor(): "${table.name}"."${nullable}" is nullable, and a cursor cannot order past its NULLs.`, 'paginateCursor', { field: nullable })

  return { keys, byKey }
}

function cursorOf(runtime: TableRuntime, row: Record<string, unknown>, keys: string[], byKey: boolean): unknown {
  const { pkColumns } = runtime
  const pk = pkColumns.length === 1 ? row[pkColumns[0]!] : Object.fromEntries(pkColumns.map(c => [c, row[c]]))

  return byKey ? pk : { value: row[keys[0]!], key: pk }
}

// A cursor is opaque but comes back from a client: one that is not the shape this table's pages return would bind `undefined` or match nothing.
function cursorValues(runtime: TableRuntime, cursor: unknown, keys: string[], byKey: boolean): unknown[] {
  const { pkColumns, table } = runtime
  const parts = byKey ? cursor : isPlainObject(cursor) ? cursor.key : undefined
  const pk = (col: string): unknown => pkColumns.length === 1 ? parts : isPlainObject(parts) ? parts[col] : undefined
  const values = keys.map(k => pkColumns.includes(k) ? pk(k) : isPlainObject(cursor) ? cursor.value : undefined)

  if (!values.every(isKeyValue))
    throw new ValidationError(`paginateCursor(): the cursor is not one a page of "${table.name}" ordered by ${keys.join(', ')} returns.`, 'paginateCursor')

  return values
}

function afterCursor<TColumns extends AnyColumns, TRelations extends AnyRelations>(reader: CursorReader<TColumns, TRelations>, keys: string[], values: unknown[], isForward: boolean, lifted: string[]): WhereFn<TColumns> {
  const op = isForward ? '>' : '<'

  if (keys.length === 1)
    return e => isForward ? e.gt(keys[0]! as keyof TColumns & string, values[0] as never) : e.lt(keys[0]! as keyof TColumns & string, values[0] as never)

  const { pkColumns, table } = reader.runtime
  const [column, ...rest] = keys as [keyof TColumns & string, ...string[]]

  if (!TIMESTAMP_TYPES.has(columnBaseType(table.columns[column]!).base) || pkColumns.includes(column))
    return e => e.raw(`(${keys.map(quote).join(', ')}) ${op} (${keys.map(() => '?').join(', ')})`, ...values)

  // A Date holds milliseconds where Postgres keeps microseconds, so the boundary row's own value is read back by its key, through the scopes the page reads with; the carried one stands in when that row is gone or hidden.
  const boundaryRow = new SelectBuilderCtor<TColumns>(table).pick(column).where(reader.runtime.pkWhere(pkColumns.length === 1 ? values[1] : Object.fromEntries(pkColumns.map((c, i) => [c, values[i + 1]]))) as WhereInput<TColumns>).withoutScope(...lifted)

  reader.prepare(boundaryRow)

  // The row comparison `(column, key) > (boundary, key value)`, spelled out so the boundary can be a subquery; the planner then seeks on `column >= boundary` and filters the ties, slower only over long runs of equal values.
  return (e) => {
    const boundary = e.coalesce(e.scalar(boundaryRow), values[0] as never)
    const afterKey = e.raw(`(${rest.map(quote).join(', ')}) ${op} (${rest.map(() => '?').join(', ')})`, ...values.slice(1))

    return isForward
      ? e.and(e.gte(column, boundary), e.or(e.gt(column, boundary), afterKey))
      : e.and(e.lte(column, boundary), e.or(e.lt(column, boundary), afterKey))
  }
}
