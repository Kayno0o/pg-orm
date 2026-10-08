import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { SerializationError, TimeoutError } from '../../src/index'
import { createTestDb } from '../helpers/db'

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [], statementTimeout: 200 })
  await db.raw('CREATE TABLE IF NOT EXISTS "tx_options" ("v" int)')
})

beforeEach(async () => {
  await db.raw('TRUNCATE "tx_options"')
})

afterAll(async () => {
  await db.raw('DROP TABLE IF EXISTS "tx_options"')
  await db.close({ timeout: 5000 })
})

describe('transaction options', () => {
  it('a read-only access mode alone refuses writes', async () => {
    await expect(db.transaction({ accessMode: 'read only' }, tx => tx.query('INSERT INTO "tx_options" VALUES (1)', []))).rejects.toThrow('read-only transaction')
  })

  it('statementTimeout bounds a plain query, outside any transaction', async () => {
    await expect(db.raw('SELECT pg_sleep(1)')).rejects.toBeInstanceOf(TimeoutError)
  })

  it('a serializable transaction retries on a serialization failure, its callbacks running once', async () => {
    const { promise: aRead, resolve: aHasRead } = Promise.withResolvers<void>()
    const { promise: bRead, resolve: bHasRead } = Promise.withResolvers<void>()
    const fired: string[] = []
    let attempts = 0

    const a = db.transaction({ isolation: 'serializable' }, async (tx) => {
      await tx.query('SELECT count(*) FROM "tx_options"', [])
      aHasRead()
      await bRead
      await tx.query('INSERT INTO "tx_options" VALUES (1)', [])
    })

    const b = db.transaction({ isolation: 'serializable', retry: { maxRetries: 3, baseDelayMs: 1 } }, async (tx) => {
      const attempt = ++attempts

      tx.onCommit(() => void fired.push(`commit ${attempt}`))
      tx.onRollback(() => void fired.push(`rollback ${attempt}`))
      await aRead
      await tx.query('SELECT count(*) FROM "tx_options"', [])

      if (attempt === 1) {
        bHasRead()
        await a
      }

      await tx.query('INSERT INTO "tx_options" VALUES (2)', [])
    })

    await Promise.all([a, b])

    expect(attempts).toBe(2)
    expect(fired).toEqual(['commit 2'])
    expect(await db.raw('SELECT "v" FROM "tx_options" ORDER BY "v"')).toEqual([{ v: 1 }, { v: 2 }])
  })

  it('without retry, the serialization failure reaches the caller', async () => {
    const { promise: aRead, resolve: aHasRead } = Promise.withResolvers<void>()
    const { promise: bRead, resolve: bHasRead } = Promise.withResolvers<void>()

    const a = db.transaction({ isolation: 'serializable' }, async (tx) => {
      await tx.query('SELECT count(*) FROM "tx_options"', [])
      aHasRead()
      await bRead
      await tx.query('INSERT INTO "tx_options" VALUES (1)', [])
    })

    const b = db.transaction({ isolation: 'serializable' }, async (tx) => {
      await aRead
      await tx.query('SELECT count(*) FROM "tx_options"', [])
      bHasRead()
      await a
      await tx.query('INSERT INTO "tx_options" VALUES (2)', [])
    })

    await a
    await expect(b).rejects.toBeInstanceOf(SerializationError)
  })
})
