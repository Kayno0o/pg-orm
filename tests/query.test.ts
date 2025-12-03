import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { orm } from '../src'
import {
  createTxRepo,
  runInTransaction,
  setupTestDatabase,
  setupTestSuite,
  teardownTestDatabase,
  teardownTestSuite,
  testData,
} from './setup'

const User = orm.entity('test_query_users', {
  name: orm.string(),
  email: orm.string(),
  age: orm.number().nullable(),
  role: orm.enum(['admin', 'user', 'moderator'] as const),
  tags: orm.array('string'),
  metadata: orm.jsonb().nullable(),
}).build()

describe('Query Builder', () => {
  beforeAll(async () => {
    // Register repository before connecting to enable auto-migration
    orm.repo(User)
    await setupTestDatabase()
    setupTestSuite('query')
  })

  afterAll(async () => {
    teardownTestSuite('query')
    await teardownTestDatabase()
  })

  describe('Where Clauses', () => {
    test('should filter with equality', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })

        const results = await users.query()
          .where('name', '=', 'Alice')
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Alice')
      })
    })

    test('should filter with greater than', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 20 })
        await users.create({ ...testData.user.valid(), age: 40 })

        const results = await users.query()
          .where('age', '>', 25)
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.age).toBe(40)
      })
    })

    test('should filter with greater than or equal', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 25 })
        await users.create({ ...testData.user.valid(), age: 30 })
        await users.create({ ...testData.user.valid(), age: 20 })

        const results = await users.query()
          .where('age', '>=', 25)
          .execute()

        expect(results.length).toBe(2)
      })
    })

    test('should filter with less than', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: 18 })
        await users.create({ ...testData.user.valid(), age: 22 })
        await users.create({ ...testData.user.valid(), age: 40 })

        const results = await users.query()
          .where('age', '<', 25)
          .execute()

        expect(results.length).toBe(2)
      })
    })

    test('should filter with IN operator', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'moderator' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const results = await users.query()
          .whereIn('role', ['admin', 'moderator'])
          .execute()

        expect(results.length).toBe(2)
        expect(results.every(u => u.role === 'admin' || u.role === 'moderator')).toBe(true)
      })
    })

    test('should filter with NOT IN operator', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'user' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const results = await users.query()
          .whereNotIn('role', ['admin'])
          .execute()

        expect(results.length).toBe(2)
        expect(results.every(u => u.role === 'user')).toBe(true)
      })
    })

    test('should filter with NULL checks', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), age: null })
        await users.create({ ...testData.user.valid(), age: 25 })

        const nullResults = await users.query()
          .whereNull('age')
          .execute()

        expect(nullResults.length).toBe(1)
        expect(nullResults[0]?.age).toBeNull()

        const notNullResults = await users.query()
          .whereNotNull('age')
          .execute()

        expect(notNullResults.length).toBe(1)
        expect(notNullResults[0]?.age).toBe(25)
      })
    })

    test('should chain multiple where clauses', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin', age: 30 })
        await users.create({ ...testData.user.valid(), role: 'admin', age: 20 })
        await users.create({ ...testData.user.valid(), role: 'user', age: 30 })

        const results = await users.query()
          .where('role', '=', 'admin')
          .where('age', '>=', 25)
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.role).toBe('admin')
        expect(results[0]?.age).toBe(30)
      })
    })
  })

  describe('Order By', () => {
    test('should order by ascending', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Charlie' })
        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })

        const results = await users.query()
          .orderBy('name', 'ASC')
          .execute()

        expect(results[0]?.name).toBe('Alice')
        expect(results[1]?.name).toBe('Bob')
        expect(results[2]?.name).toBe('Charlie')
      })
    })

    test('should order by descending', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), name: 'Charlie' })
        await users.create({ ...testData.user.valid(), name: 'Alice' })
        await users.create({ ...testData.user.valid(), name: 'Bob' })

        const results = await users.query()
          .orderBy('name', 'DESC')
          .execute()

        expect(results[0]?.name).toBe('Charlie')
        expect(results[1]?.name).toBe('Bob')
        expect(results[2]?.name).toBe('Alice')
      })
    })
  })

  describe('Limit and Offset', () => {
    test('should limit results', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 10; i++) {
          await users.create(testData.user.valid())
        }

        const results = await users.query()
          .limit(5)
          .execute()

        expect(results.length).toBe(5)
      })
    })

    test('should offset results', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 10; i++) {
          await users.create({
            ...testData.user.valid(),
            name: `User ${i}`,
          })
        }

        const results = await users.query()
          .orderBy('name', 'ASC')
          .limit(5)
          .offset(5)
          .execute()

        expect(results.length).toBe(5)
        // Should skip first 5
        expect(results[0]?.name).toBe('User 5')
      })
    })
  })

  describe('Helper Methods', () => {
    test('should get latest record', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create(testData.user.valid())

        await new Promise(resolve => setTimeout(resolve, 10))
        const user2 = await users.create(testData.user.valid())

        const latest = await users.query().latest('id')

        expect(latest).not.toBeNull()
        expect(latest?.id).toBe(user2.id)
      })
    })

    test('should get oldest record', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        const user1 = await users.create(testData.user.valid())

        await new Promise(resolve => setTimeout(resolve, 10))
        await users.create(testData.user.valid())

        const oldest = await users.query().oldest('id')

        expect(oldest).not.toBeNull()
        expect(oldest?.id).toBe(user1.id)
      })
    })

    test('should get random records', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 10; i++) {
          await users.create(testData.user.valid())
        }

        const random = await users.query().random(3)

        expect(random.length).toBe(3)
        // All should have different IDs
        const ids = new Set(random.map((u: any) => u.id))

        expect(ids.size).toBe(3)
      })
    })

    test('should count records', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 7; i++) {
          await users.create(testData.user.valid())
        }

        const count = await users.query().count()

        expect(count).toBe(7)
      })
    })

    test('should count with where clause', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'admin' })
        await users.create({ ...testData.user.valid(), role: 'user' })

        const count = await users.query()
          .where('role', '=', 'admin')
          .count()

        expect(count).toBe(2)
      })
    })
  })

  describe('Complex Queries', () => {
    test('should handle complex multi-condition queries', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({
          ...testData.user.valid(),
          name: 'Alice',
          role: 'admin',
          age: 30,
        })
        await users.create({
          ...testData.user.valid(),
          name: 'Bob',
          role: 'admin',
          age: 25,
        })
        await users.create({
          ...testData.user.valid(),
          name: 'Charlie',
          role: 'user',
          age: 35,
        })

        const results = await users.query()
          .where('role', '=', 'admin')
          .where('age', '>=', 28)
          .orderBy('name', 'ASC')
          .limit(10)
          .execute()

        expect(results.length).toBe(1)
        expect(results[0]?.name).toBe('Alice')
      })
    })
  })

  describe('Batch Update', () => {
    test('should update multiple records with where clause', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'user', age: 20 })
        await users.create({ ...testData.user.valid(), role: 'user', age: 25 })
        await users.create({ ...testData.user.valid(), role: 'admin', age: 30 })

        const affected = await users.query()
          .where('role', '=', 'user')
          .update({ role: 'moderator' })

        expect(affected).toBe(2)

        const moderators = await users.query()
          .where('role', '=', 'moderator')
          .execute()

        expect(moderators.length).toBe(2)
        expect(moderators.every(u => u.role === 'moderator')).toBe(true)
      })
    })

    test('should update with multiple conditions', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'user', age: 20 })
        await users.create({ ...testData.user.valid(), role: 'user', age: 30 })
        await users.create({ ...testData.user.valid(), role: 'admin', age: 30 })

        const affected = await users.query()
          .where('role', '=', 'user')
          .where('age', '>=', 25)
          .update({ role: 'moderator' })

        expect(affected).toBe(1)
      })
    })

    test('should throw error when updating with empty data', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        expect(
          users.query().where('role', '=', 'user').update({}),
        ).rejects.toThrow('Update data cannot be empty')
      })
    })

    test('should update multiple fields', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'user', age: 20 })
        await users.create({ ...testData.user.valid(), role: 'user', age: 25 })

        const affected = await users.query()
          .where('role', '=', 'user')
          .update({ role: 'moderator', age: 30 })

        expect(affected).toBe(2)

        const updated = await users.query()
          .where('role', '=', 'moderator')
          .execute()

        expect(updated.length).toBe(2)
        expect(updated.every(u => u.age === 30)).toBe(true)
      })
    })
  })

  describe('Batch Delete', () => {
    test('should delete multiple records with where clause', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'user' })
        await users.create({ ...testData.user.valid(), role: 'user' })
        await users.create({ ...testData.user.valid(), role: 'admin' })

        const deleted = await users.query()
          .where('role', '=', 'user')
          .deleteMany()

        expect(deleted).toBe(2)

        const remaining = await users.query().execute()

        expect(remaining.length).toBe(1)
        expect(remaining[0]?.role).toBe('admin')
      })
    })

    test('should delete with multiple conditions', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        await users.create({ ...testData.user.valid(), role: 'user', age: 20 })
        await users.create({ ...testData.user.valid(), role: 'user', age: 30 })
        await users.create({ ...testData.user.valid(), role: 'admin', age: 30 })

        const deleted = await users.query()
          .where('role', '=', 'user')
          .where('age', '>=', 25)
          .deleteMany()

        expect(deleted).toBe(1)

        const remaining = await users.query().execute()

        expect(remaining.length).toBe(2)
      })
    })

    test('should throw error when deleting without where clause', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        expect(
          users.query().deleteMany(),
        ).rejects.toThrow('DELETE without WHERE clause is not allowed')
      })
    })
  })

  describe('Pagination', () => {
    test('should paginate results', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 25; i++) {
          await users.create({
            ...testData.user.valid(),
            name: `User ${i}`,
          })
        }

        const page1 = await users.query()
          .orderBy('name', 'ASC')
          .paginate({ page: 1, limit: 10 })

        expect(page1.data.length).toBe(10)
        expect(page1.meta.total).toBe(25)
        expect(page1.meta.page).toBe(1)
        expect(page1.meta.pageSize).toBe(10)
        expect(page1.meta.totalPages).toBe(3)
        expect(page1.data[0]?.name).toBe('User 0')
      })
    })

    test('should paginate second page', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 25; i++) {
          await users.create({
            ...testData.user.valid(),
            name: `User ${i.toString().padStart(2, '0')}`,
          })
        }

        const page2 = await users.query()
          .orderBy('name', 'ASC')
          .paginate({ page: 2, limit: 10 })

        expect(page2.data.length).toBe(10)
        expect(page2.meta.page).toBe(2)
        expect(page2.data[0]?.name).toBe('User 10')
      })
    })

    test('should paginate last page with fewer items', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 25; i++) {
          await users.create(testData.user.valid())
        }

        const page3 = await users.query()
          .paginate({ page: 3, limit: 10 })

        expect(page3.data.length).toBe(5)
        expect(page3.meta.page).toBe(3)
        expect(page3.meta.totalPages).toBe(3)
      })
    })

    test('should paginate with where clause', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        for (let i = 0; i < 30; i++) {
          await users.create({
            ...testData.user.valid(),
            role: i < 15 ? 'admin' : 'user',
          })
        }

        const result = await users.query()
          .where('role', '=', 'admin')
          .paginate({ page: 1, limit: 10 })

        expect(result.data.length).toBe(10)
        expect(result.meta.total).toBe(15)
        expect(result.meta.totalPages).toBe(2)
        expect(result.data.every(u => u.role === 'admin')).toBe(true)
      })
    })

    test('should throw error for invalid page number', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        expect(
          users.query().paginate({ page: 0, limit: 10 }),
        ).rejects.toThrow('Invalid page number')

        expect(
          users.query().paginate({ page: -1, limit: 10 }),
        ).rejects.toThrow('Invalid page number')
      })
    })

    test('should throw error for invalid page size', async () => {
      await runInTransaction(async (tx) => {
        const users = createTxRepo(User, tx)

        expect(
          users.query().paginate({ page: 1, limit: 0 }),
        ).rejects.toThrow('Invalid page size')

        expect(
          users.query().paginate({ page: 1, limit: -1 }),
        ).rejects.toThrow('Invalid page size')
      })
    })
  })
})
