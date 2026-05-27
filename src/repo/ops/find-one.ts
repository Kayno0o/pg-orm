import type { SelectBuilder } from '../../builder/query'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, AnyRelations } from '../../types/index'
import type { RelationResolver } from '../relation-resolver'
import type { TableRuntime } from '../table-runtime'
import type { MapperFactory } from './_mapper'
import { NotFoundError } from '../../errors/index'
import { findMany } from './find-many'

export async function findOne<TC extends AnyColumns, TR extends AnyRelations>(
  executor: Executable,
  runtime: TableRuntime,
  relations: RelationResolver,
  mapper: MapperFactory,
  cb: ((q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, any>) | undefined,
): Promise<any | null> {
  const wrapped = cb
    ? (q: SelectBuilder<TC, TR>) => cb(q).limit(1)
    : (q: SelectBuilder<TC, TR>) => q.limit(1) as SelectBuilder<TC, TR, any>
  const rows = await findMany(executor, runtime, relations, mapper, wrapped, undefined)

  return rows[0] ?? null
}

export async function findOneOrThrow<TC extends AnyColumns, TR extends AnyRelations>(
  executor: Executable,
  runtime: TableRuntime,
  relations: RelationResolver,
  mapper: MapperFactory,
  cb: ((q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, any>) | undefined,
): Promise<unknown> {
  const row = await findOne(executor, runtime, relations, mapper, cb)

  if (row === null)
    throw new NotFoundError(runtime.table.name)

  return row
}

export async function findById<TC extends AnyColumns, TR extends AnyRelations>(
  executor: Executable,
  runtime: TableRuntime,
  relations: RelationResolver,
  mapper: MapperFactory,
  id: unknown,
): Promise<any | null> {
  const pk = runtime.primaryKey

  if (pk.includes(',')) {
    const pkCols = pk.split(',')

    return findOne<TC, TR>(executor, runtime, relations, mapper, q =>
      q.where((e) => {
        const conditions = pkCols.map(col =>
          e.eq(col.trim(), (id as Record<string, unknown>)[col.trim()]),
        )

        return e.and(...conditions)
      }))
  }

  return findOne<TC, TR>(executor, runtime, relations, mapper, q => q.where(e => e.eq(pk, id)))
}
