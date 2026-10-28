import type { Database, QueryError, QueryEvent } from '../../src/index'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { AbortError, defineTable, SerializationError, ValidationError } from '../../src/index'
import { createTestDb } from '../helpers/db'

const loads = defineTable('tx_edge_loads', t => ({
  id: t.serial().primaryKey(),
  n: t.int4(),
}))

// Raises a deadlock, which a statement retries whatever it is.
const DEADLOCK = 'DO $$ BEGIN RAISE EXCEPTION \'deadlock\' USING ERRCODE = \'40P01\'; END $$'
const SLOW_BACKOFF = { maxRetries: 3, baseDelayMs: 30_000, maxDelayMs: 30_000 }

let db: Database

beforeAll(async () => {
  db = createTestDb({ tables: [loads], retry: SLOW_BACKOFF })
  await db.sync({ allowDestructive: true })
})

afterAll(async () => {
  await db.close()
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

function abortSoon(): AbortSignal {
  const controller = new AbortController()

  setTimeout(() => controller.abort(new Error('stop')), 50)

  return controller.signal
}

describe('an abort', () => {
  it('ends a statement\'s retry backoff at once', async () => {
    const start = performance.now()

    expect(await rejection(db.withSignal(abortSoon(), () => db.raw(DEADLOCK)))).toBeInstanceOf(AbortError)
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('ends a transaction\'s retry backoff at once, firing its onRollback', async () => {
    const rolledBack: unknown[] = []
    const start = performance.now()
    const error = await rejection(db.withSignal(abortSoon(), () => db.transaction({ retry: SLOW_BACKOFF }, async (tx) => {
      tx.onRollback(err => void rolledBack.push(err))

      throw new SerializationError('conflict', 'UPDATE', [])
    })))

    expect(error).toBeInstanceOf(AbortError)
    expect(rolledBack).toEqual([error])
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('ends a copyFrom whose source stalled', async () => {
    async function* stalled() {
      yield { n: 1 }
      await Promise.withResolvers<void>().promise
    }

    expect(await rejection(db.withSignal(abortSoon(), () => db.repo(loads).write.copyFrom(stalled())))).toBeInstanceOf(AbortError)
  })
})

describe('a savepoint', () => {
  it('opened on an outer client from inside its savepoint throws ValidationError instead of waiting forever', async () => {
    const error = await rejection(db.transaction(async tx => tx.savepoint(async () => tx.savepoint(async () => 'never runs'))))

    expect(error).toBeInstanceOf(ValidationError)
  })

  it('opened on its own client inside a savepoint still nests', async () => {
    expect(await db.transaction(async tx => tx.savepoint(async sp => sp.savepoint(async () => 'nested')))).toBe('nested')
  })
})

describe('the param redactor', () => {
  it('is each database\'s own, for its errors and its query events', async () => {
    const events: QueryEvent[] = []
    const one = createTestDb({ redactParams: params => params.map(() => 'one'), onError: e => void events.push(e) })
    const two = createTestDb({ redactParams: params => params.map(() => 'two') })

    try {
      const first = await rejection(one.raw('SELECT $1::int', ['abc'])) as QueryError
      const second = await rejection(two.raw('SELECT $1::int', ['abc'])) as QueryError

      expect(first.params).toEqual(['one'])
      expect(second.params).toEqual(['two'])
      expect(events.map(e => e.params)).toEqual([['one']])
    }
    finally {
      await one.close()
      await two.close()
    }
  })
})
