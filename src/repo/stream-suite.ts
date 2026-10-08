import type { OptionalWhereObject, SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, InferVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { StreamCursorOptions } from './read-pipeline'
import type { RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { ReadPipeline } from './read-pipeline'

interface StreamOffsetOptions {
  chunkSize?: number
  unsafe?: boolean
}

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
  offset<TResult>(cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>, opts?: StreamOffsetOptions): AsyncGenerator<TResult & InferVirtuals<TVirtuals>, void, undefined>
  offset(where?: OptionalWhereObject<TColumns>, opts?: StreamOffsetOptions): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined>
  offset(
    arg?: ((q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>) | OptionalWhereObject<TColumns>,
    opts: StreamOffsetOptions = {},
  ): AsyncGenerator<any, void, undefined> {
    return this._pipeline.stream(arg, opts)
  }

  /** Rows in keyset chunks ordered by `column` then the primary key, stable while the table changes. The optional callback shapes rows (`pick`, `include`, a WHERE) but leaves order and limit to the cursor. */
  cursor(opts?: StreamCursorOptions<TColumns>): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined>
  cursor<TResult>(opts: StreamCursorOptions<TColumns>, cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult>): AsyncGenerator<TResult & InferVirtuals<TVirtuals>, void, undefined>
  cursor(opts: StreamCursorOptions<TColumns> = {}, cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>): AsyncGenerator<any, void, undefined> {
    return this._pipeline.streamCursor(opts, cb)
  }
}
