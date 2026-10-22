import { AsyncLocalStorage } from 'node:async_hooks'
import { AbortError } from '../errors/index'

/** The signal `Database.withSignal(signal, fn)` binds for every statement run inside `fn`. */
export const querySignalStorage = new AsyncLocalStorage<AbortSignal>()

export function throwIfAborted(signal: AbortSignal | undefined, query = '', params: unknown[] = []): void {
  if (signal?.aborted)
    throw new AbortError(query, params, signal.reason)
}

// Bun rejects a cancelled statement with the server's 57014, or with its own code when the statement was never sent.
export function isCancellation(err: unknown): boolean {
  const { errno, code } = err as { errno?: string, code?: string }

  return errno === '57014' || code === 'ERR_POSTGRES_QUERY_CANCELLED'
}
