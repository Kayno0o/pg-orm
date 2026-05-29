import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { DeadlockError } from '../../src/errors/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

beforeEach(async () => {
  await truncateAll(db)
})

describe('Deadlock detection', () => {
  it('throws DeadlockError when two transactions update same rows in opposite order', async () => {
    const repo = db.repo(usersTable)

    // Insert two users
    const { id: aliceId } = await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' })
    const { id: bobId } = await repo.write.insertOne({ name: 'Bob', email: 'bob@test.com' })

    let deadlockDetected = false

    const tx1 = db.transaction(async (tx) => {
      const r = repo.using(tx)

      await r.write.updateOne({ name: 'Alice-updated' }, e => e.eq('id', aliceId))
      // Give tx2 time to lock bob
      await new Promise(resolve => setTimeout(resolve, 100))
      await r.write.updateOne({ name: 'Bob-updated' }, e => e.eq('id', bobId))
    })

    const tx2 = db.transaction(async (tx) => {
      const r = repo.using(tx)

      await r.write.updateOne({ name: 'Bob-updated2' }, e => e.eq('id', bobId))
      // Give tx1 time to lock alice
      await new Promise(resolve => setTimeout(resolve, 100))
      await r.write.updateOne({ name: 'Alice-updated2' }, e => e.eq('id', aliceId))
    })

    try {
      await Promise.all([tx1, tx2])
    }
    catch (err) {
      if (err instanceof DeadlockError) {
        deadlockDetected = true
      }
      else {
        throw err
      }
    }

    expect(deadlockDetected).toBe(true)
  })

  it('FOR UPDATE SKIP LOCKED skips locked rows', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' })
    await repo.write.insertOne({ name: 'Bob', email: 'bob@test.com' })

    let skippedCount = 0

    await db.transaction(async (tx1) => {
      // tx1 locks Alice with FOR UPDATE
      await tx1.query(
        'SELECT * FROM "users" WHERE "name" = $1 FOR UPDATE',
        ['Alice'],
      )

      // Nested: tx2 tries to lock all users with SKIP LOCKED
      await db.transaction(async (tx2) => {
        const rows = await tx2.query(
          'SELECT * FROM "users" FOR UPDATE SKIP LOCKED',
          [],
        )

        // Should only get Bob (Alice is locked by tx1)
        skippedCount = 2 - rows.length
      })
    })

    expect(skippedCount).toBe(1)
  })

  it('serializable isolation detects write conflicts', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Counter', email: 'counter@test.com', age: 0 })

    let serializationError = false

    const tx1 = db.transaction({ isolation: 'serializable' }, async (tx) => {
      // Read current value
      const rows = await tx.query('SELECT "age" FROM "users" WHERE "email" = $1', ['counter@test.com']) as { age: number }[]
      const currentAge = rows[0]!.age

      await new Promise(resolve => setTimeout(resolve, 100))
      // Write back incremented
      await tx.query('UPDATE "users" SET "age" = $1 WHERE "email" = $2', [currentAge + 1, 'counter@test.com'])
    })

    const tx2 = db.transaction({ isolation: 'serializable' }, async (tx) => {
      // Read current value
      const rows = await tx.query('SELECT "age" FROM "users" WHERE "email" = $1', ['counter@test.com']) as { age: number }[]
      const currentAge = rows[0]!.age

      await new Promise(resolve => setTimeout(resolve, 100))
      // Write back incremented
      await tx.query('UPDATE "users" SET "age" = $1 WHERE "email" = $2', [currentAge + 1, 'counter@test.com'])
    })

    try {
      await Promise.all([tx1, tx2])
    }
    catch {
      serializationError = true
    }

    expect(serializationError).toBe(true)
  })
})
