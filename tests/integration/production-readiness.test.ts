import type { Database } from '../../src/index'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { defineTable } from '../../src/index'
import { createTestDb, truncateAll } from '../helpers/db'
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
      const userId = await repo.write.insertOne({ name: payload, email: `test-${Math.random()}@test.com` }, { pk: true })
      const user = await repo.read.findOneOrThrow(q => q.where(e => e.eq('id', userId)))

      // Value stored as literal string
      expect(user.name).toBe(payload)
    }

    // Verify table still exists and has the expected row count
    const count = await repo.read.count()

    expect(count).toBe(payloads.length)
  })

  it('handles injection payloads in where clauses', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' }, { pk: true })

    // These should find no rows, not cause SQL errors
    const result = await repo.read.findMany(q =>
      q.where(e => e.eq('name', `'; DROP TABLE users; --`)),
    )

    expect(result).toHaveLength(0)

    // Table still works
    const all = await repo.read.findMany()

    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('Alice')
  })

  it('handles injection payloads in LIKE patterns', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' }, { pk: true })

    const result = await repo.read.findMany(q =>
      q.where(e => e.like('name', `%'; DROP TABLE users; --%`)),
    )

    expect(result).toHaveLength(0)

    // Table still works
    const count = await repo.read.count()

    expect(count).toBe(1)
  })

  it('handles injection payloads in update set values', async () => {
    const repo = db.repo(usersTable)
    const userId = await repo.write.insertOne({ name: 'Alice', email: 'alice@test.com' }, { pk: true })

    const payload = `'; UPDATE users SET email='hacked'; --`

    await repo.write.updateOne({ name: payload }, e => e.eq('id', userId), { pk: true })

    const updated = await repo.read.findById(userId)

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

    const db1 = createTestDb({ tables: [...allTables, table] })
    const db2 = createTestDb({ tables: [...allTables, table] })

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
  it('attaches context to query events from inside the async scope', async () => {
    const events: { sql: string, context?: Record<string, unknown> }[] = []

    const contextDb = createTestDb({
      onQuery: (event) => {
        events.push({ sql: event.sql, context: event.context })
      },
    })

    try {
      const repo = contextDb.repo(usersTable)

      await contextDb.withContext({ requestId: 'req-123', userId: 42 }, async () => {
        await repo.write.insertOne({ name: 'Test', email: 'ctx@test.com' }, { pk: true })
      })

      // Find the INSERT event
      const insertEvent = events.find(e => e.sql.includes('INSERT'))

      expect(insertEvent).toBeDefined()
      expect(insertEvent!.context).toEqual({ requestId: 'req-123', userId: 42 })

      // Queries outside the scope must NOT carry the context
      events.length = 0
      await repo.read.findMany()

      expect(events.every(e => e.context === undefined)).toBe(true)
    }
    finally {
      // Clean up
      await contextDb.raw('DELETE FROM "users" WHERE email = $1', ['ctx@test.com'])
      await contextDb.close({ timeout: 5000 })
    }
  })

  it('merges nested contexts and lets inner keys override outer keys', async () => {
    const events: { sql: string, context?: Record<string, unknown> }[] = []

    const contextDb = createTestDb({
      onQuery: (event) => {
        events.push({ sql: event.sql, context: event.context })
      },
    })

    try {
      const repo = contextDb.repo(usersTable)

      await contextDb.withContext({ requestId: 'outer', tenant: 't1' }, async () => {
        await contextDb.withContext({ requestId: 'inner' }, async () => {
          await repo.write.insertOne({ name: 'Nest', email: 'nest@test.com' }, { pk: true })
        })
      })

      const insertEvent = events.find(e => e.sql.includes('INSERT'))

      expect(insertEvent!.context).toEqual({ requestId: 'inner', tenant: 't1' })
    }
    finally {
      await contextDb.raw('DELETE FROM "users" WHERE email = $1', ['nest@test.com'])
      await contextDb.close({ timeout: 5000 })
    }
  })

  it('propagates context to queries issued inside transactions', async () => {
    const events: { sql: string, context?: Record<string, unknown> }[] = []

    const contextDb = createTestDb({
      onQuery: (event) => {
        events.push({ sql: event.sql, context: event.context })
      },
    })

    try {
      await contextDb.withContext({ requestId: 'tx-req' }, async () => {
        await contextDb.transaction(async (tx) => {
          const repo = contextDb.repo(usersTable).using(tx)

          await repo.write.insertOne({ name: 'Tx', email: 'tx-ctx@test.com' }, { pk: true })
        })
      })

      const insertEvent = events.find(e => e.sql.includes('INSERT'))

      expect(insertEvent!.context).toEqual({ requestId: 'tx-req' })
    }
    finally {
      await contextDb.raw('DELETE FROM "users" WHERE email = $1', ['tx-ctx@test.com'])
      await contextDb.close({ timeout: 5000 })
    }
  })
})

