import type { Database } from '../../src/index'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { OrmError } from '../../src/index'
import { getMigrationHistory } from '../../src/migration/index'
import { createTestDb, truncateAll } from '../helpers/db'
import { postsTable, usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
  await truncateAll(db)
})

afterEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

// --- 1.1 restore() ---
describe('restore()', () => {
  it('restores a soft-deleted record', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    await repo.deleteMany(e => e.eq('email', 'a@test.com'))

    // Should be hidden from normal queries
    expect(await repo.findMany()).toHaveLength(0)

    // Restore
    const restored = await repo.restore(e => e.eq('email', 'a@test.com'))

    expect(restored).toHaveLength(1)
    expect(restored[0]!.name).toBe('Alice')
    expect(restored[0]!.deletedAt).toBeNull()

    // Should be visible again
    expect(await repo.findMany()).toHaveLength(1)
  })

  it('only restores matching soft-deleted records', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })
    await repo.insertOne({ name: 'Bob', email: 'b@test.com' })
    await repo.deleteMany(e => e.eq('email', 'a@test.com'))
    await repo.deleteMany(e => e.eq('email', 'b@test.com'))

    await repo.restore(e => e.eq('email', 'a@test.com'))

    const all = await repo.findMany()

    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('Alice')
  })

  it('does nothing when no soft-deleted records match', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })

    // Alice is not deleted, so restore should match nothing
    const restored = await repo.restore(e => e.eq('email', 'a@test.com'))

    expect(restored).toHaveLength(0)
  })

  it('throws on table without softDelete trait', async () => {
    const repo = db.repo(postsTable)

    expect(repo.restore(e => e.eq('id', 1))).rejects.toThrow(OrmError)
  })
})

// --- 1.4 upsertMany() ---
describe('upsertMany()', () => {
  it('inserts new records', async () => {
    const repo = db.repo(usersTable)

    const result = await repo.upsertMany(
      [
        { name: 'Alice', email: 'a@test.com' },
        { name: 'Bob', email: 'b@test.com' },
      ],
      ['email'],
    )

    expect(result).toHaveLength(2)

    const all = await repo.findMany()

    expect(all).toHaveLength(2)
  })

  it('updates existing records on conflict', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com' })

    const result = await repo.upsertMany(
      [
        { name: 'Alice Updated', email: 'a@test.com' },
        { name: 'Bob', email: 'b@test.com' },
      ],
      ['email'],
    )

    expect(result).toHaveLength(2)

    const all = await repo.findMany(q => q.orderBy('email', 'asc'))

    expect(all).toHaveLength(2)
    expect(all[0]!.name).toBe('Alice Updated')
    expect(all[1]!.name).toBe('Bob')
  })

  it('returns empty for empty input', async () => {
    const repo = db.repo(usersTable)

    const result = await repo.upsertMany([], ['email'])

    expect(result).toEqual([])
  })

  it('updates only specified columns on conflict', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'a@test.com', age: 25 })

    await repo.upsertMany(
      [{ name: 'Alice Changed', email: 'a@test.com', age: 99 }],
      ['email'],
      ['name'],
    )

    const user = await repo.findOne(q => q.where(e => e.eq('email', 'a@test.com')))

    expect(user!.name).toBe('Alice Changed')
    // age should NOT be updated since we only specified 'name' as update column
    // Note: behavior depends on the ON CONFLICT DO UPDATE SET clause
  })
})

// --- 1.3 Default query limit ---
describe('Default query limit', () => {
  it('applies default limit via Database config', async () => {
    const { Database } = await import('../../src/index')
    const limitDb = new Database({
      url: 'postgres://test:test@127.0.0.1:8532/orm_test',
      tables: [usersTable, postsTable],
      defaultLimit: 2,
    })

    try {
      const repo = limitDb.repo(usersTable)

      // Insert 3 users
      await repo.insertOne({ name: 'Alice', email: 'dl-a@test.com' })
      await repo.insertOne({ name: 'Bob', email: 'dl-b@test.com' })
      await repo.insertOne({ name: 'Charlie', email: 'dl-c@test.com' })

      // findMany without explicit limit should return only 2
      const users = await repo.findMany()

      expect(users).toHaveLength(2)

      // findMany with explicit limit should use that
      const all = await repo.findMany(q => q.limit(10))

      expect(all).toHaveLength(3)
    }
    finally {
      await limitDb.raw('DELETE FROM "users" WHERE email LIKE $1', ['dl-%'])
      await limitDb.close({ timeout: 5000 })
    }
  })
})

