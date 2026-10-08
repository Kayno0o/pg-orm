import type { OptionalWhere, OptionalWhereObject, SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { ReadPipeline } from './read-pipeline'

/** Stream coordinator: `offset` (LIMIT/OFFSET chunks) and `cursor` (keyset). */
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

  /** Rows in LIMIT/OFFSET chunks, filtered by a WHERE object or shaped by a select callback. Rows may be skipped or repeated if the table changes meanwhile. */
  offset(
    arg?: ((q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>) | OptionalWhereObject<TColumns>,
    opts: { chunkSize?: number, unsafe?: boolean } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._pipeline.stream(arg, opts)
  }

  /** Rows in keyset chunks ordered by `column` (the primary key by default), stable while the table changes. */
  cursor(opts: {
    chunkSize?: number
    column?: keyof TColumns & string
    direction?: 'forward' | 'backward'
    where?: OptionalWhere<TColumns>
  } = {}): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return this._pipeline.streamCursor(opts)
  }
}