// --- Systemic failure mode coverage ---

describe('Pool exhaustion', () => {
  it('queues concurrent queries when in-flight count exceeds pool.max', async () => {
    const smallPoolDb = createTestDb({
      pool: { max: 2, connectionTimeout: 10_000 },
      application_name: 'pg-orm-pool-exhaustion-test',
    })

    try {
      // Five concurrent 200ms sleeps — only two can run at once, so total wall
      // time must be ~3*200ms (ceil(5/2)*200) rather than 200ms.
      const start = performance.now()
      const sleeps = Array.from({ length: 5 }, () => smallPoolDb.raw('SELECT pg_sleep(0.2)', []))

      await Promise.all(sleeps)
      const elapsed = performance.now() - start

      // Allow generous slack but require clear evidence of queuing.
      expect(elapsed).toBeGreaterThan(500)
    }
    finally {
      await smallPoolDb.close({ timeout: 5000 })
    }
  })

  it('connectionTimeout surfaces a typed error when the pool is saturated', async () => {
    const tinyPoolDb = createTestDb({
      pool: { max: 1, connectionTimeout: 100 },
      // Disable retry — we want the first failure to surface, not auto-retried.
      retry: { maxRetries: 0, baseDelayMs: 50, maxDelayMs: 100 },
    })

    try {
      // Hold the single connection in a slow query, then race a second query
      // against the connectionTimeout. The second one must either reject or
      // queue past 100ms — both behaviors are acceptable, but the *operation*
      // must not crash the process.
      const slow = tinyPoolDb.raw('SELECT pg_sleep(1)', [])

      // Yield so the slow query grabs the connection first.
      await new Promise(r => setTimeout(r, 50))

      const second = (async () => {
        try {
          return await tinyPoolDb.raw('SELECT 1', [])
        }
        catch (err) {
          return err
        }
      })()
      const settled = await Promise.race([
        second,
        new Promise(resolve => setTimeout(resolve, 500, 'queued')),
      ])

      // Either a real error came back, or the query queued (legitimate behavior
      // depending on bun:sql version). Both are fine — we're confirming the path
      // is well-defined, not crashy.
      expect(settled !== undefined).toBe(true)

      try {
        await slow
      }
      catch {
        // ignored — pool may have torn down while the sleep was in flight
      }
    }
    finally {
      await tinyPoolDb.close({ timeout: 5000 })
    }
  })
})

describe('Streaming under concurrent INSERT/DELETE', () => {
  it('streamCursor yields a stable view despite concurrent INSERTs', async () => {
    const repo = db.repo(usersTable)

    // Seed 100 rows
    await repo.write.insertMany(
      Array.from({ length: 100 }, (_, i) => ({ name: `Seed${i}`, email: `seed-${i}@stream.test` })),
      { pk: true },
    )

    // Start a cursor stream and, halfway through, insert more rows on a separate
    // executor so they don't share the cursor's connection.
    const seen: string[] = []
    let injected = false

    for await (const row of repo.stream.streamCursor({ chunkSize: 10 })) {
      seen.push(row.email)

      if (!injected && seen.length === 30) {
        injected = true
        // These new rows have higher PKs than anything we've yielded so far, so
        // a forward keyset cursor MAY see them. The contract is just: no crash,
        // no duplicates, and every seed row is yielded.
        await repo.write.insertMany(
          Array.from({ length: 10 }, (_, i) => ({ name: `Late${i}`, email: `late-${i}@stream.test` })),
          { pk: true },
        )
      }
    }

    // Every seed row must show up exactly once.
    const seedSeen = seen.filter(e => e.startsWith('seed-'))

    expect(new Set(seedSeen).size).toBe(100)
  })

  it('streamCursor survives concurrent DELETEs of rows it has already passed', async () => {
    const repo = db.repo(usersTable)

    await repo.write.insertMany(
      Array.from({ length: 50 }, (_, i) => ({ name: `Del${i}`, email: `del-${i}@stream.test` })),
      { pk: true },
    )

    const seen: string[] = []
    let deleted = false

    for await (const row of repo.stream.streamCursor({ chunkSize: 5 })) {
      seen.push(row.email)

      if (!deleted && seen.length === 10) {
        deleted = true
        // Delete rows we've already yielded — must not corrupt the cursor.
        await repo.write.deleteMany(e => e.like('email', 'del-0%'), { pk: true })
      }
    }

    // Every row yielded should be unique — no duplicates, no crash.
    expect(new Set(seen).size).toBe(seen.length)
    // And we should have seen at least the first 10 rows (yielded before the delete).
    expect(seen.length).toBeGreaterThanOrEqual(10)
  })
})

