import type { QueryEvent } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { AbortError, Database, isRetryable } from '../../src/index'
import { retryableFor } from '../../src/sql/retry'
import { createTestDb, truncateAll } from '../helpers/db'
import { postsTable, usersTable } from '../helpers/fixtures'

let db: Database
const events: QueryEvent[] = []

beforeAll(async () => {
  db = createTestDb({ onQuery: e => events.push(e) })
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
  events.length = 0
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
  }
  catch (error) {
    return error
  }

  throw new Error('expected a rejection')
}

describe('db.withSignal on Postgres', () => {
  it('cancels the statement in flight and rejects with AbortError carrying the reason', async () => {
    const controller = new AbortController()
    const started = performance.now()

    setTimeout(() => controller.abort(new Error('client left')), 100)

    const error = await rejection(db.withSignal(controller.signal, () => db.raw('SELECT pg_sleep(5)')))

    expect(error).toBeInstanceOf(AbortError)
    expect((error as AbortError).cause).toEqual(new Error('client left'))
    expect(performance.now() - started).toBeLessThan(2000)
    // The connection is usable again once the cancel lands.
    expect(await db.raw<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }])
  })

  it('sends no statement under a signal already aborted', async () => {
    const error = await rejection(db.withSignal(AbortSignal.abort(), () => db.repo(usersTable).write.insertOne({ name: 'a', email: 'a@test.com' })))

    expect(error).toBeInstanceOf(AbortError)
    expect(events).toHaveLength(0)
    expect(await db.repo(usersTable).read.count()).toBe(0)
  })

  it('cancels a repo read', async () => {
    await db.repo(usersTable).write.insertOne({ name: 'a', email: 'a@test.com' })

    const error = await rejection(db.withSignal(AbortSignal.timeout(100), () => db.repo(usersTable).read.findMany(q => q.computedRaw('pg_sleep(5)', 'slept'))))

    expect(error).toBeInstanceOf(AbortError)
  })

  it('stops a relation load once the signal aborts after the main query', async () => {
    const author = await db.repo(usersTable).write.insertOne({ name: 'a', email: 'a@test.com' })

    await db.repo(postsTable).write.insertOne({ title: 't', body: 'b', authorId: author.id })

    const controller = new AbortController()
    const watching = createTestDb({ onQuery: () => controller.abort() })

    try {
      const error = await rejection(watching.withSignal(controller.signal, () => watching.repo(usersTable).read.findMany(q => q.include('posts'))))

      expect(error).toBeInstanceOf(AbortError)
      expect((error as AbortError).query).toContain('"posts"')
    }
    finally {
      await watching.close({ timeout: 5000 })
    }
  })

  it('stops a stream between chunks', async () => {
    await db.repo(usersTable).write.insertMany(Array.from({ length: 6 }, (_, i) => ({ name: `u${i}`, email: `u${i}@test.com` })))

    const controller = new AbortController()
    const seen: unknown[] = []
    const error = await rejection(db.withSignal(controller.signal, async () => {
      for await (const row of db.repo(usersTable).stream.cursor({ chunkSize: 2 })) {
        seen.push(row)
        controller.abort()
      }
    }))

    expect(error).toBeInstanceOf(AbortError)
    expect(seen).toHaveLength(2)
  })

  it('rolls back a transaction whose body is aborted', async () => {
    const controller = new AbortController()
    const error = await rejection(db.withSignal(controller.signal, () => db.transaction(async (tx) => {
      await db.repo(usersTable).using(tx).write.insertOne({ name: 'a', email: 'a@test.com' })
      setTimeout(() => controller.abort(), 50)
      await tx.query('SELECT pg_sleep(5)', [])
    })))

    expect(error).toBeInstanceOf(AbortError)
    expect(await db.repo(usersTable).read.count()).toBe(0)
  })

  it('opens no transaction under a signal already aborted', async () => {
    let ran = false
    const error = await rejection(db.withSignal(AbortSignal.abort(), () => db.transaction(async () => {
      ran = true
    })))

    expect(error).toBeInstanceOf(AbortError)
    expect(ran).toBe(false)
  })

  it('rejects with an error no retry policy retries', async () => {
    const error = await rejection(db.withSignal(AbortSignal.timeout(100), () => db.raw('SELECT pg_sleep(5)')))

    expect(isRetryable(error)).toBe(false)
    expect(retryableFor('SELECT pg_sleep(5)', true)(error)).toBe(false)
  })

  it('aborts on either signal when nested, and leaves queries outside the scope alone', async () => {
    const outer = new AbortController()
    const inner = new AbortController()

    const error = await rejection(db.withSignal(outer.signal, () => db.withSignal(inner.signal, async () => {
      outer.abort()
      await db.raw('SELECT 1')
    })))

    expect(error).toBeInstanceOf(AbortError)
    expect(await db.raw<{ one: number }>('SELECT 1 AS one')).toEqual([{ one: 1 }])
    expect(await db.withSignal(new AbortController().signal, () => db.raw<{ one: number }>('SELECT 1 AS one'))).toEqual([{ one: 1 }])
  })
})

describe('db.withSignal on SQLite', () => {
  it('sends no statement under a signal already aborted', async () => {
    const sqlite = new Database({ url: 'sqlite://:memory:', tables: [usersTable] })

    try {
      await sqlite.sync()

      const error = await rejection(sqlite.withSignal(AbortSignal.abort(), () => sqlite.repo(usersTable).write.insertOne({ name: 'a', email: 'a@test.com' })))

      expect(error).toBeInstanceOf(AbortError)
      expect(await sqlite.repo(usersTable).read.count()).toBe(0)
    }
    finally {
      await sqlite.close()
    }
  })
})
