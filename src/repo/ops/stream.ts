import type { SelectBuilder } from '../../builder/query'
import type { Executable } from '../../sql/executor'
import type { AnyColumns, AnyRelations } from '../../types/index'
import type { TableRuntime } from '../table-runtime'
import type { MapperFactory } from './_mapper'
import { SelectBuilder as SelectBuilderCtor } from '../../builder/query'
import { DEFAULT_STREAM_CHUNK_SIZE } from '../../constants'
import { hasHooks, runHooksAsync } from '../../hooks/index'
import { mapChunk } from '../../mapper/index'

let _streamWarned = false

export async function* stream<TC extends AnyColumns, TR extends AnyRelations>(
  executor: Executable,
  runtime: TableRuntime,
  mapper: MapperFactory,
  cb: ((q: SelectBuilder<TC, TR>) => SelectBuilder<TC, TR, any>) | undefined,
  opts: { chunkSize?: number, unsafe?: boolean } = {},
): AsyncGenerator<any, void, undefined> {
  if (!opts.unsafe && !_streamWarned) {
    _streamWarned = true
    const msg = '[pg-orm] stream() uses LIMIT/OFFSET chunking — rows may be skipped or duplicated if data changes during iteration. '
      + 'Use streamCursor() or a REPEATABLE READ transaction for correctness. '
      + 'Pass { unsafe: true } to suppress this warning.'
    const exec = executor as { _onCallbackError?: (event: { kind: 'streamWarning', error: unknown }) => void }

    if (exec._onCallbackError)
      exec._onCallbackError({ kind: 'streamWarning', error: new Error(msg) })
    else
      console.warn(msg)
  }

  const builder = new SelectBuilderCtor<TC, TR>(runtime.table.name)
  const finalBuilder = cb ? cb(builder) : builder
  const chunkSize = opts.chunkSize ?? finalBuilder.getState().streamChunkSize ?? DEFAULT_STREAM_CHUNK_SIZE
  let offset = 0
  const mapperFn = mapper(finalBuilder)

  runtime.applyPreSelect(finalBuilder)

  while (true) {
    const chunkBuilder = finalBuilder.branch()
    const chunkState = chunkBuilder.getState()

    chunkState.limit = chunkSize
    chunkState.offset = offset
    const { sql, params } = chunkBuilder.toSQL()
    const rows = await executor.query(sql, params)

    if (rows.length === 0)
      break

    let mapped = mapChunk(mapperFn, rows)

    if (hasHooks(runtime.table, 'afterSelect'))
      mapped = await runHooksAsync(runtime.table, 'afterSelect', mapped)

    mapped = runtime.applyVirtuals(mapped)

    for (const row of mapped)
      yield row

    if (rows.length < chunkSize)
      break

    offset += chunkSize
  }
}