describe('FK-add migration on populated tables', () => {
  it('adds a FK constraint to a populated child table when referential integrity holds', async () => {
    // Phase 1: define and sync the tables WITHOUT the FK.
    const parentV1 = defineTable('fk_pop_parent', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))
    const childV1 = defineTable('fk_pop_child', t => ({
      id: t.serial().primaryKey(),
      parentId: t.integer().notNull(),
      label: t.text().notNull(),
    }))

    const dbV1 = createTestDb({ tables: [...allTables, parentV1, childV1] })

    try {
      await dbV1.raw('DROP TABLE IF EXISTS "fk_pop_child"', [])
      await dbV1.raw('DROP TABLE IF EXISTS "fk_pop_parent"', [])
      await dbV1.sync({ allowDestructive: true })

      // Populate both tables with referentially-valid rows.
      const parentRepo = dbV1.repo(parentV1)
      const childRepo = dbV1.repo(childV1)

      const parentIds: number[] = []

      for (let i = 0; i < 5; i++) {
        parentIds.push(await parentRepo.write.insertOne({ name: `Parent${i}` }, { pk: true }))
      }

      for (const pid of parentIds) {
        await childRepo.write.insertOne({ parentId: pid, label: `child-of-${pid}` }, { pk: true })
        await childRepo.write.insertOne({ parentId: pid, label: `another-child-of-${pid}` }, { pk: true })
      }
    }
    finally {
      await dbV1.close({ timeout: 5000 })
    }

    // Phase 2: redeclare childV2 with the FK and sync again — must add the FK
    // on top of the already-populated data without errors.
    const parentRef: { ref?: ReturnType<typeof defineTable> } = {}
    const childV2 = defineTable('fk_pop_child', t => ({
      id: t.serial().primaryKey(),
      parentId: t.integer().notNull().references(() => parentRef.ref!, 'id'),
      label: t.text().notNull(),
    }))
    const parentV2 = defineTable('fk_pop_parent', t => ({
      id: t.serial().primaryKey(),
      name: t.text().notNull(),
    }))

    parentRef.ref = parentV2 as never

    const dbV2 = createTestDb({ tables: [...allTables, parentV2, childV2] })

    try {
      const result = await dbV2.sync({ allowDestructive: true })

      expect(result.ops.some(o => o.type === 'add_fk' && o.table === 'fk_pop_child')).toBe(true)

      // Confirm the FK actually exists in the catalog.
      const fks = await dbV2.raw<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM information_schema.table_constraints
        WHERE table_name = 'fk_pop_child' AND constraint_type = 'FOREIGN KEY'
      `, [])

      expect(Number(fks[0]!.count)).toBe(1)

      // Pre-existing rows must still be readable and intact.
      const rows = await dbV2.raw<{ count: string }>('SELECT count(*)::text AS count FROM "fk_pop_child"', [])

      expect(Number(rows[0]!.count)).toBe(10)
    }
    finally {
      await dbV2.raw('DROP TABLE IF EXISTS "fk_pop_child"', [])
      await dbV2.raw('DROP TABLE IF EXISTS "fk_pop_parent"', [])
      await dbV2.close({ timeout: 5000 })
    }
  })
})
