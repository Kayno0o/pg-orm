import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createTestDb, truncateAll } from '../helpers/db'
import { usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

describe('Transactions', () => {
  it('commits on success', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Alice', email: 'alice@test.com' })
    })

    const count = await db.repo(usersTable).count()

    expect(count).toBe(1)
  })

  it('rolls back on error', async () => {
    try {
      await db.transaction(async (tx) => {
        const repo = db.repo(usersTable).using(tx)

        await repo.insertOne({ name: 'Alice', email: 'alice@test.com' })

        throw new Error('rollback!')
      })
    }
    catch {
      // expected
    }

    const count = await db.repo(usersTable).count()

    expect(count).toBe(0)
  })

  it('supports savepoints', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Alice', email: 'alice@test.com' })

      try {
        await tx.savepoint(async (sp) => {
          const spRepo = db.repo(usersTable).using(sp)

          await spRepo.insertOne({ name: 'Bob', email: 'bob@test.com' })

          throw new Error('savepoint rollback')
        })
      }
      catch {
        // savepoint rolled back
      }

      // Alice should still be committed within the transaction
    })

    const users = await db.repo(usersTable).findMany()

    expect(users).toHaveLength(1)
    expect(users[0].name).toBe('Alice')
  })

  it('supports isolation level: serializable', async () => {
    await db.transaction({ isolation: 'serializable' }, async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Serialized', email: 'serial@test.com' })
    })

    const count = await db.repo(usersTable).count()

    expect(count).toBe(1)
  })

  it('supports isolation level: read committed', async () => {
    await db.transaction({ isolation: 'read committed' }, async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'RC', email: 'rc@test.com' })
    })

    const count = await db.repo(usersTable).count()

    expect(count).toBe(1)
  })

  it('supports read-only access mode', async () => {
    // Insert a row first
    await db.repo(usersTable).insertOne({ name: 'Existing', email: 'existing@test.com' })

    await db.transaction({ isolation: 'read committed', accessMode: 'read only' }, async (tx) => {
      const repo = db.repo(usersTable).using(tx)
      const users = await repo.findMany()

      expect(users).toHaveLength(1)
    })
  })

  it('rejects invalid isolation level', async () => {
    await expect(
      db.transaction({ isolation: 'invalid' as any }, async () => { /* noop */ }),
    ).rejects.toThrow()
  })

  it('repos use transaction executor', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'TxUser', email: 'tx@test.com' })
      const found = await repo.findOne(q => q.where(e => e.eq('email', 'tx@test.com')))

      expect(found).not.toBeNull()
    })
  })

  it('nested savepoints work', async () => {
    await db.transaction(async (tx) => {
      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Outer', email: 'outer@test.com' })

      await tx.savepoint(async (sp1) => {
        const spRepo = db.repo(usersTable).using(sp1)

        await spRepo.insertOne({ name: 'Inner', email: 'inner@test.com' })
      })
    })

    const count = await db.repo(usersTable).count()

    expect(count).toBe(2)
  })
})
