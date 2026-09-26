import type { ConnectionHooks } from '../../../src/sql/connection-lifecycle'
import { describe, expect, it } from 'bun:test'
import { ConnectionError } from '../../../src/errors/index'
import { ConnectionLifecycle } from '../../../src/sql/connection-lifecycle'

interface FakeDriver {
  unsafe: (sql: string, params: unknown[]) => Promise<unknown[]>
  begin: <T>(fn: (tx: unknown) => Promise<T>) => Promise<T>
  savepoint: <T>(fn: (sp: unknown) => Promise<T>) => Promise<T>
  close: (opts?: { timeout?: number }) => Promise<void>
}

async function emptyClose(): Promise<void> {
  return undefined
}

function makeFake(handlers: Partial<FakeDriver> = {}): FakeDriver {
  return {
    unsafe: handlers.unsafe ?? (async () => []),
    begin: handlers.begin ?? (async fn => fn({})),
    savepoint: handlers.savepoint ?? (async fn => fn({})),
    close: handlers.close ?? emptyClose,
  }
}

function instrumentSql(lc: ConnectionLifecycle, driver: FakeDriver): void {
  // The lifecycle constructs its own bun:sql instance from the SQL constructor.
  // For unit testing we replace the structural driver surface with a fake.
  Object.defineProperty(lc, 'sql', { value: driver, writable: false, configurable: true })
}

function makeLifecycle(driver: FakeDriver, hooks: ConnectionHooks = {}): ConnectionLifecycle {
  // Construct against a localhost URL — the SQL pool won't actually connect
  // unless we call query() through the real instance, which we replace below.
  const lc = new ConnectionLifecycle(
    { url: 'postgres://localhost:1/test' },
    'public',
    { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 5, writes: false },
    hooks,
  )

  instrumentSql(lc, driver)

  return lc
}

describe('ConnectionLifecycle', () => {
  it('query() returns driver rows', async () => {
    const lc = makeLifecycle(makeFake({ unsafe: async () => [{ id: 1 }] }))
    const rows = await lc.query('SELECT 1', [])

    expect(rows).toEqual([{ id: 1 }])

    await lc.close()
  })

  it('rejects new queries once draining', async () => {
    const lc = makeLifecycle(makeFake())

    // Trigger drain via close({ drain: true }) with zero in-flight — settles immediately.
    await lc.close({ drain: true })

    expect(lc.draining).toBe(true)
    await expect(lc.query('SELECT 1', [])).rejects.toBeInstanceOf(ConnectionError)
  })

  it('emits the schema passed in the constructor', () => {
    const lc = makeLifecycle(makeFake(), {})

    expect(lc.schema).toBe('public')
  })

  it('ping() returns true on success', async () => {
    const lc = makeLifecycle(makeFake({ unsafe: async () => [{ '?column?': 1 }] }))
    const ok = await lc.ping()

    expect(ok).toBe(true)
    await lc.close()
  })

  it('ping() returns false and routes the error to onPingError', async () => {
    const seen: unknown[] = []
    const lc = makeLifecycle(
      makeFake({ unsafe: async () => { throw new Error('boom') } }),
      { onPingError: err => seen.push(err) },
    )

    const ok = await lc.ping()

    expect(ok).toBe(false)
    expect(seen).toHaveLength(1)
    expect((seen[0] as Error).message).toBe('boom')

    await lc.close()
  })

  it('close() forwards the timeout to the driver', async () => {
    let captured: { timeout?: number } | undefined
    const lc = makeLifecycle(makeFake({
      close: async (opts) => {
        captured = opts
      },
    }))

    await lc.close({ timeout: 250 })

    expect(captured).toEqual({ timeout: 250 })
  })

  it('retries transient errors before succeeding', async () => {
    let calls = 0
    const lc = new ConnectionLifecycle(
      { url: 'postgres://localhost:1/test' },
      'public',
      { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5, writes: false },
      {},
    )

    instrumentSql(lc, makeFake({
      unsafe: async () => {
        calls++

        if (calls === 1) {
          // wrapPgError converts errno='40P01' to DeadlockError, which the
          // retry policy treats as retryable.
          const err = Object.assign(new Error('deadlock detected'), { errno: '40P01' })

          throw err
        }

        return [{ ok: 1 }]
      },
    }))

    const rows = await lc.query('SELECT 1', [])

    expect(rows).toEqual([{ ok: 1 }])
    expect(calls).toBe(2)

    await lc.close()
  })

  it('getPoolStats coerces driver row to numbers', async () => {
    const lc = makeLifecycle(makeFake({
      unsafe: async () => [{ active: '3', idle: '5', total: '8', max_connections: '100' }],
    }))

    const stats = await lc.getPoolStats()

    expect(stats).toEqual({ active: 3, idle: 5, total: 8, maxConnections: 100 })

    await lc.close()
  })
})
