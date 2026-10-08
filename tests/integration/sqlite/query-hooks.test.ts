import type { CallbackErrorEvent, DbConfig, QueryErrorEvent, SlowQueryEvent } from '../../../src/index'
import { describe, expect, it } from 'bun:test'
import { Database } from '../../../src/index'

function memoryDb(hooks: DbConfig = {}): Database {
  return new Database({ url: 'sqlite://:memory:', ...hooks })
}

describe('query hooks only observe', () => {
  it('a throwing onQuery or onSlowQuery leaves the write done and reports through onCallbackError', async () => {
    const reported: CallbackErrorEvent[] = []
    const db = memoryDb({
      onQuery: () => {
        throw new Error('logger down')
      },
      onSlowQuery: () => {
        throw new Error('slow logger down')
      },
      slowQueryThreshold: 0,
      onCallbackError: e => void reported.push(e),
    })

    await db.raw('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    await db.raw('INSERT INTO t (id) VALUES (1)')

    expect(await db.raw<{ n: number }>('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }])
    expect(reported.length).toBeGreaterThan(0)
    expect(reported.every(e => e.kind === 'queryHook')).toBe(true)
    await db.close()
  })

  it('a rejecting async hook is reported, not left unhandled', async () => {
    const reported: CallbackErrorEvent[] = []
    const db = memoryDb({
      onQuery: async () => {
        throw new Error('async logger down')
      },
      onCallbackError: e => void reported.push(e),
    })

    await db.raw('SELECT 1')
    await Bun.sleep(0)

    expect(reported.map(e => (e.error as Error).message)).toEqual(['async logger down'])
    await db.close()
  })

  it('a throwing onError leaves the original error to the caller', async () => {
    const db = memoryDb({
      onError: () => {
        throw new Error('error logger down')
      },
      onCallbackError: () => undefined,
    })

    await expect(db.raw('SELECT * FROM missing')).rejects.toThrow('no such table')
    await db.close()
  })

  it('a hook error with no onCallbackError goes to console.warn', async () => {
    const warned: unknown[][] = []
    const original = console.warn

    console.warn = (...args: unknown[]) => void warned.push(args)

    try {
      const db = memoryDb({
        onQuery: () => {
          throw new Error('logger down')
        },
      })

      await db.raw('SELECT 1')
      await db.close()
    }
    finally {
      console.warn = original
    }

    expect(warned[0]?.[0]).toBe('pg-orm: queryHook failed:')
  })
})

describe('query error events', () => {
  it('carry the duration, and a slow failing query reaches onSlowQuery with its error', async () => {
    const errors: QueryErrorEvent[] = []
    const slow: SlowQueryEvent[] = []
    const db = memoryDb({ onError: e => void errors.push(e), onSlowQuery: e => void slow.push(e), slowQueryThreshold: 0 })

    await expect(db.raw('SELECT * FROM missing')).rejects.toThrow()

    expect(errors).toHaveLength(1)
    expect(errors[0]!.durationMs).toBeGreaterThanOrEqual(0)
    expect(slow).toHaveLength(1)
    expect(slow[0]!.error).toBe(errors[0]!.error)
    await db.close()
  })
})

describe('withContext', () => {
  it('returns a rejected promise when its function throws synchronously', async () => {
    const db = memoryDb()
    let pending: Promise<unknown> | undefined

    expect(() => {
      pending = db.withContext({ requestId: 'r' }, () => {
        throw new Error('sync failure')
      })
    }).not.toThrow()
    await expect(pending!).rejects.toThrow('sync failure')
    await db.close()
  })
})
