import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import {
  _activeInstanceCount,
  cleanup,
  closeInstance,
  registerInstance,
  unregisterInstance,
} from '../../../src/sql/cleanup'

const noop = (): undefined => undefined

interface MockClosable {
  sql: any
  _onCallbackError?: (event: { kind: string, error: unknown }) => void
}

function makeMock(opts: {
  closeReject?: unknown
  closeResolve?: boolean
  onCallbackError?: (event: { kind: string, error: unknown }) => void
}): MockClosable {
  const driver = {
    close: (_: { timeout: number }) =>
      opts.closeReject != null
        ? Promise.reject(opts.closeReject)
        : Promise.resolve(),
  }

  // asDriver() is a type cast — the test fixture must expose .close directly
  // on the same object so asDriver(instance.sql).close() resolves to driver.close.
  return {
    sql: driver,
    _onCallbackError: opts.onCallbackError,
  }
}

afterEach(() => {
  // Drain the active set between tests; cleanup() also empties it.
  // Use unregister loop to avoid invoking close() on stale mocks.
  // Best-effort — fine if it's already empty.
})

describe('registerInstance / unregisterInstance', () => {
  it('adds to the active set', () => {
    const before = _activeInstanceCount()
    const instance = makeMock({ closeResolve: true })
    const ref = registerInstance(instance)

    expect(_activeInstanceCount()).toBe(before + 1)

    unregisterInstance(ref)

    expect(_activeInstanceCount()).toBe(before)
  })

  it('unregister of unknown ref is a no-op', () => {
    const fakeRef = new WeakRef({ sql: {} } as any)
    const before = _activeInstanceCount()

    unregisterInstance(fakeRef)

    expect(_activeInstanceCount()).toBe(before)
  })

  it('register returns a WeakRef pointing back to the instance', () => {
    const instance = makeMock({ closeResolve: true })
    const ref = registerInstance(instance)

    expect(ref.deref()).toBe(instance)

    unregisterInstance(ref)
  })
})

describe('closeInstance error surfacing', () => {
  it('resolves when close succeeds', async () => {
    const instance = makeMock({ closeResolve: true })

    await expect(closeInstance(instance)).resolves.toBeUndefined()
  })

  it('routes close failure to _onCallbackError with shutdownCloseError kind', async () => {
    const events: { kind: string, error: unknown }[] = []
    const err = new Error('connection refused')
    const instance = makeMock({
      closeReject: err,
      onCallbackError: e => events.push(e),
    })

    await closeInstance(instance)

    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('shutdownCloseError')
    expect(events[0]!.error).toBe(err)
  })

  it('falls back to console.warn when no _onCallbackError is set', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(noop)
    const err = new Error('socket closed')
    const instance = makeMock({ closeReject: err })

    await closeInstance(instance)

    expect(warn).toHaveBeenCalledWith('pg-orm: shutdown close failed:', err)

    warn.mockRestore()
  })

  it('falls back to console.warn when the channel itself throws', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(noop)
    const closeErr = new Error('close failed')
    const channelErr = new Error('channel broken')
    const instance = makeMock({
      closeReject: closeErr,
      onCallbackError: () => {
        throw channelErr
      },
    })

    await closeInstance(instance)

    // Both calls happen: first the channel-broken warning, then the original close error
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[1]).toBe(channelErr)
    expect(warn.mock.calls[1]?.[1]).toBe(closeErr)

    warn.mockRestore()
  })
})

describe('cleanup()', () => {
  it('closes all registered instances and empties the active set', async () => {
    const instance1 = makeMock({ closeResolve: true })
    const instance2 = makeMock({ closeResolve: true })

    registerInstance(instance1)
    registerInstance(instance2)

    const before = _activeInstanceCount()

    expect(before).toBeGreaterThanOrEqual(2)

    await cleanup()

    expect(_activeInstanceCount()).toBe(0)
  })

  it('does not throw when one instance close rejects', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(noop)
    const instance1 = makeMock({ closeReject: new Error('boom') })
    const instance2 = makeMock({ closeResolve: true })

    registerInstance(instance1)
    registerInstance(instance2)

    await expect(cleanup()).resolves.toBeUndefined()
    expect(_activeInstanceCount()).toBe(0)

    warn.mockRestore()
  })
})
