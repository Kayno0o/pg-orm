import type { SQL } from 'bun'
import { asDriver } from './adapter'

export interface ShutdownErrorEvent {
  kind: 'shutdownCloseError'
  error: unknown
}

/**
 * The shape `cleanup.ts` requires of registered instances. Database conforms
 * via structural typing — the kind union here is a subset of Database's
 * (which also includes onCommit/onRollback/streamWarning).
 */
interface Closable {
  sql: InstanceType<typeof SQL>
  /**
   * Optional channel for surfacing shutdown-close failures. Mirrors the
   * `onCallbackError` channel used for transaction commit/rollback callbacks
   * (see `Database._onCallbackError`). If unset, errors fall back to
   * `console.warn`.
   */
  _onCallbackError?: (event: { kind: 'onCommit' | 'onRollback' | 'streamWarning' | 'shutdownCloseError', error: unknown }) => void
}

const activeInstances = new Set<WeakRef<Closable>>()
let cleanupRegistered = false

function reportShutdownError(instance: Closable, error: unknown): void {
  const channel = instance._onCallbackError

  if (channel) {
    try {
      channel({ kind: 'shutdownCloseError', error })

      return
    }
    catch (channelErr) {
      // The user's channel itself threw. Drop to console as last resort so
      // both errors are visible.
      console.warn('pg-orm: onCallbackError handler threw during shutdown:', channelErr)
    }
  }

  console.warn('pg-orm: shutdown close failed:', error)
}

/**
 * @internal
 */
export async function closeInstance(instance: Closable): Promise<void> {
  try {
    await asDriver(instance.sql).close({ timeout: 1000 })
  }
  catch (err) {
    reportShutdownError(instance, err)
  }
}

/**
 * @internal
 */
export async function cleanup(): Promise<void> {
  const tasks: Promise<void>[] = []

  for (const ref of activeInstances) {
    const instance = ref.deref()

    if (instance)
      tasks.push(closeInstance(instance))
  }

  activeInstances.clear()

  await Promise.allSettled(tasks)
}

function registerCleanupHandlers(): void {
  if (cleanupRegistered)
    return

  cleanupRegistered = true

  process.on('SIGINT', () => {
    cleanup().finally(() => process.exit(130))
  })
  process.on('SIGTERM', () => {
    cleanup().finally(() => process.exit(143))
  })
  process.on('beforeExit', () => {
    // beforeExit can be re-entered if cleanup schedules more I/O. Allowing the
    // promise to run keeps the event loop alive until it settles.
    void cleanup()
  })
}

/**
 * Register a closable instance for process-exit cleanup. Returns the WeakRef so
 * callers can pass it back to `unregisterInstance` when closing explicitly.
 */
export function registerInstance(instance: Closable): WeakRef<Closable> {
  const ref = new WeakRef(instance)

  activeInstances.add(ref)
  registerCleanupHandlers()

  return ref
}

export function unregisterInstance(ref: WeakRef<Closable>): void {
  activeInstances.delete(ref)
}

/**
 * @internal
 */
export function _activeInstanceCount(): number {
  return activeInstances.size
}
