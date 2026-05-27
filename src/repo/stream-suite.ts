import type { ExprBuilder, ExprTape } from '../builder/expr'
import type { AnyColumns, AnyRelations, AnyVirtuals, WithVirtuals } from '../types/index'
import type { RepositoryCtx } from './context'
import type { ReadSuite } from './read-suite'
import { SelectBuilder } from '../builder/query'
import { DEFAULT_STREAM_CHUNK_SIZE } from '../constants'
import { hasHooks, runHooksAsync } from '../hooks/index'
import { mapChunk } from '../mapper/index'

/**
 * Streaming async iterators — `stream` (LIMIT/OFFSET chunked) and `streamCursor`
 * (keyset, safe for mutable data). Created lazily on first access via `repo.stream`.
 */
export class StreamSuite<
  TColumns extends AnyColumns,
  TRelations extends AnyRelations = {},
  TVirtuals extends AnyVirtuals = {},
> {
  private static _streamWarned = false

  constructor(
    private _ctx: RepositoryCtx,
    private _read: () => ReadSuite<TColumns, TRelations, TVirtuals>,
  ) {}

  /**
   * Streaming via async iterator — JIT mapper applied per chunk, not per row.
   *
   * **WARNING:** Uses LIMIT/OFFSET chunking. If rows are inserted or deleted during
   * iteration, rows may be skipped or duplicated. For correctness on mutable data,
   * use `streamCursor()` or run inside a REPEATABLE READ transaction.
   *
   * Pass `{ unsafe: true }` to acknowledge this behavior and suppress the warning.
   */
  async* stream(
    cb?: (q: SelectBuilder<TColumns, TRelations>) => SelectBuilder<TColumns, TRelations, any>,
    opts: { chunkSize?: number, unsafe?: boolean } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    if (!opts.unsafe && !StreamSuite._streamWarned) {
      StreamSuite._streamWarned = true
      const msg = '[pg-orm] stream() uses LIMIT/OFFSET chunking — rows may be skipped or duplicated if data changes during iteration. '
        + 'Use streamCursor() or a REPEATABLE READ transaction for correctness. '
        + 'Pass { unsafe: true } to suppress this warning.'
      const exec = this._ctx.executor as { _onCallbackError?: (event: { kind: 'streamWarning', error: unknown }) => void }

      if (exec._onCallbackError) {
        exec._onCallbackError({ kind: 'streamWarning', error: new Error(msg) })
      }
      else {
        console.warn(msg)
      }
    }

    const builder = new SelectBuilder<TColumns, TRelations>(this._ctx.table.name)
    const finalBuilder = cb ? cb(builder) : builder
    const chunkSize = opts.chunkSize ?? finalBuilder.getState().streamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
    let offset = 0
    const mapper = this._ctx.getMapper(finalBuilder)

    this._ctx.runtime.applyPreSelect(finalBuilder)

    while (true) {
      const chunkBuilder = finalBuilder.branch()

      const chunkState = chunkBuilder.getState()

      chunkState.limit = chunkSize
      chunkState.offset = offset
      const { sql, params } = chunkBuilder.toSQL()
      const rows = await this._ctx.query(sql, params)

      if (rows.length === 0)
        break

      let mapped = mapChunk(mapper, rows) as WithVirtuals<TColumns, TVirtuals>[]

      if (hasHooks(this._ctx.table, 'afterSelect')) {
        mapped = await runHooksAsync(this._ctx.table, 'afterSelect', mapped)
      }

      mapped = this._ctx.runtime.applyVirtuals(mapped)

      for (const row of mapped) {
        yield row
      }

      if (rows.length < chunkSize)
        break

      offset += chunkSize
    }
  }

  /**
   * Cursor-based streaming via async iterator — uses keyset pagination internally.
   * Unlike `stream()`, this is safe for mutable data (no skipped/duplicated rows).
   *
   * Requires an ordered column (defaults to the primary key).
   *
   * @example
   * ```ts
   * for await (const row of repo.stream.streamCursor({ chunkSize: 100 })) {
   *   console.log(row)
   * }
   * ```
   */
  async* streamCursor(
    opts: {
      chunkSize?: number
      column?: keyof TColumns & string
      direction?: 'forward' | 'backward'
      where?: (e: ExprBuilder<TColumns>) => ExprTape
    } = {},
  ): AsyncGenerator<WithVirtuals<TColumns, TVirtuals>, void, undefined> {
    const chunkSize = opts.chunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
    const col = opts.column ?? (this._ctx.runtime.primaryKey as keyof TColumns & string)
    const direction = opts.direction ?? 'forward'
    let cursor: unknown
    const read = this._read()

    while (true) {
      const result = await read.paginateCursor({
        take: chunkSize,
        column: col,
        cursor: cursor as never,
        direction,
        where: opts.where,
      })

      for (const row of result.data) {
        yield row
      }

      if (result.nextCursor == null)
        break

      cursor = result.nextCursor
    }
  }
}