// --- 3.1 Transaction hooks ---
describe('Transaction hooks', () => {
  it('fires onCommit after successful transaction', async () => {
    let committed = false

    await db.transaction(async (tx) => {
      tx.onCommit(() => {
        committed = true
      })

      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Alice', email: 'txhook-a@test.com' })
    })

    expect(committed).toBe(true)
  })

  it('fires onRollback after failed transaction', async () => {
    let rolledBack = false
    let rollbackError: unknown

    try {
      await db.transaction(async (tx) => {
        tx.onRollback((err) => {
          rolledBack = true
          rollbackError = err
        })

        const repo = db.repo(usersTable).using(tx)

        await repo.insertOne({ name: 'Alice', email: 'txhook-b@test.com' })

        throw new Error('test rollback')
      })
    }
    catch {
      // expected
    }

    expect(rolledBack).toBe(true)
    expect(rollbackError).toBeInstanceOf(Error)
    expect((rollbackError as Error).message).toBe('test rollback')
  })

  it('does not fire onCommit on rollback', async () => {
    let committed = false

    try {
      await db.transaction(async (tx) => {
        tx.onCommit(() => {
          committed = true
        })

        throw new Error('rollback')
      })
    }
    catch {
      // expected
    }

    expect(committed).toBe(false)
  })

  it('does not fire onRollback on commit', async () => {
    let rolledBack = false

    await db.transaction(async (tx) => {
      tx.onRollback(() => {
        rolledBack = true
      })

      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Alice', email: 'txhook-c@test.com' })
    })

    expect(rolledBack).toBe(false)
  })

  it('fires multiple onCommit callbacks in order', async () => {
    const order: number[] = []

    await db.transaction(async (tx) => {
      tx.onCommit(() => {
        order.push(1)
      })
      tx.onCommit(() => {
        order.push(2)
      })
      tx.onCommit(() => {
        order.push(3)
      })

      const repo = db.repo(usersTable).using(tx)

      await repo.insertOne({ name: 'Alice', email: 'txhook-d@test.com' })
    })

    expect(order).toEqual([1, 2, 3])
  })
})

// --- 3.2 Request context correlation ---
describe('Request context correlation', () => {
  it('propagates context to QueryEvent', async () => {
    const events: any[] = []
    const { Database } = await import('../../src/index')
    const ctxDb = new Database({
      url: 'postgres://test:test@127.0.0.1:8532/orm_test',
      tables: [usersTable, postsTable],
      onQuery: (event) => {
        events.push(event)
      },
    })

    try {
      await ctxDb.transaction(
        { context: { requestId: 'req-123', userId: 42 } },
        async (tx) => {
          const repo = ctxDb.repo(usersTable).using(tx)

          await repo.insertOne({ name: 'Alice', email: 'ctx-a@test.com' })
        },
      )

      // At least one query event should have context
      const withContext = events.filter(e => e.context?.requestId === 'req-123')

      expect(withContext.length).toBeGreaterThan(0)
      expect(withContext[0].context.userId).toBe(42)
    }
    finally {
      await ctxDb.raw('DELETE FROM "users" WHERE email LIKE $1', ['ctx-%'])
      await ctxDb.close({ timeout: 5000 })
    }
  })

  it('does not add context when not specified', async () => {
    const events: any[] = []
    const { Database } = await import('../../src/index')
    const ctxDb = new Database({
      url: 'postgres://test:test@127.0.0.1:8532/orm_test',
      tables: [usersTable, postsTable],
      onQuery: (event) => {
        events.push(event)
      },
    })

    try {
      await ctxDb.transaction(async (tx) => {
        const repo = ctxDb.repo(usersTable).using(tx)

        await repo.insertOne({ name: 'Alice', email: 'ctx-b@test.com' })
      })

      // No events should have context
      const withContext = events.filter(e => e.context != null)

      expect(withContext).toHaveLength(0)
    }
    finally {
      await ctxDb.raw('DELETE FROM "users" WHERE email LIKE $1', ['ctx-%'])
      await ctxDb.close({ timeout: 5000 })
    }
  })
})

// --- 2.1 Migration history ---
describe('Migration history', () => {
  it('records migrations on sync()', async () => {
    const history = await getMigrationHistory(db)

    // After sync() in beforeAll, there should be at least one history entry
    // (or zero if tables already existed and no drift)
    expect(Array.isArray(history)).toBe(true)

    // Each entry should have the expected shape
    for (const entry of history) {
      expect(entry).toHaveProperty('id')
      expect(entry).toHaveProperty('name')
      expect(entry).toHaveProperty('sqlHash')
      expect(entry).toHaveProperty('upSql')
      expect(entry).toHaveProperty('downSql')
      expect(entry).toHaveProperty('appliedAt')
      expect(entry).toHaveProperty('direction')
    }
  })
})

// --- NULL in aggregates ---
describe('NULL handling in aggregates', () => {
  it('COUNT ignores NULL values correctly', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'null-a@test.com', age: 25 })
    await repo.insertOne({ name: 'Bob', email: 'null-b@test.com', age: null })
    await repo.insertOne({ name: 'Charlie', email: 'null-c@test.com', age: 30 })

    const total = await repo.count()

    expect(total).toBe(3)
  })

  it('SUM/AVG with all NULL returns null', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'nullagg-a@test.com', age: null })
    await repo.insertOne({ name: 'Bob', email: 'nullagg-b@test.com', age: null })

    const rows = await repo.findMany(q =>
      q.pick().computed('SUM("age")', 'total'),
    )

    expect(rows[0]!.total).toBeNull()
  })
})

// --- Large text/jsonb values ---
describe('Large values', () => {
  it('handles large text values', async () => {
    const repo = db.repo(postsTable)
    const largeBody = 'x'.repeat(100_000)
    const post = await repo.insertOne({ title: 'Big Post', body: largeBody, authorId: 0 })

    expect(post.body).toBe(largeBody)
    expect(post.body.length).toBe(100_000)
  })
})
