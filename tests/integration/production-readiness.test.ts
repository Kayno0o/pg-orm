import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb, TEST_URL, truncateAll } from '../helpers/db'
import { allTables, usersTable } from '../helpers/fixtures'

let db: Database

beforeAll(async () => {
  db = createTestDb()
  await db.sync({ allowDestructive: true })
})

beforeEach(async () => {
  await truncateAll(db)
})

afterAll(async () => {
  await db.close({ timeout: 5000 })
})

// --- SQL Injection E2E Tests ---
// These send actual injection payloads through the full stack and verify they're stored as literal strings.

describe('SQL Injection E2E', () => {
  it('handles injection payloads in insert values', async () => {
    const repo = db.repo(usersTable)

    const payloads = [
      `'; DROP TABLE users; --`,
      `Robert'); DROP TABLE students;--`,
      `1 OR 1=1`,
      `" OR ""="`,
      `'; UPDATE users SET name='hacked' WHERE '1'='1`,
      `\'; SELECT pg_sleep(10);--`,
    ]

    for (const payload of payloads) {
      const userId = await repo.insertOne({ name: payload, email: `test-${Math.random()}@test.com` })
      const user = await repo.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

      // Value stored as literal string
      expect(user.name).toBe(payload)
    }

    // Verify table still exists and has the expected row count
    const count = await repo.count()

    expect(count).toBe(payloads.length)
  })

  it('handles injection payloads in where clauses', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'alice@test.com' })

    // These should find no rows, not cause SQL errors
    const result = await repo.findMany(q =>
      q.where(e => e.eq('name', `'; DROP TABLE users; --`)),
    )

    expect(result).toHaveLength(0)

    // Table still works
    const all = await repo.findMany()

    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('Alice')
  })

  it('handles injection payloads in LIKE patterns', async () => {
    const repo = db.repo(usersTable)

    await repo.insertOne({ name: 'Alice', email: 'alice@test.com' })

    const result = await repo.findMany(q =>
      q.where(e => e.like('name', `%'; DROP TABLE users; --%`)),
    )

    expect(result).toHaveLength(0)

    // Table still works
    const count = await repo.count()

    expect(count).toBe(1)
  })

  it('handles injection payloads in update set values', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.insertOne({ name: 'Alice', email: 'alice@test.com' })

    const payload = `'; UPDATE users SET email='hacked'; --`

    await repo.updateOne({ name: payload }, e => e.eq('id', userId))

    const updated = await repo.findById(userId)

    expect(updated!.name).toBe(payload)
    expect(updated!.email).toBe('alice@test.com') // Not modified
  })
})

// --- Concurrent Sync Test ---

describe('Concurrent Sync', () => {
  it('handles concurrent sync() calls via advisory lock', async () => {
    const table = defineTable('concurrent_sync_test', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
      extra: t.text().nullable(),
    }))

    const db1 = new (await import('../../src/index')).Database({
      url: TEST_URL,
      tables: [...allTables, table],
    })
    const db2 = new (await import('../../src/index')).Database({
      url: TEST_URL,
      tables: [...allTables, table],
    })

    try {
      await db1.raw('DROP TABLE IF EXISTS "concurrent_sync_test"', [])

      // Run both syncs concurrently
      const [result1, result2] = await Promise.all([
        db1.sync({ allowDestructive: true }),
        db2.sync({ allowDestructive: true }),
      ])

      // At least one should have created the table
      const createOps1 = result1.ops.filter(o => o.type === 'create_table' && o.table === 'concurrent_sync_test')
      const createOps2 = result2.ops.filter(o => o.type === 'create_table' && o.table === 'concurrent_sync_test')

      // Exactly one should have the create op (the other saw it already existed)
      expect(createOps1.length + createOps2.length).toBe(1)

      // Verify table exists and is usable
      const rows = await db1.raw<{ count: string }>('SELECT count(*) FROM "concurrent_sync_test"', [])

      expect(Number(rows[0]!.count)).toBe(0)
    }
    finally {
      await db1.raw('DROP TABLE IF EXISTS "concurrent_sync_test"', [])
      await db1.close({ timeout: 5000 })
      await db2.close({ timeout: 5000 })
    }
  })
})

// --- withContext Test ---

describe('Database.withContext()', () => {
  it('attaches context to query events', async () => {
    const events: { sql: string, context?: Record<string, unknown> }[] = []

    const contextDb = new (await import('../../src/index')).Database({
      url: TEST_URL,
      tables: allTables,
      onQuery: (event) => {
        events.push({ sql: event.sql, context: event.context })
      },
    })

    try {
      const scoped = contextDb.withContext({ requestId: 'req-123', userId: 42 })
      const repo = scoped.repo(usersTable)

      await repo.insertOne({ name: 'Test', email: 'ctx@test.com' })

      // Find the INSERT event
      const insertEvent = events.find(e => e.sql.includes('INSERT'))

      expect(insertEvent).toBeDefined()
      expect(insertEvent!.context).toEqual({ requestId: 'req-123', userId: 42 })
    }
    finally {
      // Clean up
      await contextDb.raw('DELETE FROM "users" WHERE email = $1', ['ctx@test.com'])
      await contextDb.close({ timeout: 5000 })
    }
  })
})
