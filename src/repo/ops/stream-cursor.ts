import type { ExprBuilder, ExprTape } from '../../builder/expr'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, AnyRelations } from '../../types/index'
import type { RelationResolver } from '../relation-resolver'
import type { TableRuntime } from '../table-runtime'
import type { MapperFactory } from './_mapper'
import { DEFAULT_STREAM_CHUNK_SIZE } from '../../constants'
import { paginateCursor } from './paginate'

export async function* streamCursor<TC extends AnyColumns, TR extends AnyRelations>(
  executor: Executable,
  runtime: TableRuntime,
  relations: RelationResolver,
  mapper: MapperFactory,
  opts: {
    chunkSize?: number
    column?: keyof TC & string
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TC>) => ExprTape
  } = {},
): AsyncGenerator<any, void, undefined> {
  const chunkSize = opts.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
  const col = opts.column ?? (runtime.primaryKey as keyof TC & string)
  const direction = opts.direction ?? 'forward'
  let cursor: unknown

  while (true) {
    const result = await paginateCursor<TC, TR, typeof col>(executor, runtime, relations, mapper, {
      take: chunkSize,
      column: col,
      cursor: cursor as never,
      direction,
      where: opts.where,
    })

    for (const row of result.data)
      yield row

    if (result.nextCursor == null)
      break

    cursor = result.nextCursor
  }
}
