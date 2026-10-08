import type { SQL } from 'bun'
import type { CallbackErrorEvent } from './base-executor'
import { asDriver } from './adapter'
import { reportCallbackError } from './base-executor'

// What `cleanup.ts` requires of a registered instance; `onCallbackError`'s channel receives a failed close.
interface Closable {
  sql: InstanceType<typeof SQL>
  _onCallbackError?: (event: CallbackErrorEvent) => void
}

const activeInstances = new Set<WeakRef<Closable>>()
let cleanupRegistered = false

/**
 * @internal
 */
export async function closeInstance(instance: Closable): Promise<void> {
  try {
    // Seconds, as Bun's SQL counts them.
    await asDriver(instance.sql).close({ timeout: 1 })
  }
  catch (err) {
    reportCallbackError(instance._onCallbackError, { kind: 'shutdownCloseError', error: err })
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

  // No SIGINT/SIGTERM handler: the app owns its shutdown (`db.close({ drain: true })`), and a library listener would replace the runtime's default exit.
  process.on('beforeExit', () => {
    // beforeExit can be re-entered if cleanup schedules more I/O. Allowing the
    // promise to run keeps the event loop alive until it settles.
    void cleanup()
  })
}

/**
 * Register a closable instance, closed once the event loop runs dry. Returns the WeakRef so
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
