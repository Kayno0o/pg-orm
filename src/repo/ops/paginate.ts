import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, AnyRelations, InferSelect } from '../../types/index'
import type { RelationResolver } from '../relation-resolver'
import type { TableRuntime } from '../table-runtime'
import type { MapperFactory } from './_mapper'
import { count } from './count'
import { findMany } from './find-many'

export async function paginate<TC extends AnyColumns, TR extends AnyRelations>(
  executor: Executable,
  runtime: TableRuntime,
  relations: RelationResolver,
  mapper: MapperFactory,
  opts: { page: number, perPage: number, where?: (e: ExprBuilder<TC>) => ExprTape },
): Promise<{ data: any[], total: number, page: number, perPage: number, totalPages: number }> {
  const { page, perPage, where: whereFn } = opts

  const [data, total] = await Promise.all([
    findMany<TC, TR>(executor, runtime, relations, mapper, (q) => {
      let b = q.limit(perPage).offset((page - 1) * perPage)

      if (whereFn)
        b = b.where(whereFn)

      return b
    }, undefined),
    count<TC>(executor, runtime, whereFn),
  ])

  return { data, total, page, perPage, totalPages: Math.ceil(total / perPage) }
}

export async function paginateCursor<TC extends AnyColumns, TR extends AnyRelations, K extends keyof TC & string>(
  executor: Executable,
  runtime: TableRuntime,
  relations: RelationResolver,
  mapper: MapperFactory,
  opts: {
    take: number
    column?: K
    cursor?: InferSelect<TC>[K] | null
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TC>) => ExprTape
  },
): Promise<{ data: any[], nextCursor: InferSelect<TC>[K] | null }> {
  const { take, cursor, direction = 'forward', where: whereFn } = opts
  const col = (opts.column ?? runtime.primaryKey) as keyof TC & string
  const isForward = direction === 'forward'

  const data = await findMany<TC, TR>(executor, runtime, relations, mapper, (q) => {
    let b = q.limit(take + 1).orderBy(col, isForward ? 'asc' : 'desc')

    if (whereFn)
      b = b.where(whereFn)

    if (cursor != null) {
      b = b.andWhere(e => isForward ? e.gt(col, cursor) : e.lt(col, cursor))
    }

    return b
  }, undefined)

  const hasMore = data.length > take

  if (hasMore)
    data.pop()

  if (!isForward)
    data.reverse()

  const lastRow = data.at(-1) as Record<string, unknown> | undefined
  const nextCursor = (hasMore && lastRow ? lastRow[col] : null) as InferSelect<TC>[K] | null

  return { data, nextCursor }
}
