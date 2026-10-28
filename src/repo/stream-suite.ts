import type { OptionalWhereObject, SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyTableDef, AnyVirtuals, HookContext, InferVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './_mapper'
import type { CopyToOptions, StreamCursorOptions } from './read-pipeline'
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
    tableRegistry: ReadonlyMap<string, AnyTableDef> | undefined,
    hooks: HookContext,
  ) {
    this._pipeline = new ReadPipeline<TColumns, TRelations, TVirtuals>({
      executor: exec,
      runtime: rt,
      relations: rel,
      mapper: map,
      hooks,
      tableRegistry,
    })
  }

  /**
   * Rows in LIMIT/OFFSET chunks, filtered by a WHERE object or shaped by a select callback. Rows may be skipped or repeated if the table changes meanwhile.
   * Each chunk rescans the rows before it, so the whole stream costs quadratic time: use `cursor()` on a large table.
   */
  offset<TResult>(cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult, any, any>, opts?: StreamOffsetOptions): AsyncGenerator<TResult & InferVirtuals<TVirtuals>, void, undefined>
  offset(where?: OptionalWhereObject<TColumns>, opts?: StreamOffsetOptions): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined>
  offset(
    arg?: ((q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any, any, any>) | OptionalWhereObject<TColumns>,
    opts: StreamOffsetOptions = {},
  ): AsyncGenerator<any, void, undefined> {
    return this._pipeline.stream(arg, opts)
  }

  /** Rows in keyset chunks ordered by `column` then the primary key, stable while the table changes. The optional callback shapes rows (`pick`, `include`, a WHERE) but leaves order and limit to the cursor. */
  cursor(opts?: StreamCursorOptions<TColumns>): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined>
  cursor<TResult>(opts: StreamCursorOptions<TColumns>, cb: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, TResult, any, any>): AsyncGenerator<TResult & InferVirtuals<TVirtuals>, void, undefined>
  cursor(opts: StreamCursorOptions<TColumns> = {}, cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any, any, any>): AsyncGenerator<any, void, undefined> {
    return this._pipeline.streamCursor(opts, cb)
  }

  /**
   * The table's rows as CSV through Postgres `COPY ... TO STDOUT`, a stream that can go straight into a `Response`; the statement runs once the stream is read.
   * Skips virtuals and hooks; trashed rows stay out unless `withTrashed`. Postgres only.
   */
  copyTo(opts?: CopyToOptions<TColumns>): ReadableStream<Uint8Array> {
    return this._pipeline.copyTo(opts)
  }
}
