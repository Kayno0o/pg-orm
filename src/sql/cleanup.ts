import type { SQL } from 'bun'
import { asDriver } from './adapter'

interface Closable { sql: InstanceType<typeof SQL> }

const activeInstances = new Set<WeakRef<Closable>>()
let cleanupRegistered = false

function closeInstance(instance: Closable): void {
  try {
    // Fire-and-forget — process is exiting, we just need to initiate the close
    void asDriver(instance.sql).close({ timeout: 1000 })
  }
  catch {
    // best-effort — connection may already be closed
  }
}

function cleanup(): void {
  for (const ref of activeInstances) {
    const instance = ref.deref()

    if (instance)
      closeInstance(instance)
  }

  activeInstances.clear()
}

function registerCleanupHandlers(): void {
  if (cleanupRegistered)
    return

  cleanupRegistered = true

  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(143)
  })
  process.on('beforeExit', cleanup)
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
