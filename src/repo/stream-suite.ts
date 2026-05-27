import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { SelectBuilder } from '../builder/query'
import type { Executable } from '../sql/executor'
import type { AnyColumns, AnyRelations, AnyVirtuals, WithVirtuals } from '../types/index'
import type { MapperFactory } from './ops/_mapper'
import type { RelationResolver } from './relation-resolver'
import type { TableRuntime } from './table-runtime'
import { stream } from './ops/stream'
import { streamCursor } from './ops/stream-cursor'

/** Stream coordinator — `stream` (LIMIT/OFFSET) + `streamCursor` (keyset). */
export class StreamSuite<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  constructor(
    private _exec: Executable,
    private _rt: TableRuntime,
    private _rel: RelationResolver,
    private _map: MapperFactory,
  ) {}

  stream(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
    opts: { chunkSize?: number, unsafe?: boolean } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return stream<TColumns, TRelations>(this._exec, this._rt, this._map, cb, opts)
  }

  streamCursor(opts: {
    chunkSize?: number
    column?: keyof TColumns & string
    direction?: 'forward' | 'backward'
    where?: (e: ExprBuilder<TColumns>) => ExprTape
  } = {}): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    return streamCursor<TColumns, TRelations>(this._exec, this._rt, this._rel, this._map, opts)
  }
}
