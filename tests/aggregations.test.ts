import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import {
  createTxRepo,
  runInTransaction,
  setupTestDatabase,
  setupTestSuite,
  teardownTestDatabase,
  teardownTestSuite,
} from './setup'

describe('Aggregations', () => {
  const User = orm
    .entity('aggregation_users', {
      name: orm.string(),
      age: orm.number(),
      role: orm.enum(['admin', 'user'] as const),
      salary: orm.number(),
    })
    .build()

  beforeAll(async () => {
    orm.repo(User)
    await setupTestDatabase()
    setupTestSuite('aggregations')
  })

  afterAll(async () => {
    teardownTestSuite('aggregations')
    await teardownTestDatabase()
  })

  // Helper to create test data
  const createTestData = async (users: ReturnType<typeof createTxRepo<typeof User.schema>>) => {
    await users.createMany([
      { name: 'Alice', age: 25, role: 'admin', salary: 80000 },
      { name: 'Bob', age: 30, role: 'admin', salary: 90000 },
      { name: 'Charlie', age: 22, role: 'user', salary: 60000 },
      { name: 'Diana', age: 28, role: 'user', salary: 70000 },
    ])
  }

  test('sum() should calculate total', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query().sum('age').aggregate()

      expect(result.sum).toBe(105)
    })
  })

  test('avg() should calculate average', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query().avg('age').aggregate()

      expect(result.avg).toBe(26.25)
    })
  })

  test('min() should find minimum', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query().min('age').aggregate()

      expect(result.min).toBe(22)
    })
  })

  test('max() should find maximum', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query().max('age').aggregate()

      expect(result.max).toBe(30)
    })
  })

  test('countAs() should count all records', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query().countAs('total').aggregate()

      expect(result.total).toBe(4)
    })
  })

  test('aggregations should work with WHERE clauses', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query()
        .where('role', '=', 'admin')
        .avg('salary')
        .aggregate()

      expect(result.avg).toBe(85000)
    })
  })

  test('multiple aggregations at once', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query()
        .sum('salary')
        .avg('age')
        .countAs('total')
        .aggregate()

      expect(result.sum).toBe(300000)
      expect(result.avg).toBe(26.25)
      expect(result.total).toBe(4)
    })
  })

  test('GROUP BY with count', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const stats = await users.query()
        .groupBy('role')
        .countAs('total')
        .execute() as any[]

      expect(stats).toHaveLength(2)

      const adminStats = stats.find((s: any) => s.role === 'admin')
      const userStats = stats.find((s: any) => s.role === 'user')

      expect(adminStats.total).toBe(2)
      expect(userStats.total).toBe(2)
    })
  })

  test('GROUP BY with multiple aggregations', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const stats = await users.query()
        .groupBy('role')
        .countAs('count')
        .avg('age')
        .sum('salary')
        .execute() as any[]

      expect(stats).toHaveLength(2)

      const adminStats = stats.find((s: any) => s.role === 'admin')

      expect(adminStats.count).toBe(2)
      expect(adminStats.avg).toBe(27.5)
      expect(adminStats.sum).toBe(170000)

      const userStats = stats.find((s: any) => s.role === 'user')

      expect(userStats.count).toBe(2)
      expect(userStats.avg).toBe(25)
      expect(userStats.sum).toBe(130000)
    })
  })

  test('GROUP BY with WHERE clause', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const stats = await users.query()
        .where('age', '>=', 25)
        .groupBy('role')
        .countAs('count')
        .avg('age')
        .execute() as any[]

      expect(stats.length).toBeGreaterThan(0)

      const adminStats = stats.find((s: any) => s.role === 'admin')

      expect(adminStats.count).toBe(2)
    })
  })

  test('GROUP BY with ORDER BY', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const stats = await users.query()
        .groupBy('role')
        .countAs('count')
        .orderBy('role', 'ASC')
        .execute()

      expect(stats).toHaveLength(2)
      expect((stats[0] as any).role).toBe('admin')
      expect((stats[1] as any).role).toBe('user')
    })
  })

  test('aggregation with custom alias', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query()
        .countAs('user_count')
        .aggregate()

      expect(result.user_count).toBe(4)
    })
  })

  test('min and max on salary field', async () => {
    await runInTransaction(async (tx) => {
      const users = createTxRepo(User, tx)

      await createTestData(users)

      const result = await users.query()
        .min('salary')
        .max('salary')
        .aggregate()

      expect(result.min).toBe(60000)
      expect(result.max).toBe(90000)
    })
  })
})
