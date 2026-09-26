import { describe, expect, it } from 'bun:test'
import { ConnectionError, DeadlockError, SerializationError } from '../../../src/errors/index'
import { retryableFor, RetryPolicy } from '../../../src/sql/retry'

const dropped = new ConnectionError('connection closed')
const deadlock = new DeadlockError('deadlock detected', '', [])
const serialization = new SerializationError('could not serialize access', '', [])

describe('retryableFor', () => {
  it('retries a read after a dropped connection, a write only when allowed', () => {
    expect(retryableFor('SELECT * FROM "users"', false)(dropped)).toBe(true)
    expect(retryableFor('  select 1', false)(dropped)).toBe(true)
    expect(retryableFor('INSERT INTO "users" DEFAULT VALUES', false)(dropped)).toBe(false)
    expect(retryableFor('WITH x AS (DELETE FROM "users" RETURNING *) SELECT * FROM x', false)(dropped)).toBe(false)
    expect(retryableFor('INSERT INTO "users" DEFAULT VALUES', true)(dropped)).toBe(true)
  })

  it('retries any statement a deadlock or serialization failure aborted', () => {
    for (const err of [deadlock, serialization])
      expect(retryableFor('UPDATE "users" SET "n" = 1', false)(err)).toBe(true)
  })

  it('never retries other errors', () => {
    expect(retryableFor('SELECT 1', true)(new Error('boom'))).toBe(false)
  })
})

describe('RetryPolicy.runStatement', () => {
  async function attempts(sql: string, writes: boolean): Promise<number> {
    const policy = new RetryPolicy({ maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1, writes })
    let calls = 0

    try {
      await policy.runStatement(sql, async () => {
        calls++

        throw dropped
      })
    }
    catch {
      // every attempt fails
    }

    return calls
  }

  it('runs a write once after a dropped connection unless writes are retried', async () => {
    expect(await attempts('INSERT INTO "t" DEFAULT VALUES', false)).toBe(1)
    expect(await attempts('INSERT INTO "t" DEFAULT VALUES', true)).toBe(3)
    expect(await attempts('SELECT 1', false)).toBe(3)
  })
})
