import { AsyncLocalStorage } from 'node:async_hooks'
import { AbortError } from '../errors/index'

/** The signal `Database.withSignal(signal, fn)` binds for every statement run inside `fn`. */
export const querySignalStorage = new AsyncLocalStorage<AbortSignal>()

export function throwIfAborted(signal: AbortSignal | undefined, query = '', params: unknown[] = []): void {
  if (signal?.aborted)
    throw new AbortError(query, params, signal.reason)
}

/** Wait `ms`, unless `signal` aborts first, which throws `AbortError` at once. */
export async function sleepUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)

  if (!signal)
    return Bun.sleep(ms)

  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  const abort = (): void => {
    clearTimeout(timer)
    resolve()
  }

  signal.addEventListener('abort', abort, { once: true })

  try {
    await promise
  }
  finally {
    signal.removeEventListener('abort', abort)
  }

  throwIfAborted(signal)
}

// Bun rejects a cancelled statement with the server's 57014, or with its own code when the statement was never sent.
export function isCancellation(err: unknown): boolean {
  const { errno, code } = err as { errno?: string, code?: string }

  return errno === '57014' || code === 'ERR_POSTGRES_QUERY_CANCELLED'
}
