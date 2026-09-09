import type { OptionalWhere, SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { ReadPipeline } from './read-pipeline'

/** Stream coordinator — `stream` (LIMIT/OFFSET) + `streamCursor` (keyset). */
export class StreamSuite<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  private _pipeline: ReadPipeline<TColumns, TRelations, TVirtuals>

  constructor(
    exec: Executable,
    rt: TableRuntime,
    rel: RelationResolver,
    map: MapperFactory,
    tableRegistry?: ReadonlyMap<string, AnyTableDef>,
  ) {
    this._pipeline = new ReadPipeline<TColumns, TRelations, TVirtuals>({
      executor: exec,
      runtime: rt,
      relations: rel,
      mapper: map,
      tableRegistry,
    })
  }

  stream(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
    opts: { chunkSize?: number, unsafe?: boolean } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._pipeline.stream(cb, opts)
  }

  streamCursor(opts: {
    chunkSize?: number
    column?: keyof TColumns & string
    direction?: 'forward' | 'backward'
    where?: OptionalWhere<TColumns>
  } = {}): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._pipeline.streamCursor(opts)
  }
}
